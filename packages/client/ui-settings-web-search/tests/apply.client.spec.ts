/** What the browser half registers, when, which credential it watches, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { SearchCredentialFace } from '../src/client/OptionalSearchBackend.tsx'
import type { WebSearchCardFace } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

/** Optional backend contributions share this concrete credential face. */
interface SearchCredentialEntry extends StoredEntry {
  inject: () => SearchCredentialFace & Record<string, unknown>
}

function credentialFace(entry: StoredEntry | undefined): SearchCredentialFace {
  const credentialEntry = entry as SearchCredentialEntry | undefined
  if (credentialEntry?.inject === undefined) throw new Error('credential entry registered no inject face')
  return credentialEntry.inject()
}

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

/** @param served - namespaces the Host describes; omitted answers a failed read. */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeCredentials = vi.fn(() => Promise.resolve({
    ok: false, error: new RemoteError('gateway/internal', 'no provider', {}),
  }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const remote = new TestRemote(ctx, {
    credentials: { describe: describeCredentials, set: vi.fn() },
    settings: { describe: describeSettings },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeCredentials, describeSettings, remote }
}

/** The Plugins page's item slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-web-search apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.credentials', 'configForms'])
  })

  it('registers the page while the Host serves the namespace, titled in the active locale', async () => {
    const { ctx, slots } = await bench(['web-search-deepseek'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: 'web-search', order: 40 })
    expect(resolveSlotLabel(entry.options.label)).toBe('网页搜索')
    expect(entry.locale).toBe(NS)
    const face = (entry.inject as () => Pick<WebSearchCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['webSearchCard'])
  })

  it('registers nothing while the namespace is not served', async () => {
    const { ctx, slots, describeSettings } = await bench(['shell'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })

  it('re-reads the credential when the Host reports the watched reference changed, and ignores another', async () => {
    const { ctx, slots, describeCredentials, remote } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    remote.emit('credentials/reference-updated', ['SOME_OTHER_KEY'])
    await Promise.resolve()
    expect(describeCredentials).not.toHaveBeenCalled()

    // A key written on another surface changes no settings section, so this
    // event is the only thing that reaches the page.
    remote.emit('credentials/reference-updated', ['DEEPSEEK_API_KEY'])
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('collapses the page on teardown', async () => {
    const { ctx, slots } = await bench(['web-search-deepseek'])
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})


it('wires optional bundle credentials and subscriptions through the shared remote, including unavailable providers', async () => {
  const { ctx, slots, remote } = await bench()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  slots.register({ name: 'root', children: {
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
    'plugins.detail.badge': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const configEntries = slots.entries('plugins.bundle.config')
  expect(configEntries.map(entry => entry.options.key)).toEqual([
    '@deepseek-ai/dsh-web-search-exa-bundle', '@deepseek-ai/dsh-web-search-perplexity-bundle',
  ])
  const face = credentialFace(configEntries[0])
  const badgeFace = credentialFace(slots.entries('plugins.detail.badge')[0])
  expect(badgeFace.readCredential).toBe(face.readCredential)
  const describe = vi.spyOn(ctx.remote.credentials, 'describe')
  describe.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) })
  await expect(face.readCredential('EXA_API_KEY')).resolves.toBeUndefined()
  describe.mockResolvedValueOnce({ ok: true, value: {} })
  await expect(face.readCredential('EXA_API_KEY')).resolves.toEqual({ configured: false, writable: true })
  describe.mockResolvedValueOnce({ ok: true, value: { EXA_API_KEY: { configured: true, writable: false } } })
  await expect(face.readCredential('EXA_API_KEY')).resolves.toEqual({ configured: true, writable: false })
  expect(describe).toHaveBeenLastCalledWith(['EXA_API_KEY'])
  const set = vi.spyOn(ctx.remote.credentials, 'set')
  set.mockResolvedValueOnce({ ok: true, value: undefined })
  await expect(face.writeCredential('EXA_API_KEY', 'fixture-key')).resolves.toBeUndefined()
  expect(set).toHaveBeenCalledWith('EXA_API_KEY', 'fixture-key')
  set.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'read only', {}) })
  await expect(face.writeCredential('EXA_API_KEY', 'fixture-key')).rejects.toThrow('credential write was refused')
  const changed = vi.fn()
  const off = face.onCredentialChanged(changed)
  remote.emit('credentials/reference-updated', ['EXA_API_KEY'])
  expect(changed).toHaveBeenCalledExactlyOnceWith('EXA_API_KEY')
  off()
  remote.emit('credentials/reference-updated', ['EXA_API_KEY'])
  expect(changed).toHaveBeenCalledOnce()
  await fiber.dispose()
  expect(slots.entries('plugins.bundle.config')).toHaveLength(0)
  expect(slots.entries('plugins.detail.badge')).toHaveLength(0)
})
