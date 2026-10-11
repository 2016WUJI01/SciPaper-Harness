/**
 * ui-jobs plugin halves: the browser entry's dictionary and header-slot
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal — HMR safety), and the inert node entry.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { JobId } from '@deepseek-ai/dsh-jobs/brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { JobView } from '@deepseek-ai/dsh-api-job-controller/client'
import { RemoteError, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { JobListInjected } from '../src/client/JobListAction.tsx'
import { apply as applyNode } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

/** The jobs contribution's concrete face inside the registry's erased record. */
interface JobListEntry extends StoredEntry {
  inject: () => JobListInjected & Record<string, unknown>
}

function jobListFace(ctx: Context): JobListInjected {
  const entry = ctx.slots.entries('conversation.session.header.actions')
    .find(candidate => candidate.options.id === 'job-list') as JobListEntry | undefined
  if (entry?.inject === undefined) throw new Error('job-list entry registered no inject face')
  return entry.inject()
}

/** Slot ledger reader: entry ids currently registered in the header list. */
function headerEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('conversation.session.header.actions')
    .map(entry => entry.options.id)
}

/** Observation requests handed to the stubbed jobs service. */
const observed: [string | undefined, string][] = []
/** Roster watches handed to the stubbed jobs service. */
const watched: string[] = []

/** Job ids the stubbed bound session was asked to kill, and its scripted result. */
const kills: [string, string][] = []
let killResult: { ok: boolean } = { ok: true }

/** Boot the browser half over a real slot tree that declares the header list. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  ctx.provide('jobs', {
    state: { getSnapshot: () => ({ rows: {}, observed: {} }), subscribe: () => () => {} },
    watchRows: (sessionId: string) => {
      watched.push(sessionId)
      return () => {}
    },
    observe: (sessionId: string | undefined, id: string) => {
      observed.push([sessionId, id])
      return () => {}
    },
    kill: async (sessionId: string, jobId: string) => {
      kills.push([sessionId, jobId])
      return killResult
    },
    stopAll: async () => ({ ok: true, value: { confirmed: false, jobs: [], sources: [{ source: 'experiment', confirmed: false, targets: [{ id: 'run-1', status: 'unknown', confirmed: false, error: 'transport failed' }] }], agents: [{ sessionId: 'busy-child', status: 'running', error: 'timeout' }] } }),
  } as never)
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy. There is no jsdom `window` in
  // this lane, so browser-language detection never runs and the locale comes
  // from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('ui-jobs browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['jobs', 'slots', 'locale'])
  })

  it('exposes the jobs source and the roster, observation, and kill controls through the inject face', async () => {
    const { ctx } = await bench()
    const face = jobListFace(ctx)
    expect(face.hooks.jobs).toBeDefined()
    const release = face.watchRows(SessionId('session'))
    expect(watched).toEqual(['session'])
    release()
    const stopper = face.observe(SessionId('session'), JobId('bash-1'))
    expect(observed).toEqual([['session', 'bash-1']])
    stopper()

    // The kill control routes through the job service with the row's session
    // and reports the admission verdict.
    killResult = { ok: true }
    await expect(face.killJob(SessionId('sess-live'), 'bash-3')).resolves.toBe(true)
    killResult = { ok: false }
    await expect(face.killJob(SessionId('sess-live'), 'bash-4')).resolves.toBe(false)
    expect(kills).toEqual([['sess-live', 'bash-3'], ['sess-live', 'bash-4']])
    await expect(face.stopAllJobs(SessionId('sess-live'))).resolves.toEqual({ confirmed: false, failures: ['busy-child: timeout', 'experiment/run-1: transport failed'] })
  })

  it('registers the header action, and fiber teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(headerEntryIds(ctx)).toContain('job-list')
    await fiber.dispose()
    expect(headerEntryIds(ctx)).not.toContain('job-list')
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('list.aria')).toBe(zh['list.aria'])
    ctx.locale.setLocale('en')
    expect(translate('list.aria')).toBe(en['list.aria'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('list.aria')).not.toBe(en['list.aria'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-jobs node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})


it('reports every unconfirmed stop source while leaving verified settled work out of the failure list', async () => {
  const { ctx, fiber } = await bench()
  try {
    const face = jobListFace(ctx)
    const stop = vi.spyOn(ctx.jobs, 'stopAll')
    stop.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    await expect(face.stopAllJobs(SessionId('session'))).resolves.toEqual({ confirmed: false, failures: ['offline'] })
    const job = (id: string, status: JobView['status'], detail?: string): JobView => ({
      id: JobId(id), kind: 'bash', label: id, status, ...(detail === undefined ? {} : { detail }),
      startedAt: 0, output: { total: 0, earliest: 0 },
    })
    stop.mockResolvedValueOnce({ ok: true, value: { confirmed: false,
      jobs: [
        { job: job('error', 'completed'), error: 'observation failed' },
        { job: job('running', 'running') },
        { job: job('stopping', 'stopping') },
        { job: job('orphan', 'killed', 'work may be orphaned') },
        { job: job('settled', 'completed', 'done') },
        { job: job('quiet', 'completed') },
      ],
      agents: [
        { sessionId: SessionId('active'), status: 'running' },
        { sessionId: SessionId('settled'), status: 'idle' },
      ],
      sources: [
        { source: 'failed', confirmed: false, error: 'adapter failed', targets: [] },
        { source: 'empty', confirmed: false, targets: [] },
        { source: 'done', confirmed: true, targets: [] },
        { source: 'targets', confirmed: false, targets: [
          { id: 'active', confirmed: false, status: 'running' },
          { id: 'done', confirmed: true, status: 'stopped' },
          { id: 'failed', confirmed: true, status: 'stopped', error: 'observation failed' },
        ] },
      ],
    } })
    await expect(face.stopAllJobs(SessionId('session'))).resolves.toEqual({ confirmed: false, failures: [
      'error: observation failed', 'running: running', 'stopping: stopping', 'orphan: work may be orphaned',
      'active: running', 'failed: adapter failed', 'empty: stop unconfirmed', 'targets/active: running', 'targets/failed: observation failed',
    ] })
  } finally { await fiber.dispose(); await ctx.fiber.dispose() }
})
