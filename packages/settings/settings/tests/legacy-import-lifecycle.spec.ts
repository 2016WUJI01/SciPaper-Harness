/** Legacy imports preserve source bytes when I/O races with shutdown or another writer. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileLockOptions } from '@deepseek-ai/dsh-atomic-write'
import { configurationFixture } from './configuration-fixture.ts'

const io = vi.hoisted(() => ({
  path: '',
  beforeLock: undefined as (() => Promise<void>) | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
  beforeBackup: undefined as (() => void) | undefined,
  afterBackup: undefined as (() => Promise<void>) | undefined,
  finished: undefined as (() => void) | undefined,
}))

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    async withFileLock<T>(path: string, operation: () => Promise<T>, options?: FileLockOptions): Promise<T> {
      if (path !== io.path) return actual.withFileLock(path, operation, options)
      try {
        await io.beforeLock?.()
        return await actual.withFileLock(path, operation, options)
      } finally { io.finished?.() }
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>): ReturnType<typeof actual.readFile> {
      const data = await actual.readFile(...args)
      if (args[0] === io.path) await io.afterRead?.()
      return data
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>): ReturnType<typeof actual.writeFile> {
      const backup = args[0] === `${io.path}.imported`
      if (backup) io.beforeBackup?.()
      await actual.writeFile(...args)
      if (backup) await io.afterBackup?.()
    },
  }
})

afterEach(() => {
  io.path = ''
  io.beforeLock = undefined
  io.afterRead = undefined
  io.beforeBackup = undefined
  io.afterBackup = undefined
  io.finished = undefined
  vi.restoreAllMocks()
})

async function prepare(content = 'first: {count: 7}\n') {
  const fixture = await configurationFixture({ hmr: false })
  await fixture.ctx.fiber.dispose()
  const path = join(fixture.home, 'settings.yaml')
  writeFileSync(path, content)
  io.path = path
  const finished = Promise.withResolvers<undefined>()
  io.finished = () => { finished.resolve(undefined) }
  return { ...fixture, path, finished: finished.promise }
}

it.each([
  ['broken YAML', 'first: [', 'invalid legacy document'],
  ['non-mapping document', '[1, 2]', 'legacy document must be a mapping'],
  ['non-mapping section', 'first: 3\n', 'section first must be a mapping'],
])('retains %s for repair', async (_name, content, message) => {
  const { start, path, finished } = await prepare(content)
  const ctx = await start()
  await finished
  await vi.waitFor(() => {
    expect(ctx.logger.buffer.flatMap(entry => entry.args.map(String)).join('\n')).toContain(message)
  })
  expect(readFileSync(path, 'utf8')).toBe(content)
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 2 })
})

it('backs up and consumes an empty legacy document', async () => {
  const { start, path, finished } = await prepare('')
  await start()
  await finished
  expect(existsSync(path)).toBe(false)
  expect(readFileSync(`${path}.imported`, 'utf8')).toBe('')
})

it('preserves a competing backup created between probing and exclusive backup creation', async () => {
  const { start, path, finished } = await prepare()
  io.beforeBackup = () => { writeFileSync(`${path}.imported`, 'competing backup', { flag: 'wx' }) }
  const ctx = await start()
  await finished
  await vi.waitFor(() => { expect(ctx.logger.buffer.some(entry => entry.type === 'error')).toBe(true) })
  expect(readFileSync(`${path}.imported`, 'utf8')).toBe('competing backup')
  expect(readFileSync(path, 'utf8')).toBe('first: {count: 7}\n')
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 2 })
})

it.each(['removed', 'disposed'] as const)('does not import a legacy document %s while waiting for its writer lock', async (change) => {
  const { start, path, finished } = await prepare()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  io.beforeLock = () => { entered.resolve(undefined); return release.promise }
  const ctx = await start()
  try {
    await entered.promise
    if (change === 'removed') rmSync(path)
    else await ctx.configEditor.entries().find(entry => entry.options.id === 'settings')!.fiber!.dispose()
  } finally { release.resolve(undefined); await finished }
  expect(existsSync(`${path}.imported`)).toBe(false)
  expect(ctx.configEditor.documentPath).toBeDefined()
})

it.each(['initial-read', 'backup', 'section-update', 'final-read'] as const)('keeps original legacy bytes when Settings unloads after %s', async (stage) => {
  const { start, path, finished } = await prepare()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const pause = () => { entered.resolve(undefined); return release.promise }
  let reads = 0
  io.afterRead = () => {
    reads++
    return stage === 'initial-read' || stage === 'section-update' && reads === 1 || stage === 'final-read' && reads === 2
      ? pause() : Promise.resolve(undefined)
  }
  if (stage === 'backup') io.afterBackup = pause
  const ctx = await start()
  const settings = ctx.configEditor.entries().find(entry => entry.options.id === 'settings')!.fiber!
  try {
    await entered.promise
    if (stage === 'section-update') {
      const update = ctx.settings.update.bind(ctx.settings)
      vi.spyOn(ctx.settings, 'update').mockImplementation(async (...args) => {
        await update(...args)
        await settings.dispose()
      })
    } else await settings.dispose()
  } finally { release.resolve(undefined); await finished }
  expect(readFileSync(path, 'utf8')).toBe('first: {count: 7}\n')
  if (stage === 'initial-read') expect(existsSync(`${path}.imported`)).toBe(false)
  else expect(readFileSync(`${path}.imported`, 'utf8')).toBe('first: {count: 7}\n')
  expect(existsSync(`${path}.lock`)).toBe(false)
})
