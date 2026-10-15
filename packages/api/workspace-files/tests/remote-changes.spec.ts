/** SSH polling observes provider metadata and terminates with its caller. */
import { setTimeout as delay } from 'node:timers/promises'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceChangeFeed } from '../src/changes.ts'
import { openWorkspace, type Harness } from './harness.ts'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }))

let harness: Harness
const controllers: AbortController[] = []
const closes: Array<() => Promise<unknown>> = []
beforeEach(async () => {
  harness = await openWorkspace('dsh-remote-poll-')
  vi.mocked(delay).mockReset()
})
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  await Promise.all(closes.splice(0).map(close => close()))
  await harness.dispose()
  vi.restoreAllMocks()
})

function open(path: string) {
  const controller = new AbortController()
  controllers.push(controller)
  const feed = new WorkspaceChangeFeed(harness.ctx)
  const stream = feed.follow(harness.ctx.fs, harness.workspace, path, controller.signal, true)[Symbol.asyncIterator]()
  closes.push(async () => stream.return?.())
  return { controller, stream }
}

function tick() {
  const entered = Promise.withResolvers<undefined>()
  const settled = Promise.withResolvers<undefined>()
  vi.mocked(delay).mockImplementationOnce(async (_milliseconds, _value, options) => {
    entered.resolve(undefined)
    const abort = () => { settled.reject(options?.signal?.reason) }
    options?.signal?.addEventListener('abort', abort, { once: true })
    try { await settled.promise } finally { options?.signal?.removeEventListener('abort', abort) }
  })
  return { entered: entered.promise, resolve: () => { settled.resolve(undefined) }, reject: (error: Error) => { settled.reject(error) } }
}

describe('SSH changes polling', () => {
  it('ignores unchanged metadata, then reports disappearance and a recreated file', async () => {
    const path = join(harness.workspace, 'watched.txt')
    await writeFile(path, 'first')
    const { stream } = open(path)
    await expect(stream.next()).resolves.toMatchObject({ value: { kind: 'ready' } })
    const unchanged = tick()
    const missing = tick()
    const observed = vi.fn()
    const next = stream.next().then((frame) => { observed(); return frame })
    await unchanged.entered
    unchanged.resolve()
    await missing.entered
    expect(observed).not.toHaveBeenCalled()
    await rm(path)
    missing.resolve()
    await expect(next).resolves.toMatchObject({ value: { kind: 'change', change: { absent: true } } })
    const recreated = tick()
    const following = stream.next()
    await recreated.entered
    await writeFile(path, 'recreated and longer')
    const info = await harness.ctx.fs.stat(await harness.ctx.fs.resolve(path))
    recreated.resolve()
    await expect(following).resolves.toMatchObject({ value: { kind: 'change', change: { version: info!.version } } })
  })

  it('rejects directories outside the workspace before announcing readiness', async () => {
    const { stream } = open(harness.outside)
    await expect(stream.next()).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    expect(delay).not.toHaveBeenCalled()
  })

  it('accepts the workspace directory and ends an in-flight delay on cancellation', async () => {
    const { stream, controller } = open(harness.workspace)
    await expect(stream.next()).resolves.toMatchObject({ value: { kind: 'ready' } })
    const waiting = tick()
    const next = stream.next()
    await waiting.entered
    controller.abort(new Error('caller left'))
    await expect(next).resolves.toEqual({ done: true, value: undefined })
  })

  it('does not read metadata after cancellation races a resolved delay', async () => {
    const { stream, controller } = open(harness.workspace)
    await stream.next()
    const stat = vi.spyOn(harness.ctx.fs, 'stat')
    const waiting = tick()
    const next = stream.next()
    await waiting.entered
    waiting.resolve()
    controller.abort()
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    expect(stat).not.toHaveBeenCalled()
  })

  it('propagates non-cancellation timer failures', async () => {
    const { stream } = open(harness.workspace)
    await stream.next()
    const waiting = tick()
    const failure = expect(stream.next()).rejects.toThrow('timer failed')
    await waiting.entered
    waiting.reject(new Error('timer failed'))
    await failure
  })
})
