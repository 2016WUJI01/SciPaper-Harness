import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, type SessionHeader } from '../src/index.ts'

describe('Session execution identity', () => {
  it('accepts a POSIX SSH cwd on Windows and retains its host through a fork', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('ssh-parent'), {
      meta: { cwd: '/srv/work', execution: { kind: 'ssh', host: 'gpu-a' } },
    })
    expect(session.header).toMatchObject({
      version: SESSION_FORMAT_VERSION, cwd: '/srv/work', execution: { kind: 'ssh', host: 'gpu-a' },
    })
    const child = ctx.sessions.fork(session, undefined, SessionId('ssh-child'))
    expect(child.header).toMatchObject({ cwd: '/srv/work', execution: { kind: 'ssh', host: 'gpu-a' } })
    await ctx.fiber.dispose()
  })

  it('defaults a restored legacy header to local execution before forking', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      const id = SessionId('local-default')
      const restored = Session.fromRestore(id, [], {
        id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false,
      }, SessionLogOffset(0), 'detached')
      expect(restored.header.execution).toEqual({ kind: 'local' })
      ctx.effect(() => ctx.sessions.enter(restored))
      expect(ctx.sessions.fork(restored).header.execution).toEqual({ kind: 'local' })
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    [null, 'execution must be an object'],
    [[], 'execution must be an object'],
    ['local', 'execution must be an object'],
    [{ kind: 'local', host: 'unexpected' }, 'local execution has unexpected fields'],
    [{ kind: 'ssh' }, 'SSH execution requires a host'],
    [{ kind: 'ssh', host: '  ' }, 'SSH execution requires a host'],
    [{ kind: 'ssh', host: 'lab', extra: true }, 'SSH execution requires a host'],
    [{ kind: 'remote' }, 'execution kind must be local or ssh'],
  ])('rejects invalid stored execution metadata %j', (execution, message) => {
    const id = SessionId('invalid-execution')
    const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, execution }
    expect(() => Session.fromRestore(id, [], header as SessionHeader, SessionLogOffset(0), 'detached'))
      .toThrow(message)
  })
})
