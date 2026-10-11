import { expect, it, vi } from 'vitest'
import { DesktopRemoteSource } from '../src/client/desktop-remote-source.ts'
import type { DesktopRemotePresentation } from '../src/types.ts'

function fixture() {
  const status = Promise.withResolvers<DesktopRemotePresentation>()
  let listener!: (state: DesktopRemotePresentation) => void
  const unsubscribe = vi.fn()
  const start = vi.fn(async () => {})
  const stop = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  const source = new DesktopRemoteSource({ status: () => status.promise, start, stop, refresh,
    subscribe: (next) => { listener = next; return unsubscribe } })
  return { source, status, start, stop, refresh, unsubscribe, emit: (state: DesktopRemotePresentation) => { listener(state) } }
}

it('keeps the newest event over a late initial status and permits cancellation during preparation', async () => {
  const f = fixture()
  f.emit({ phase: 'preparing' })
  f.status.resolve({ phase: 'idle' })
  await Promise.resolve()
  expect(f.source.store.getSnapshot().presentation.phase).toBe('preparing')
  f.source.run('stop')
  expect(f.stop).toHaveBeenCalledOnce()
  f.source.dispose()
})

it('coalesces refresh, exposes failures, and erases invitation data after disposal', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  f.refresh.mockImplementationOnce(() => pending.promise)
  f.emit({ phase: 'ready', pairingUrl: 'https://example.com/?pair=private' })
  f.source.run('refresh')
  f.source.run('refresh')
  expect(f.refresh).toHaveBeenCalledOnce()
  pending.reject(new Error('unavailable'))
  await vi.waitFor(() => { expect(f.source.store.getSnapshot().failed).toBe(true) })
  f.source.dispose()
  f.emit({ phase: 'ready', pairingUrl: 'https://example.com/?pair=late' })
  f.status.resolve({ phase: 'ready', pairingUrl: 'https://example.com/?pair=late' })
  f.source.run('start')
  await Promise.resolve()
  expect(f.source.store.getSnapshot()).toEqual({ presentation: { phase: 'idle' }, failed: false, refreshing: false })
  expect(f.start).not.toHaveBeenCalled()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('accepts initial status and reports an initial carrier failure only before a newer event', async () => {
  const initial = fixture()
  initial.status.resolve({ phase: 'connecting' })
  await Promise.resolve()
  expect(initial.source.store.getSnapshot().presentation).toEqual({ phase: 'connecting' })
  initial.source.dispose()

  const failed = fixture()
  failed.status.reject(new Error('carrier unavailable'))
  await Promise.resolve()
  expect(failed.source.store.getSnapshot().failed).toBe(true)
  failed.emit({ phase: 'ready' })
  expect(failed.source.store.getSnapshot().failed).toBe(false)
  failed.source.dispose()

  const newer = fixture()
  newer.emit({ phase: 'preparing' })
  newer.status.reject(new Error('stale status failure'))
  await Promise.resolve()
  expect(newer.source.store.getSnapshot()).toEqual({ presentation: { phase: 'preparing' }, failed: false, refreshing: false })
  newer.source.dispose()
})

it('ignores initial-status and action failures after disposal', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<undefined>()
  f.refresh.mockImplementationOnce(() => pending.promise)
  f.source.run('refresh')
  expect(f.source.store.getSnapshot().refreshing).toBe(true)
  f.source.dispose()
  f.status.reject(new Error('late status failure'))
  pending.reject(new Error('late refresh failure'))
  await pending.promise.catch(() => {})
  await Promise.resolve()
  expect(f.source.store.getSnapshot()).toEqual({ presentation: { phase: 'idle' }, failed: false, refreshing: false })
})
