/** Provider construction captures configuration but keeps managed credentials current. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef, providerApiKeyOptions } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

describe('providerApiKeyOptions', () => {
  it.each(['configured-key', ''])('keeps literal %j without reading the environment or requiring a provider', (configured) => {
    const readEnvironment = vi.fn(() => 'environment-key')
    const options = providerApiKeyOptions(context(), configured, 'PROVIDER_API_KEY', readEnvironment)
    expect(options).toEqual({ apiKey: configured })
    expect(readEnvironment).not.toHaveBeenCalled()
  })

  it('samples a volatile key once at construction', () => {
    let value = 'first-key'
    const configured = { get: vi.fn(() => value) }
    const readEnvironment = vi.fn(() => 'environment-key')
    const options = providerApiKeyOptions(context(), configured, 'PROVIDER_API_KEY', readEnvironment)
    value = 'later-key'
    expect(options.apiKey).toBe('first-key')
    expect(configured.get).toHaveBeenCalledTimes(1)
    expect(readEnvironment).not.toHaveBeenCalled()
  })

  it('uses the consumer environment only for an absent literal or volatile value', () => {
    const ctx = context()
    const readEnvironment = vi.fn(() => 'environment-key')
    expect(providerApiKeyOptions(ctx, undefined, 'PROVIDER_API_KEY', readEnvironment)).toEqual({ apiKey: 'environment-key' })
    expect(providerApiKeyOptions(ctx, { get: () => undefined }, 'PROVIDER_API_KEY', readEnvironment)).toEqual({ apiKey: 'environment-key' })
    expect(readEnvironment).toHaveBeenCalledTimes(2)
    expect(providerApiKeyOptions(ctx, undefined, 'PROVIDER_API_KEY', () => undefined)).toEqual({ apiKey: '' })
  })

  it('resolves managed keys afresh after rotation and removal without changing the captured fallback', async () => {
    const ctx = context()
    await ctx.plugin(MemoryCredentials, { PROVIDER_API_KEY: 'initial-managed-key' })
    const options = providerApiKeyOptions(ctx, undefined, 'PROVIDER_API_KEY', () => 'environment-key')
    expect(options.apiKey).toBe('environment-key')
    expect(options.resolveApiKey).toBeTypeOf('function')
    await expect(options.resolveApiKey!()).resolves.toBe('initial-managed-key')
    await ctx.credentials.set(credentialRef('PROVIDER_API_KEY'), 'rotated-managed-key')
    await expect(options.resolveApiKey!()).resolves.toBe('rotated-managed-key')
    await ctx.credentials.unset(credentialRef('PROVIDER_API_KEY'))
    await expect(options.resolveApiKey!()).resolves.toBeUndefined()
    expect(options.apiKey).toBe('environment-key')
  })

  it('preserves managed reference validation and provider errors until resolution', async () => {
    const ctx = context()
    await ctx.plugin(MemoryCredentials)
    const malformed = providerApiKeyOptions(ctx, '', 'invalid-reference', () => undefined)
    await expect(malformed.resolveApiKey!()).rejects.toThrow('must match')
    const failure = new Error('credential store unavailable')
    vi.spyOn(ctx.credentials, 'resolve').mockRejectedValueOnce(failure)
    const options = providerApiKeyOptions(ctx, '', 'PROVIDER_API_KEY', () => undefined)
    await expect(options.resolveApiKey!()).rejects.toBe(failure)
  })
})
