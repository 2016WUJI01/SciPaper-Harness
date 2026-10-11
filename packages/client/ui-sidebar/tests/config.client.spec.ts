/** Host page configuration and listener disposal. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it } from 'vitest'
import { Config, apply } from '../src/index.ts'

it('serves defaults unchanged and injects an explicit brandAction until unload', async () => {
  const ctx = new Context()
  try {
    apply(ctx)
    const defaults: IndexInjection[] = []
    ctx.emit('webserver/index-inject', defaults)
    expect(defaults).toEqual([])
    const fiber = ctx.plugin({ apply }, Config({ brandAction: 'none' }))
    await fiber.await()
    const active: IndexInjection[] = []
    ctx.emit('webserver/index-inject', active)
    expect(active).toEqual([{ kind: 'global', name: '__DSH_SIDEBAR__', value: { brandAction: 'none' } }])
    await fiber.dispose()
    const after: IndexInjection[] = []
    ctx.emit('webserver/index-inject', after)
    expect(after).toEqual([])
  } finally { await ctx.fiber.dispose() }
})
