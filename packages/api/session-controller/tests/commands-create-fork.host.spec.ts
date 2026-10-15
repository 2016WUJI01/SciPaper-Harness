import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionExecutionConflict,
} from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

async function expectFailure(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code })
}

function controllerAgents(overrides: object = {}): ApiSessionAgentController {
  return {
    ensureSession: () => Promise.resolve(),
    composeAgent: () => Promise.resolve({ setup: () => {} }),
    presetForSession: () => undefined,
    presetForObservation: () => undefined,
    ...overrides,
  } as unknown as ApiSessionAgentController
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return ctx
}

describe('Session creation failures', () => {
  it('routes a workspace-backed create to its SSH execution host', async () => {
    const ctx = await baseContext()
    try {
      const workspace = { id: 'remote-workspace' as WorkspaceId, path: '/srv/study', location: { kind: 'ssh', host: 'lab', path: '/srv/study' }, attachSession: vi.fn(async () => {}) }
      ctx.provide('workspaceRegistry', { get: () => workspace, list: () => [workspace] } as never)
      const ensureSession = vi.fn(async (sessionId: SessionId, cwd: string) => {
        const session = ctx.sessions.create(sessionId, { meta: { cwd, execution: { kind: 'ssh', host: 'lab' } } })
        return { id: sessionId, session } as Agent
      })
      const controller = new SessionCommandController(ctx, controllerAgents({ ensureSession }), '/default')
      const created = await controller.create({ workspaceId: workspace.id })
      expect(ensureSession).toHaveBeenCalledWith(created.sessionId, '/srv/study', false, undefined, { kind: 'ssh', host: 'lab' })
      expect(workspace.attachSession).toHaveBeenCalledWith(created.sessionId)
    } finally { await ctx.fiber.dispose() }
  })

  it('surfaces a cold identity read failure before creating an Agent', async () => {
    const ctx = await baseContext()
    try {
      vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('storage unavailable'))
      const ensureSession = vi.fn()
      const controller = new SessionCommandController(ctx, controllerAgents({ ensureSession }), '/default')
      const rejected = controller.create({ sessionId: SessionId('unreadable') })
      await expect(rejected).rejects.toMatchObject({ code: 'gateway/internal' })
      await expect(rejected).rejects.toThrow('storage unavailable')
      expect(ensureSession).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('mints an identity with the default cwd when no explicit target is supplied', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const ensureSession = vi.fn((sessionId: SessionId, cwd: string) => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd } })
      return Promise.resolve({ id: sessionId, session } as Agent)
    })
    const controller = new SessionCommandController(
      ctx,
      controllerAgents({ ensureSession }),
      '/default-workspace',
    )

    const created = await controller.create({})

    expect(created.sessionId).toMatch(/^session-/)
    expect(created).not.toHaveProperty('agentPreset')
    expect(ensureSession).toHaveBeenCalledWith(
      created.sessionId,
      '/default-workspace',
      false,
      undefined,
      { kind: 'local' },
    )
    await ctx.fiber.dispose()
  })

  it('maps missing Workspaces and attachment failures', async () => {
    const missing = await baseContext()
    missing.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const missingController = new SessionCommandController(
      missing,
      controllerAgents(),
      '/default',
    )
    await expectFailure(missingController.create({
      workspaceId: 'missing' as WorkspaceId,
    }), 'workspace/not-found')
    await missing.fiber.dispose()

    const failed = await baseContext()
    const workspace = {
      id: 'workspace-1' as WorkspaceId,
      path: '/workspace',
      attachSession: () => Promise.reject(new Error('read-only workspace')),
    } as unknown as Workspace
    failed.provide('workspaceRegistry', {
      get: () => workspace,
      list: () => [workspace],
    } as never)
    const failedController = new SessionCommandController(
      failed,
      controllerAgents(),
      '/default',
    )
    await expectFailure(failedController.create({
      sessionId: SessionId('workspace-session'),
      workspaceId: workspace.id,
    }), 'session/workspace-attach-failed')
    await failed.fiber.dispose()
  })

  it.each([
    { error: new ApiSessionExecutionConflict(SessionId('remote-conflict')), code: 'session/execution-conflict' },
    {
      error: new RemoteError(
        'agent-preset/invalid',
        'agent-presets: preset "broken" failed to mount: invalid composition',
        { agentPreset: 'broken', reason: 'invalid composition' },
      ),
      code: 'agent-preset/invalid',
    },
    {
      error: new ApiSessionCwdConflict(SessionId('cwd-less'), '/requested', undefined),
      code: 'session/conflict',
    },
    {
      error: new ApiSessionCwdConflict(SessionId('wrong-cwd'), '/requested', '/stored'),
      code: 'session/conflict',
    },
    {
      error: Object.assign(new Error('writer already held'), { name: 'SessionAlreadyOwnedError' }),
      code: 'session/writer-held',
    },
    {
      error: new Error('factory unavailable'),
      code: 'gateway/internal',
    },
  ])('maps $code creation failures', async ({ error, code }) => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const controller = new SessionCommandController(
      ctx,
      controllerAgents({ ensureSession: () => Promise.reject(error) }),
      '/default',
    )

    await expectFailure(controller.create({
      sessionId: SessionId('failed-create'), cwd: '/requested',
    }), code)
    await ctx.fiber.dispose()
  })

  it('rejects contradictory create targets', async () => {
    const ctx = await baseContext()
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.create({
      workspaceId: 'workspace-1' as WorkspaceId,
      cwd: '/workspace',
    }), 'gateway/bad-request')
    await ctx.fiber.dispose()
  })

})

