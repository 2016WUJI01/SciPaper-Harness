/** Fault injection is limited to filesystem failures; all successful operations use real files. */
import * as filesystem from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { migrateResearchKnowledge } from '../src/knowledge-migration.ts'
import { migrateResearchProfile } from '../src/migration.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename), readdir: vi.fn(actual.readdir) }
})

let root: string | undefined
afterEach(async () => {
  vi.mocked(filesystem.readFile).mockReset()
  vi.mocked(filesystem.writeFile).mockReset()
  vi.mocked(filesystem.rename).mockReset()
  vi.mocked(filesystem.readdir).mockReset()
  if (root !== undefined) await filesystem.rm(root, { recursive: true, force: true })
  root = undefined
})

async function directory() {
  root = await filesystem.mkdtemp(join(tmpdir(), 'research-migration-io-'))
  return root
}

const research = '@deepseek-ai/dsh-research-app'
const graph = '@deepseek-ai/dsh-research-knowledge-bundle'

it.each([{}, { dsh: {} }, { dsh: { profile: {} } }, { dsh: { profile: { bundles: 'invalid' } } }])('keeps manifests without a research bundle list untouched: %j', async (manifest) => {
  const home = await directory()
  const bytes = JSON.stringify(manifest)
  await filesystem.writeFile(join(home, 'package.json'), bytes)
  await migrateResearchKnowledge(home)
  expect(await filesystem.readFile(join(home, 'package.json'), 'utf8')).toBe(bytes)
  expect(await filesystem.readdir(home)).toEqual(['package.json'])
})

it('marks an already-selected graph bundle without writing or backing up its manifest', async () => {
  const home = await directory()
  const bytes = JSON.stringify({ dsh: { profile: { bundles: [research, graph] } } })
  await filesystem.writeFile(join(home, 'package.json'), bytes)
  await migrateResearchKnowledge(home)
  expect(await filesystem.readFile(join(home, 'package.json'), 'utf8')).toBe(bytes)
  expect(await filesystem.readFile(join(home, 'knowledge-plugin-v1.migrated'), 'utf8')).toBe('1\n')
  expect(await filesystem.readdir(home)).toEqual(['knowledge-plugin-v1.migrated', 'package.json'])
})

it('preserves an earlier exclusive graph backup while completing the remaining migration', async () => {
  const home = await directory()
  const bytes = JSON.stringify({ dsh: { profile: { bundles: [research] } } })
  await filesystem.writeFile(join(home, 'package.json'), bytes)
  await filesystem.writeFile(join(home, 'package.before-knowledge-plugin.json'), 'original backup')
  await migrateResearchKnowledge(home)
  expect(await filesystem.readFile(join(home, 'package.before-knowledge-plugin.json'), 'utf8')).toBe('original backup')
  expect(JSON.parse(await filesystem.readFile(join(home, 'package.json'), 'utf8'))).toEqual({ dsh: { profile: { bundles: [research, graph] } } })
})

it('stops on an unreadable graph marker rather than treating it as a new profile', async () => {
  const home = await directory()
  const failure = Object.assign(new Error('marker denied'), { code: 'EACCES' })
  vi.mocked(filesystem.readFile).mockRejectedValueOnce(failure)
  await expect(migrateResearchKnowledge(home)).rejects.toBe(failure)
  expect(await filesystem.readdir(home)).toEqual([])
})

it('does not replace the manifest when its exclusive graph backup cannot be written', async () => {
  const home = await directory()
  const bytes = JSON.stringify({ dsh: { profile: { bundles: [research] } } })
  await filesystem.writeFile(join(home, 'package.json'), bytes)
  const failure = Object.assign(new Error('backup denied'), { code: 'EACCES' })
  vi.mocked(filesystem.writeFile).mockRejectedValueOnce(failure)
  await expect(migrateResearchKnowledge(home)).rejects.toBe(failure)
  expect(await filesystem.readFile(join(home, 'package.json'), 'utf8')).toBe(bytes)
  expect(await filesystem.readdir(home)).toEqual(['package.json'])
})

it('removes an uncommitted graph temporary file after rename failure and safely retries', async () => {
  const home = await directory()
  const bytes = JSON.stringify({ dsh: { profile: { bundles: [research] } } })
  await filesystem.writeFile(join(home, 'package.json'), bytes)
  const failure = Object.assign(new Error('rename denied'), { code: 'EACCES' })
  vi.mocked(filesystem.rename).mockRejectedValueOnce(failure)
  await expect(migrateResearchKnowledge(home)).rejects.toBe(failure)
  expect(await filesystem.readFile(join(home, 'package.json'), 'utf8')).toBe(bytes)
  expect(await filesystem.readdir(home)).toEqual(['package.before-knowledge-plugin.json', 'package.json'])
  await migrateResearchKnowledge(home)
  expect(await filesystem.readFile(join(home, 'package.before-knowledge-plugin.json'), 'utf8')).toBe(bytes)
  expect(JSON.parse(await filesystem.readFile(join(home, 'package.json'), 'utf8'))).toEqual({ dsh: { profile: { bundles: [research, graph] } } })
})

it('propagates recovery read errors before attempting migration writes', async () => {
  const home = await directory()
  const failure = Object.assign(new Error('journal denied'), { code: 'EACCES' })
  vi.mocked(filesystem.readFile).mockRejectedValueOnce(failure)
  await expect(migrateResearchProfile({ home, profileDir: home })).rejects.toBe(failure)
  expect(await filesystem.readdir(home)).toEqual([])
})

it('retains legacy settings when preset discovery fails', async () => {
  const home = await directory()
  const source = 'agent-presets: {default: custom}\n'
  await filesystem.writeFile(join(home, 'settings.yaml'), source)
  const failure = Object.assign(new Error('presets denied'), { code: 'EACCES' })
  vi.mocked(filesystem.readdir).mockRejectedValueOnce(failure)
  await expect(migrateResearchProfile({ home, profileDir: home })).rejects.toBe(failure)
  expect(await filesystem.readFile(join(home, 'settings.yaml'), 'utf8')).toBe(source)
  expect(await filesystem.readdir(home)).toEqual(['settings.yaml'])
})
