/** Scripted process events pin cancellation races without relying on the host scheduler. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const children = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: children.spawn }))
const { runProcess } = await import('../src/process.ts')

afterEach(() => { vi.restoreAllMocks(); children.spawn.mockReset() })

function child(pid?: number) {
  return Object.assign(new EventEmitter(), {
    pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  })
}

it('falls back to the direct child after a failed group kill and retains the first stop reason', async () => {
  const running = child(4321)
  children.spawn.mockReturnValue(running)
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('process group gone') })
  const controller = new AbortController()
  const result = runProcess('test-child', [], { platform: 'linux', maxBytes: 1, signal: controller.signal })
  running.stdout.emit('data', Buffer.from('overflow'))
  running.stderr.emit('data', Buffer.from('another overflow'))
  controller.abort()
  running.emit('close', null)
  await expect(result).rejects.toThrow('Process output limit exceeded')
  expect(kill).toHaveBeenCalledExactlyOnceWith(-4321, 'SIGKILL')
  expect(running.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
})

it('waits for a pid when cancellation precedes spawn, then kills the child on spawn', async () => {
  const running = child()
  children.spawn.mockReturnValue(running)
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const controller = new AbortController()
  const result = runProcess('test-child', [], { platform: 'linux', signal: controller.signal })
  controller.abort()
  expect(kill).not.toHaveBeenCalled()
  running.pid = 4321
  running.emit('spawn')
  expect(kill).toHaveBeenCalledExactlyOnceWith(-4321, 'SIGKILL')
  running.emit('close', null)
  await expect(result).rejects.toThrow('Operation cancelled')
})