function completedSession(
  ctx: Context,
  id: string,
  cwd?: string,
  lineage: { parentSession?: SessionId; origin?: 'subagent' } = {},
) {
  const session = ctx.sessions.create(SessionId(id), {
    meta: { ...(cwd === undefined ? {} : { cwd }), ...lineage },
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'work' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function resolvedHandle(ctx: Context, sessionId: SessionId): AgentHandle {
  return {
    agent: { id: sessionId, status: 'idle', ctx } as Agent,
    dispose: () => Promise.resolve(),
  }
}

describe('Session fork failures', () => {
  it.each([undefined, ['image'], ['text']])('validates image revisions against default model modalities %j', async (inputModalities) => {
    const ctx = await baseContext()
    try {
      const source = ctx.sessions.create(SessionId('image-revision'))
      const user = source.append('user/message', createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId: AttachmentId('figure'), bytes: 1, width: 1, height: 1, mediaType: 'image/png' } }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      ctx.provide('llm', {
        listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'fixture-model' }],
        resolveCallConfig: async (selection: object) => selection,
        resolveModelInfo: async () => ({ inputModalities }),
      } as never)
      const followup = vi.fn()
      const selectForNextRequest = vi.fn()
      const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
        const session = ctx.sessions.create(options.sessionId, {
          meta: options.meta ?? {}, seed: [...options.seed ?? []],
          ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
        })
        const handle = resolvedHandle(ctx, session.id)
        Object.assign(handle.agent, { session, followup })
        return handle
      })
      const controller = new SessionCommandController(ctx, controllerAgents({ selectForNextRequest }), '/default')
      const operation = controller.fork({ sessionId: source.id, revision: { messageSeq: user.seq } })
      if (inputModalities?.includes('image') === false) {
        await expect(operation).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } })
        expect(create).not.toHaveBeenCalled()
      } else {
        expect((await operation).sessionId).toMatch(/^session-/)
        expect(selectForNextRequest).toHaveBeenCalledWith(expect.anything(), { provider: 'fixture', model: 'fixture-model' })
        expect(followup).toHaveBeenCalledWith(expect.objectContaining({ content: user.data.content }))
      }
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['missing', 'remote'])('refuses a %s destination before creating a fork', async (destination) => {
    const ctx = await baseContext()
    try {
      const source = completedSession(ctx, 'invalid-destination', '/source')
      const workspace = destination === 'missing' ? undefined : { id: 'destination' as WorkspaceId, path: '/srv/study', location: { kind: 'ssh', host: 'lab', path: '/srv/study' } }
      ctx.provide('workspaceRegistry', { get: () => workspace, list: () => [] } as never)
      const create = vi.spyOn(ctx.agents, 'create')
      const controller = new SessionCommandController(ctx, controllerAgents(), '/default')
      const rejected = controller.fork({ sessionId: source.id, workspaceId: 'destination' as WorkspaceId })
      await expect(rejected).rejects.toMatchObject({ code: 'gateway/internal' })
      await expect(rejected).rejects.toThrow('existing local workspaces')
      expect(create).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('revises a historical prompt with the current model and refuses revisions while running or before admission', async () => {
    const ctx = await baseContext()
    try {
      installModelSelectionProjection(ctx)
      const source = completedSession(ctx, 'revise-source', '/workspace')
      source.append('model/selection', { provider: 'custom', model: 'reasoner', reasoningEffort: 'high' })
      const original = source.snapshotEvents()
      const user = original.find(event => event.type === 'user/message')
      if (user === undefined) throw new Error('missing source prompt')
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      ctx.provide('llm', {
        listProviders: () => [{ id: 'custom' }],
        listModels: async () => [{ id: 'reasoner' }],
        resolveCallConfig: async (selection: object) => selection,
      } as never)
      const followup = vi.fn()
      const selectForNextRequest = vi.fn()
      const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
        const session = ctx.sessions.create(options.sessionId, {
          meta: options.meta ?? {}, seed: [...options.seed ?? []],
          ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
        })
        const handle = resolvedHandle(ctx, session.id)
        Object.assign(handle.agent, { session, followup })
        return handle
      })
      const controller = new SessionCommandController(ctx, controllerAgents({ selectForNextRequest }), '/default')
      const revised = await controller.fork({ sessionId: source.id, revision: { messageSeq: user.seq, text: 'Better question' } })
      expect(selectForNextRequest).toHaveBeenCalledWith(expect.objectContaining({ id: revised.sessionId }), { provider: 'custom', model: 'reasoner', reasoningEffort: 'high' })
      expect(followup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: [{ type: 'text', text: 'Better question' }] }))
      expect(source.snapshotEvents()).toEqual(original)
      expect(ctx.sessions.get(revised.sessionId)?.deriveMessages()).toEqual([])
      const current = vi.spyOn(ctx.agents, 'get').mockReturnValue({ status: 'running' } as Agent)
      await expect(controller.fork({ sessionId: source.id, revision: { messageSeq: user.seq } })).rejects.toMatchObject({ code: 'session/agent-busy' })
      current.mockRestore()
      await expect(controller.fork({ sessionId: source.id, atSeq: user.seq, revision: { messageSeq: user.seq } })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      ctx.on('api-session/command-admission', (admission, next) => {
        if (admission.operation === 'prompt') throw new RemoteError('gateway/bad-request', 'Read only', {})
        return next()
      })
      await expect(controller.fork({ sessionId: source.id, revision: { messageSeq: user.seq } })).rejects.toThrow('Read only')
      expect(create).toHaveBeenCalledTimes(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('copies the full requested history into a local destination without changing the source, and admits the destination first', async () => {
    const ctx = await baseContext()
    try {
      const source = completedSession(ctx, 'ordinary', '/ordinary')
      source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Keep this last input too' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const events = source.snapshotEvents()
      const workspace = { id: 'destination' as WorkspaceId, path: '/project', location: { kind: 'local' as const, path: '/project' }, attachSession: vi.fn(async () => {}) }
      ctx.provide('workspaceRegistry', { get: () => workspace, list: () => [workspace] } as never)
      const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
        ctx.sessions.create(options.sessionId, { meta: options.meta ?? {}, seed: options.seed === undefined ? [] : [...options.seed],
          ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
        })
        return resolvedHandle(ctx, options.sessionId)
      })
      const admitted: string[] = []
      ctx.on('api-session/command-admission', async (admission, next) => { admitted.push(`${admission.operation}:${admission.cwd}`); await next() })
      const controller = new SessionCommandController(ctx, controllerAgents(), '/default')
      const child = await controller.fork({ sessionId: source.id, workspaceId: workspace.id, atSeq: events.at(-1)!.seq })
      expect(admitted).toEqual(['fork:/ordinary', 'create:/project'])
      expect(workspace.attachSession).toHaveBeenCalledWith(child.sessionId)
      const copied = ctx.sessions.get(child.sessionId)!
      expect(copied.header).toMatchObject({ cwd: '/project', parentSession: source.id, execution: { kind: 'local' } })
      expect(copied.snapshotEvents().slice(0, events.length)).toEqual(events)
      expect(copied.deriveMessages()).toEqual(source.deriveMessages())
      expect(source.header.cwd).toBe('/ordinary')
      expect(source.snapshotEvents()).toEqual(events)
      create.mockClear()
      ctx.on('api-session/command-admission', async (admission, next) => {
        if (admission.operation === 'create') throw new RemoteError('gateway/bad-request', 'Destination is read-only', {})
        await next()
      })
      await expect(controller.fork({ sessionId: source.id, workspaceId: workspace.id })).rejects.toThrow('Destination is read-only')
      expect(create).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('forks a historical stored header without execution metadata into the local Host', async () => {
    const ctx = await baseContext()
    try {
      const source = completedSession(ctx, 'legacy-source', '/workspace')
      using observed = await ctx.sessionQuery.observeSession(source.id)
      const legacyHeader = { ...observed.header }
      delete legacyHeader.execution
      const legacy = { ...observed, header: legacyHeader, [Symbol.dispose]: () => {} }
      vi.spyOn(ctx.sessionQuery, 'observeSession').mockResolvedValue(legacy)
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async options => resolvedHandle(ctx, options.sessionId))
      const controller = new SessionCommandController(ctx, controllerAgents(), '/default')
      await controller.fork({ sessionId: source.id })
      expect(create.mock.calls[0]?.[0].meta?.execution).toEqual({ kind: 'local' })
    } finally { await ctx.fiber.dispose() }
  })

  it('maps missing cold sources with and without persistence', async () => {
    const withoutPersistence = await baseContext()
    withoutPersistence.provide('workspaceRegistry', { list: () => [] } as never)
    const unavailableController = new SessionCommandController(
      withoutPersistence, controllerAgents(), '/default',
    )
    await expectFailure(unavailableController.fork({
      sessionId: SessionId('missing'),
    }), 'session/not-found')
    await withoutPersistence.fiber.dispose()

    const missing = await baseContext()
    missing.provide('workspaceRegistry', { list: () => [] } as never)
    missing.provide('sessionPersistence', testSessionPersistence(missing, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    }) as never)
    const missingController = new SessionCommandController(missing, controllerAgents(), '/default')
    await expectFailure(missingController.fork({
      sessionId: SessionId('missing'),
    }), 'session/not-found')
    await missing.fiber.dispose()
  })

  it('maps an observation failure to an internal fork error', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('storage offline'))
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.fork({ sessionId: SessionId('unreadable') }), 'gateway/internal')
    await ctx.fiber.dispose()
  })

  it('rejects a Session with no completed turn', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const source = ctx.sessions.create(SessionId('empty-source'))
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.fork({ sessionId: source.id }), 'session/fork-unavailable')
    await expect(controller.fork({ sessionId: source.id, atSeq: 0 })).rejects.toMatchObject({
      code: 'session/fork-unavailable',
      message: 'event 0 does not exist in session "empty-source" (last seq: none)',
    })
    await ctx.fiber.dispose()
  })

  it('maps lineage lookup and Agent creation failures', async () => {
    const lineage = await baseContext()
    lineage.provide('workspaceRegistry', { list: () => [] } as never)
    vi.spyOn(lineage.sessionQuery, 'traceSession')
      .mockRejectedValue(new Error('lineage unavailable'))
    const child = completedSession(lineage, 'subagent-source', '/workspace', {
      parentSession: SessionId('parent'),
      origin: 'subagent',
    })
    const lineageController = new SessionCommandController(lineage, controllerAgents(), '/default')
    await expectFailure(lineageController.fork({ sessionId: child.id }), 'gateway/internal')
    await lineage.fiber.dispose()

    const creation = await baseContext()
    creation.provide('workspaceRegistry', { list: () => [] } as never)
    const source = completedSession(creation, 'creation-source', '/workspace')
    vi.spyOn(creation.agents, 'create').mockRejectedValue(new Error('factory failed'))
    const creationController = new SessionCommandController(creation, controllerAgents(), '/default')
    await expectFailure(creationController.fork({ sessionId: source.id }), 'gateway/internal')
    await creation.fiber.dispose()
  })

  it('omits absent cwd and preset metadata before reporting Workspace attachment failure', async () => {
    const ctx = await baseContext()
    const source = completedSession(ctx, 'workspace-source')
    const workspace = {
      id: 'workspace-1' as WorkspaceId,
      sessionIds: [source.id],
      attachSession: () => Promise.reject(new Error('workspace write failed')),
    } as unknown as Workspace
    ctx.provide('workspaceRegistry', { list: () => [workspace] } as never)
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(
      (options: CreateAgentOptions) => Promise.resolve(resolvedHandle(ctx, options.sessionId)),
    )
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.fork({ sessionId: source.id }), 'session/workspace-attach-failed')
    const options = create.mock.calls[0]?.[0]
    if (options === undefined) throw new Error('Agent creation was not attempted')
    expect(options.meta).not.toHaveProperty('cwd')
    expect(options.meta).not.toHaveProperty('agentPreset')
    await ctx.fiber.dispose()
  })

  it('carries the composed Agent preset into the child metadata', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const source = completedSession(ctx, 'preset-source', '/workspace')
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(
      (options: CreateAgentOptions) => Promise.resolve(resolvedHandle(ctx, options.sessionId)),
    )
    const controller = new SessionCommandController(ctx, controllerAgents({
      composeAgent: () => Promise.resolve({ agentPreset: 'minimal', setup: () => {} }),
    }), '/default')

    const forked = await controller.fork({ sessionId: source.id })
    expect(forked.sessionId).toMatch(/^session-/)
    const options = create.mock.calls[0]?.[0]
    if (options === undefined) throw new Error('Agent creation was not attempted')
    expect(options.meta?.agentPreset).toBe('minimal')
    await ctx.fiber.dispose()
  })
})
