/** Filesystem failures and competing writes at the offline example installation boundary. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeResearchExamples, type ExampleRegistration, type ResearchExample } from '../src/examples.ts'
import type { ResearchProject } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const faults = vi.hoisted(() => ({
  operation: '', error: undefined as unknown, race: false,
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const matches = (operation: string, path: unknown): boolean => faults.operation === operation
    && (operation === 'mkdir' ? String(path).replaceAll('\\', '/').endsWith('/research') : operation === 'lstat' ? String(path).replaceAll('\\', '/').endsWith('/notes.md') : String(path).includes('.scipaper-example-'))
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (matches('mkdir', args[0])) throw faults.error
      return actual.mkdir(...args)
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (matches('lstat', args[0])) throw faults.error
      return actual.lstat(...args)
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (faults.race) {
        await actual.writeFile(args[1], 'Competing writer wins', { flag: 'wx' })
        throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
      }
      if (matches('link', args[0])) throw faults.error
      return actual.link(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (matches('rm', args[0])) {
        await actual.rm(...args)
        throw faults.error
      }
      return actual.rm(...args)
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  faults.operation = ''; faults.error = undefined; faults.race = false
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'research-example-errors-'))
  roots.push(root)
  const assets = join(root, 'assets'), home = join(root, 'home')
  const catalog: ResearchExample[] = ['alpha', 'beta'].map(id => ({
    id, title: id, brief: 'Offline research', mode: 'general', route: 'default', files: ['notes.md'],
    evidence: [], artifacts: [{ path: 'notes.md', kind: 'supplement' }], conversation: { question: 'Question', answer: 'Answer' },
  }))
  for (const example of catalog) {
    await mkdir(join(assets, example.id), { recursive: true })
    await writeFile(join(assets, example.id, 'notes.md'), 'Bundled bytes')
  }
  const saveCatalog = () => writeFile(join(assets, 'catalog.json'), JSON.stringify(catalog))
  await saveCatalog()
  const records: ResearchProject[] = []
  const registration: ExampleRegistration = {
    find: path => records.find(project => project.root === path),
    workspace: async () => 'example-workspace' as WorkspaceId,
    put: async (project) => { records.push(project) }, conversation: async () => {},
  }
  return { home, assets, catalog, records, saveCatalog, run: () => initializeResearchExamples(home, assets, registration) }
}

it.each(['mkdir', 'lstat', 'link', 'rm'])('propagates %s failures rather than claiming an installation', async (operation) => {
  for (const error of ['filesystem unavailable', new Error('uncoded failure'), Object.assign(new Error('disk full'), { code: 'ENOSPC' })]) {
    const f = await fixture()
    faults.operation = operation; faults.error = error
    await expect(f.run()).rejects.toBe(error)
    expect(f.records).toEqual([])
    faults.operation = ''
  }
})

it('retains the bytes atomically published by another writer', async () => {
  const f = await fixture()
  faults.race = true
  await f.run()
  expect(f.records).toHaveLength(2)
  expect(await readFile(join(f.home, 'research/examples/v1/alpha/notes.md'), 'utf8')).toBe('Competing writer wins')
})

it('accepts a temporary file removed by another cleanup after publication', async () => {
  const f = await fixture()
  faults.operation = 'rm'; faults.error = Object.assign(new Error('already removed'), { code: 'ENOENT' })
  await f.run()
  expect(f.records).toHaveLength(2)
  expect(await readFile(join(f.home, 'research/examples/v1/alpha/notes.md'), 'utf8')).toBe('Bundled bytes')
})

it('refuses a directory where an example file should be, keeping it untouched', async () => {
  const f = await fixture()
  const target = join(f.home, 'research/examples/v1/alpha/notes.md')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'sentinel'), 'retained')
  await expect(f.run()).rejects.toThrow('not a regular file')
  expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe('retained')
  expect(f.records).toEqual([])
})

it.each(['duplicate', 'unlisted'] as const)('rejects a %s catalog before creating the product home', async (kind) => {
  const f = await fixture()
  if (kind === 'duplicate') f.catalog[1]!.id = 'alpha'
  else f.catalog[0]!.evidence.push({ path: 'unlisted.txt', title: 'Missing' })
  await f.saveCatalog()
  await expect(f.run()).rejects.toThrow(kind === 'duplicate' ? 'Duplicate bundled example identity' : 'unlisted file')
  await expect(readFile(join(f.home, 'research/examples/v1/catalog.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
