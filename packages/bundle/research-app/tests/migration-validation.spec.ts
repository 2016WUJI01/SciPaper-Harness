/** Legacy files are untrusted input; rejection must retain their original bytes. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { parse, parseDocument, stringify } from 'yaml'
import { migrateResearchProfile } from '../src/migration.ts'

const version = 'dsh-v0.1.7-rc.2'
const roots = new Set<string>()
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function profile(settings?: string, patch = '[]\n') {
  const home = await mkdtemp(join(tmpdir(), 'research-validation-'))
  roots.add(home)
  const profileDir = join(home, 'profiles', 'test')
  await mkdir(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  await writeFile(patchPath, patch)
  const settingsPath = join(home, 'settings.yaml')
  if (settings !== undefined) await writeFile(settingsPath, settings)
  const journalPath = join(home, `.research-migration-${version}-${createHash('sha256').update(profileDir).digest('hex').slice(0, 16)}.json`)
  return { home, profileDir, patchPath, settingsPath, journalPath }
}

async function customPreset(home: string, id: string, plugins: string, metadata?: string) {
  const directory = join(home, '.agent-presets', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'agent.cordis.yml'), plugins)
  if (metadata !== undefined) await writeFile(join(directory, 'preset.yml'), metadata)
  return directory
}

function property(value: unknown, ...keys: Array<string | number>): unknown {
  for (const key of keys) {
    if (value === null || typeof value !== 'object') throw new Error(`Missing object at ${key}`)
    value = Reflect.get(value, key)
  }
  return value
}

it.each([
  ['malformed YAML', 'llm-deepseek: [\n', /invalid YAML/],
  ['unrecognized YAML tags', 'future: !unsupported value\n', /unsupported YAML tag/],
  ['non-mapping settings', '[]\n', /settings.yaml must be a mapping/],
  ['non-mapping provider', 'llm-deepseek: []\n', /llm-deepseek must be a mapping/],
  ['unknown protocol', 'llm-deepseek: {protocol: future}\n', /unsupported DeepSeek protocol/],
  ['invalid thinking', 'llm-deepseek: {protocol: chat-completions, thinking: invalid}\n', /invalid DeepSeek thinking/],
  ['non-array models', 'llm-deepseek: {protocol: chat-completions, models: wrong}\n', /models must be an array/],
  ['null model', 'llm-deepseek: {protocol: chat-completions, models: [null]}\n', /DeepSeek model must be a mapping/],
  ['scalar model', 'llm-deepseek: {protocol: chat-completions, models: [1]}\n', /DeepSeek model must be a mapping/],
  ['sequence model', 'llm-deepseek: {protocol: chat-completions, models: [[]]}\n', /DeepSeek model must be a mapping/],
  ['missing model id', 'llm-deepseek: {protocol: chat-completions, models: [{}]}\n', /missing model id/],
  ['empty model id', 'llm-deepseek: {protocol: chat-completions, models: [{id: ""}]}\n', /missing model id/],
  ['unknown model fields', 'llm-deepseek: {protocol: chat-completions, models: [{id: custom, future: true}]}\n', /unsupported fields/],
  ['invalid mode selection', 'agent-presets: {modeSelectionEnabled: maybe}\n', /invalid modeSelectionEnabled/],
  ['non-string default', 'agent-presets: {default: 7}\n', /invalid default preset/],
  ['empty default', 'agent-presets: {default: ""}\n', /invalid default preset/],
  ['conflicting defaults', 'agent-presets: {default: old}\nagent-preset-registry: {selectedDefault: new}\n', /conflicting default presets/],
  ['conflicting subagent settings', 'subagent-model-selection: {enabled: true}\nsubagent-model-selection-settings: {enabled: false}\n', /conflicting subagent model settings/],
] as const)('rejects %s without publishing backups or a recovery journal', async (_label, source, error) => {
  const fixture = await profile(source)
  await expect(migrateResearchProfile(fixture)).rejects.toThrow(error)
  expect(await readFile(fixture.settingsPath, 'utf8')).toBe(source)
  expect(await readFile(fixture.patchPath, 'utf8')).toBe('[]\n')
  expect(await readdir(fixture.home)).toEqual(['profiles', 'settings.yaml'])
})

it.each([
  ['mapping patch', '{}\n', /must be a sequence/],
  ['non-map row', '- scalar\n', /patch entry must be a mapping/],
  ['non-sequence insert', '- insert: {}\n', /insert must be a sequence/],
  ['duplicate native entries', '- id: llm-deepseek\n- id: llm-deepseek\n', /duplicate patch entry/],
  ['scalar discovery roots', '- id: agent-presets\n  config: {roots: custom}\n', /custom preset discovery roots/],
  ['non-empty discovery roots', '- id: agent-presets\n  config: {roots: [custom]}\n', /custom preset discovery roots/],
  ['disabled shipped roots', '- id: agent-presets\n  config: {includeShippedRoot: false}\n', /custom preset discovery roots/],
  ['disabled user roots', '- id: agent-presets\n  config: {includeUserRoot: false}\n', /custom preset discovery roots/],
] as const)('rejects %s before changing profile or settings', async (_label, patch, error) => {
  const source = 'agent-presets: {}\n'
  const fixture = await profile(source, patch)
  await expect(migrateResearchProfile(fixture)).rejects.toThrow(error)
  expect(await readFile(fixture.patchPath, 'utf8')).toBe(patch)
  expect(await readFile(fixture.settingsPath, 'utf8')).toBe(source)
})

it('coalesces identical preset selections and subagent aliases without changing their values', async () => {
  const fixture = await profile('agent-presets: {default: custom}\nagent-preset-registry: {selectedDefault: custom}\nsubagent-model-selection: {enabled: true}\nsubagent-model-selection-settings: {enabled: true}\n')
  await migrateResearchProfile(fixture)
  expect(parse(await readFile(fixture.settingsPath, 'utf8'))).toEqual({
    'agent-preset-registry': { selectedDefault: 'custom' },
    'subagent-model-selection-settings': { enabled: true },
  })
})

it.each(['disabled', 'enabled'] as const)('preserves Chat policy fields with thinking %s', async (thinking) => {
  vi.stubEnv('DEEPSEEK_BASE_URL', 'https://environment.invalid')
  const fixture = await profile(stringify({ 'llm-deepseek': {
    protocol: 'chat-completions', thinking, defaultContextWindow: 16384, maxTokens: 1024,
    streamIdleTimeoutMs: 5000, retryPolicy: { maxAttempts: 2 }, maxInlineRequestImageBytes: 128,
    models: [{ id: 'configured', name: 'Configured', contextWindow: 8192, maxTokens: 512 }, { id: 'inherited' }],
  } }))
  await migrateResearchProfile(fixture)
  const route = property(parse(await readFile(fixture.settingsPath, 'utf8')), 'llm-pi-ai', 'providers', 'deepseek-official')
  expect(route).toMatchObject({ baseURL: 'https://environment.invalid', reasoning: thinking === 'disabled' ? 'off' : 'high',
    defaultContextWindow: 16384, streamIdleTimeoutMs: 5000, retryPolicy: { maxAttempts: 2 }, maxRequestImageBytes: 128,
    models: [{ id: 'configured', name: 'Configured', contextWindow: 8192, maxTokens: 512 }, { id: 'inherited', contextWindow: 16384, maxTokens: 1024 }],
  })
  expect(property(route, 'models', 0, 'reasoningEfforts')).toEqual(thinking === 'disabled' ? false : { off: null, low: 'low', high: 'high', max: 'max' })
})

it.each([false, true])('merges repeated Chat patch conversions only when routes match (conflict=%s)', async (conflict) => {
  const patch = stringify([{ insert: [
    { id: 'first', name: '@deepseek-ai/dsh-llm-deepseek', config: { protocol: 'chat-completions' } },
    { id: 'second', name: '@deepseek-ai/dsh-llm-deepseek', config: { protocol: 'chat-completions', ...(conflict ? { baseURL: 'https://conflict.invalid' } : {}) } },
  ] }])
  const fixture = await profile(undefined, patch)
  if (conflict) {
    await expect(migrateResearchProfile(fixture)).rejects.toThrow(/conflicting.*route/)
    expect(await readFile(fixture.patchPath, 'utf8')).toBe(patch)
  } else {
    await migrateResearchProfile(fixture)
    const rows: unknown = parse(await readFile(fixture.patchPath, 'utf8'))
    expect(property(rows, 0, 'insert', 0)).toEqual({ id: 'first', name: '@deepseek-ai/dsh-llm-deepseek-api-key', disabled: true })
    expect(property(rows, 1, 'config', 'providers', 'deepseek-official', 'api')).toBe('openai-completions')
    expect(property(rows, 2)).toEqual({ id: 'llm-deepseek', disabled: true })
    const first = await readFile(fixture.patchPath, 'utf8')
    await migrateResearchProfile(fixture)
    expect(await readFile(fixture.patchPath, 'utf8')).toBe(first)
  }
})

it('retains matching pre-existing Chat routes and unrelated Pi configuration', async () => {
  const fixture = await profile('llm-deepseek: {protocol: chat-completions}\n')
  await migrateResearchProfile(fixture)
  const converted = parse(await readFile(fixture.settingsPath, 'utf8')) as Record<string, unknown>
  converted['llm-deepseek'] = { protocol: 'chat-completions' }
  await writeFile(fixture.settingsPath, stringify(converted))
  await migrateResearchProfile(fixture)
  expect(parse(await readFile(fixture.settingsPath, 'utf8'))).not.toHaveProperty('llm-deepseek')
})

it('replaces supported legacy registry patch rows while preserving unnamed overrides and defaults', async () => {
  const fixture = await profile(undefined, stringify([
    { name: '@deepseek-ai/dsh-agent-presets', config: { roots: [], includeShippedRoot: true, includeUserRoot: true, default: 'custom' } },
    { id: 'agent-presets' },
    { id: 'custom-registry', name: '@deepseek-ai/dsh-agent-presets', config: {} },
  ]))
  await migrateResearchProfile(fixture)
  expect(parse(await readFile(fixture.patchPath, 'utf8'))).toEqual([
    { name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'custom' } },
    { id: 'agent-preset-registry', config: {} },
    { id: 'custom-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: {} },
  ])
})

it('preserves configured catalogs when settings or a legacy patch already supplied them', async () => {
  const fixture = await profile('agent-presets: {}\n', '- id: llm-deepseek\n  config: {models: [{id: custom}]}\n')
  await migrateResearchProfile(fixture)
  expect(property(parse(await readFile(fixture.patchPath, 'utf8')), 0, 'config', 'models')).toEqual([{ id: 'custom' }])
  await writeFile(fixture.patchPath, '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek"\n  config: {}\n')
  await writeFile(fixture.settingsPath, 'llm-deepseek: {protocol: messages, models: [{id: chosen}]}\n')
  await migrateResearchProfile(fixture)
  expect(property(parse(await readFile(fixture.settingsPath, 'utf8')), 'llm-deepseek', 'models')).toEqual([{ id: 'chosen' }])
})

it('handles a home that is also the selected profile and creates missing patch files with backups only for existing files', async () => {
  const fixture = await profile('agent-presets: {default: custom}\n')
  await migrateResearchProfile({ home: fixture.home, profileDir: fixture.home })
  expect(property(parse(await readFile(join(fixture.home, 'cordis.patch.yml'), 'utf8')), 0, 'config', 'models')).toBeInstanceOf(Array)
  expect((await readdir(fixture.home)).filter(file => file.includes('.before-'))).toHaveLength(1)
})

it.each([
  { version: 'unknown', changes: [] },
  { version, changes: {} },
])('refuses an invalid recovery journal without deleting it: %j', async (journal) => {
  const fixture = await profile()
  const bytes = JSON.stringify(journal)
  await writeFile(fixture.journalPath, bytes)
  await expect(migrateResearchProfile(fixture)).rejects.toThrow(/invalid recovery journal/)
  expect(await readFile(fixture.journalPath, 'utf8')).toBe(bytes)
})

it.each(['outside', 'after', 'before'] as const)('rejects invalid recovery %s before touching any target', async (invalid) => {
  const fixture = await profile()
  const change = { path: invalid === 'outside' ? join(fixture.home, 'other-file') : fixture.patchPath,
    before: invalid === 'before' ? 42 : '[]\n', after: invalid === 'after' ? 42 : '- id: restored\n' }
  const bytes = JSON.stringify({ version, changes: [change] })
  await writeFile(fixture.journalPath, bytes)
  await expect(migrateResearchProfile(fixture)).rejects.toThrow(/invalid recovery target/)
  expect(await readFile(fixture.patchPath, 'utf8')).toBe('[]\n')
  expect(await readFile(fixture.journalPath, 'utf8')).toBe(bytes)
})

it('recovers a newly created target without inventing a backup for its absent predecessor', async () => {
  const fixture = await profile()
  await writeFile(fixture.journalPath, JSON.stringify({ version, changes: [{ path: fixture.settingsPath, before: null, after: '{}\n' }] }))
  await migrateResearchProfile(fixture)
  expect(await readFile(fixture.settingsPath, 'utf8')).toBe('{}\n')
  expect((await readdir(fixture.home)).some(file => file.startsWith('settings.yaml.before-'))).toBe(false)
  await expect(readFile(fixture.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps shipped preset folders, ordinary files and incomplete custom folders untouched', async () => {
  const fixture = await profile(undefined, '- insert:\n    - name: "@deepseek-ai/dsh-agent-preset"\n      config: {id: 1}\n')
  const shipped = await customPreset(fixture.home, 'research', 'invalid: [\n')
  const presets = join(fixture.home, '.agent-presets')
  await mkdir(join(presets, 'incomplete'))
  await writeFile(join(presets, 'notes.txt'), 'retain')
  await migrateResearchProfile(fixture)
  expect(await readFile(join(shipped, 'agent.cordis.yml'), 'utf8')).toBe('invalid: [\n')
  expect(await readFile(join(presets, 'notes.txt'), 'utf8')).toBe('retain')
  expect((await readdir(fixture.profileDir)).filter(name => name.includes('.before-'))).toEqual([])
})

it.each(['null', '[]', 'scalar', '{unsupported: true}'])('refuses invalid preset metadata %s without changing its declaration', async (metadata) => {
  const fixture = await profile()
  const directory = await customPreset(fixture.home, 'custom', '[]\n', metadata)
  await expect(migrateResearchProfile(fixture)).rejects.toThrow(/must be a mapping|unsupported fields/)
  expect(await readFile(fixture.patchPath, 'utf8')).toBe('[]\n')
  expect(await readFile(join(directory, 'preset.yml'), 'utf8')).toBe(metadata)
})

it('anchors custom preset imports, converts both provider protocols and preserves literal include destinations', async () => {
  const fixture = await profile()
  const absolute = join(fixture.home, 'absolute')
  const plugins = [
    { name: '@deepseek-ai/dsh-llm-deepseek', config: { protocol: 'messages' } },
    { name: '@deepseek-ai/dsh-llm-deepseek', config: { protocol: 'chat-completions' } },
    { name: '@deepseek-ai/dsh-skill-filesystem', config: {} },
    { name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [absolute, 17, {}, './skills'] } },
    ...[undefined, {}, 17, absolute, 'https://include.invalid/cordis.yml', './included.yml'].map(path => ({ name: 'cordis:include', config: path === undefined ? {} : { path } })),
    { name: '@deepseek-ai/dsh-research-workbench/tools' },
    { name: '@deepseek-ai/dsh-research-workbench/mode-skills' },
  ]
  const source = `${stringify(plugins)}- name: cordis:include\n  config: {path: !!js "new URL('./dynamic.yml', baseUrl).href"}\n`
  const directory = await customPreset(fixture.home, 'custom', source)
  await migrateResearchProfile(fixture)
  const content = parseDocument(await readFile(fixture.patchPath, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }).toJS() as unknown
  const converted = property(content, 0, 'insert', 0, 'config', 'plugins')
  expect(property(converted, 0, 'name')).toBe('@deepseek-ai/dsh-llm-deepseek-api-key')
  expect(property(converted, 1, 'name')).toBe('@deepseek-ai/dsh-llm-pi-ai')
  expect(property(converted, 1, 'config', 'providers', 'deepseek-official', 'api')).toBe('openai-completions')
  expect(property(converted, 3, 'config', 'customSkillDirs')).toEqual([absolute, 17, {}, join(directory, 'skills')])
  expect(property(converted, 4, 'config')).toEqual({})
  expect(property(converted, 5, 'config', 'path')).toEqual({})
  expect(property(converted, 6, 'config', 'path')).toBe(17)
  expect(property(converted, 7, 'config', 'path')).toBe(absolute)
  expect(property(converted, 8, 'config', 'path')).toBe('https://include.invalid/cordis.yml')
  expect(property(converted, 9, 'config', 'path')).toBe(pathToFileURL(join(directory, 'included.yml')).href)
  expect(converted).toHaveLength(plugins.length + 1)
  expect(property(converted, 12, 'config', 'path')).toContain(pathToFileURL(directory + sep).href)
  expect(await readFile(join(directory, 'agent.cordis.yml'), 'utf8')).toBe(source)
})

it('removes the obsolete custom list when it only contains the shipped skill root', async () => {
  const expression = "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-research-workbench/package.json')), 'runtime/skills')"
  const fixture = await profile(undefined, `- id: skill-filesystem\n  config:\n    customSkillDirs: [!!js ${JSON.stringify(expression)}]\n`)
  await migrateResearchProfile(fixture)
  const content = await readFile(fixture.patchPath, 'utf8')
  expect(content).toContain('bundledSkillDir: !!js')
  expect(content).not.toContain('customSkillDirs')
})

it('adds the legacy catalog once when both existing settings and an old provider patch require it', async () => {
  const fixture = await profile('{}\n', '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek"\n')
  await migrateResearchProfile(fixture)
  const migrated = await readFile(fixture.patchPath, 'utf8')
  expect(property(parse(migrated), 0, 'config', 'models')).toHaveLength(4)
  expect(await readFile(fixture.settingsPath, 'utf8')).toBe('{}\n')
  await migrateResearchProfile(fixture)
  expect(await readFile(fixture.patchPath, 'utf8')).toBe(migrated)
  expect((await readdir(fixture.profileDir)).filter(path => path.includes('.before-'))).toHaveLength(1)
})
