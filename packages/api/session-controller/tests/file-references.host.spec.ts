import { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionFileReferences } from '../src/file-references.ts'

describe('SessionFileReferences', () => {
  const contexts: Context[] = []
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  function remoteHarness(root = '/srv/study') {
    const ctx = new Context()
    contexts.push(ctx)
    const remoteFs = {
      resolve: vi.fn(async (path: string) => ({ targetKey: path })),
      lstat: vi.fn(async () => ({ type: 'directory' })),
      contains: vi.fn(() => true),
      listDir: vi.fn(async (): Promise<{ name: string; type: string }[]> => []),
    }
    ctx.provide('agentPresets', { serviceFor: () => remoteFs } as never)
    const adapter = new SessionFileReferences(ctx)
    const agent = Object.assign({} as Agent, { ctx, session: { header: { cwd: root, execution: { kind: 'ssh', host: 'campus' } } } })
    return { remoteFs, list: (query: string, signal = new AbortController().signal) => adapter.list(agent, query, signal) }
  }

  it('rejects malformed queries and excluded remote directories before filesystem access', async () => {
    const { list, remoteFs } = remoteHarness()
    for (const query of ['x'.repeat(4097), 'a\0b', 'a\rb', 'a\nb', 'node_modules/file', '.git/config']) {
      await expect(list(query)).resolves.toEqual([])
    }
    expect(remoteFs.resolve).not.toHaveBeenCalled()
    const relative = remoteHarness('relative/root')
    await expect(relative.list('')).resolves.toEqual([])
    expect(relative.remoteFs.resolve).not.toHaveBeenCalled()
  })

  it('contains disappearing parents and subdirectories while surfacing root failures', async () => {
    const { list, remoteFs } = remoteHarness()
    remoteFs.lstat.mockRejectedValueOnce(new Error('directory disappeared'))
    await expect(list('src/file')).resolves.toEqual([])
    expect(remoteFs.listDir).not.toHaveBeenCalled()
    remoteFs.contains.mockReturnValueOnce(false)
    await expect(list('src/file')).resolves.toEqual([])
    remoteFs.listDir.mockRejectedValueOnce(new Error('subdirectory disappeared'))
    await expect(list('src/file')).resolves.toEqual([])
    remoteFs.listDir.mockRejectedValueOnce(new Error('remote unavailable'))
    await expect(list('')).rejects.toThrow('remote unavailable')
  })

  it('preserves cancellation during parent lookup and directory listing', async () => {
    const { list, remoteFs } = remoteHarness()
    const lookup = new AbortController()
    remoteFs.lstat.mockImplementationOnce(async () => {
      lookup.abort(new Error('cancelled lookup'))
      throw new Error('transport cancelled')
    })
    await expect(list('src/', lookup.signal)).rejects.toThrow('cancelled lookup')
    const listing = new AbortController()
    remoteFs.listDir.mockImplementationOnce(async () => {
      listing.abort(new Error('cancelled listing'))
      throw new Error('transport cancelled')
    })
    await expect(list('', listing.signal)).rejects.toThrow('cancelled listing')
  })

  it('ranks exact, prefix, and substring matches deterministically and caps the result', async () => {
    const { list, remoteFs } = remoteHarness()
    remoteFs.listDir.mockResolvedValueOnce([
      { name: 'later-test', type: 'file' }, { name: 'test-z', type: 'file' },
      { name: 'test', type: 'file' }, { name: 'test-dir', type: 'directory' },
      { name: 'test-a', type: 'file' }, { name: 'test-a', type: 'file' },
      { name: 'unrelated', type: 'file' }, { name: 'test-link', type: 'symlink' },
    ])
    await expect(list('src\\test')).resolves.toEqual([
      { path: 'src/test', kind: 'file' }, { path: 'src/test-dir', kind: 'directory' },
      { path: 'src/test-a', kind: 'file' }, { path: 'src/test-a', kind: 'file' },
      { path: 'src/test-z', kind: 'file' }, { path: 'src/later-test', kind: 'file' },
    ])
    remoteFs.listDir.mockResolvedValueOnce([{ name: '.env', type: 'file' }, { name: 'plain', type: 'file' }])
    await expect(list('.')).resolves.toEqual([{ path: '.env', kind: 'file' }])
    remoteFs.listDir.mockResolvedValueOnce(Array.from({ length: 24 }, (_, index) => ({ name: `file-${String(index).padStart(2, '0')}`, type: 'file' })))
    const capped = await list('file-')
    expect(capped).toHaveLength(20)
    expect(capped.at(-1)).toEqual({ path: 'file-19', kind: 'file' })
  })

  it('delegates the resolved Agent, query, and cancellation signal unchanged', async () => {
    const ctx = new Context()
    const candidates: FileReferenceCandidate[] = [{ path: 'src', kind: 'directory' }]
    const list = vi.fn(() => Promise.resolve(candidates))
    ctx.provide('fileReferences', { list } as never)
    const adapter = new SessionFileReferences(ctx)
    const agent = Object.assign({} as Agent, { id: 'target', session: { header: {} } })
    const signal = new AbortController().signal

    await expect(adapter.list(agent, 'sr', signal)).resolves.toBe(candidates)
    expect(list).toHaveBeenCalledWith(agent, 'sr', signal)
  })

  it('lists SSH candidates only through the isolated remote filesystem', async () => {
    const ctx = new Context()
    const localList = vi.fn(async () => [{ path: 'local-secret.txt', kind: 'file' }])
    const localFs = { listDir: vi.fn(async () => [{ name: 'local-secret.txt', type: 'file' }]) }
    ctx.provide('fileReferences', { list: localList } as never)
    ctx.provide('fs', localFs as never)
    const directories = new Map([
      ['/srv/study', [
        { name: 'src', type: 'directory' }, { name: 'node_modules', type: 'directory' },
        { name: '.env', type: 'file' }, { name: 'README.md', type: 'file' },
      ]],
      ['/srv/study/src', [
        { name: 'test.ts', type: 'file' }, { name: 'temporary.ts', type: 'file' },
        { name: '.secret', type: 'file' },
      ]],
    ])
    const remoteFs = {
      resolve: vi.fn(async (path: string) => ({ targetKey: path })),
      lstat: vi.fn(async (path: string) => ({ type: path.endsWith('/link') ? 'symlink' : 'directory' })),
      contains: vi.fn((parent: { targetKey: string }, child: { targetKey: string }) => {
        const relative = posix.relative(parent.targetKey, child.targetKey)
        return relative === '' || (relative !== '..' && !relative.startsWith('../'))
      }),
      listDir: vi.fn(async (target: { targetKey: string }) => directories.get(target.targetKey) ?? []),
    }
    const serviceFor = vi.fn(() => remoteFs)
    ctx.provide('agentPresets', { serviceFor } as never)
    const adapter = new SessionFileReferences(ctx)
    const agent = Object.assign({} as Agent, { ctx, session: { header: { cwd: '/srv/study', execution: { kind: 'ssh', host: 'campus' } } } })
    const signal = new AbortController().signal

    await expect(adapter.list(agent, '', signal)).resolves.toEqual([
      { path: 'src', kind: 'directory' }, { path: 'README.md', kind: 'file' },
    ])
    await expect(adapter.list(agent, 'src/te', signal)).resolves.toEqual([
      { path: 'src/temporary.ts', kind: 'file' }, { path: 'src/test.ts', kind: 'file' },
    ])
    await expect(adapter.list(agent, '../local', signal)).resolves.toEqual([])
    await expect(adapter.list(agent, 'link/private', signal)).resolves.toEqual([])
    expect(serviceFor).toHaveBeenCalledWith(agent, 'fs')
    expect(remoteFs.listDir).toHaveBeenCalledTimes(2)
    expect(localList).not.toHaveBeenCalled()
    expect(localFs.listDir).not.toHaveBeenCalled()
  })

  it('refuses SSH completion when its isolated filesystem is missing or aliases the Host filesystem', () => {
    const ctx = new Context()
    const localList = vi.fn(async () => [{ path: 'local-secret.txt', kind: 'file' }])
    const localFs = { listDir: vi.fn() }
    ctx.provide('fileReferences', { list: localList } as never)
    ctx.provide('fs', localFs as never)
    const adapter = new SessionFileReferences(ctx)
    const agent = Object.assign({} as Agent, { ctx, session: { header: { cwd: '/srv/study', execution: { kind: 'ssh', host: 'campus' } } } })
    const signal = new AbortController().signal
    expect(() => adapter.list(agent, '', signal)).toThrow('SSH file-reference provider is unavailable')
    ctx.provide('agentPresets', { serviceFor: () => localFs } as never)
    expect(() => adapter.list(agent, '', signal)).toThrow('SSH file-reference provider is unavailable')
    expect(localList).not.toHaveBeenCalled()
    expect(localFs.listDir).not.toHaveBeenCalled()
  })
})
