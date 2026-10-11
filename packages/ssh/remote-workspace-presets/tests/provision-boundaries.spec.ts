/** SSH setup rejects malformed coordinates and joins bounded command completion. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Response = { stdout?: string | Buffer; stderr?: string | Buffer; code?: number; hold?: boolean; inputError?: boolean }
const fixture = vi.hoisted(() => ({
  helper: Buffer.from('paired helper'), archiveOversized: false,
  responses: [] as Response[], children: [] as Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }>,
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const { fileURLToPath } = await import('node:url')
  const helper = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ssh/helper'))
  return { ...fs, readFile: async (path: string) => path === helper ? fixture.helper : Buffer.from('archive fixture'), readdir: async () => [] }
})
vi.mock('node:zlib', async (original) => {
  const zlib = await original<typeof import('node:zlib')>()
  return {
    ...zlib, gzipSync: (...args: Parameters<typeof zlib.gzipSync>) =>
      fixture.archiveOversized ? Buffer.alloc(32 * 1024 * 1024 + 1) : zlib.gzipSync(...args),
  }
})
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: () => {
    const response = fixture.responses.shift()
    if (response === undefined) throw new Error('Unexpected SSH command')
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true }),
    })
    fixture.children.push(child)
    child.stdin.resume()
    child.stdin.once('end', () => {
      if (response.inputError) child.stdin.emit('error', new Error('remote input closed'))
      if (response.hold) return
      if (response.stdout !== undefined) child.stdout.end(response.stdout)
      if (response.stderr !== undefined) child.stderr.end(response.stderr)
      child.emit('close', response.code ?? 0)
    })
    return child
  },
}))

import { buildRemoteLspArchive, provisionRemoteWorkspace, sshCommand } from '../src/provision.ts'

const request = { host: 'campus', path: '/srv/project' }
const discovery = JSON.stringify({ node: '/usr/bin/node', major: 24 })
const installed = { helper: '/opt/dsh/helper.mjs', canonicalPath: '/srv/project' }
const lsp = { typescriptLanguageServer: '/opt/lsp/cli.mjs' }

afterEach(() => {
  fixture.helper = Buffer.from('paired helper')
  fixture.archiveOversized = false
  fixture.responses = []
  fixture.children = []
  vi.useRealTimers()
})

describe('SSH provisioning response validation', () => {
  it.each(['broken JSON', 'null', '[]', '42'])('rejects a Node discovery response that is not an object: %s', async (stdout) => {
    fixture.responses.push({ stdout })
    await expect(provisionRemoteWorkspace(request)).rejects.toThrow(/invalid JSON|invalid coordinates/u)
    expect(fixture.children).toHaveLength(1)
  })

  it.each([null, 'node', '/node\nother'])('rejects an invalid discovered executable: %j', async (node) => {
    fixture.responses.push({ stdout: JSON.stringify({ node, major: 24 }) })
    await expect(provisionRemoteWorkspace(request)).rejects.toThrow('Remote Node executable is not an absolute POSIX path')
    expect(fixture.children).toHaveLength(1)
  })

  it.each(['24', 21])('requires a supported numeric Node major: %j', async (major) => {
    fixture.responses.push({ stdout: JSON.stringify({ node: '/usr/bin/node', major }) })
    await expect(provisionRemoteWorkspace(request)).rejects.toThrow('Node.js 22 or newer')
    expect(fixture.children).toHaveLength(1)
  })

  it('returns an installation without an optional ripgrep executable', async () => {
    fixture.responses.push({ stdout: discovery }, { stdout: JSON.stringify(installed) }, { stdout: JSON.stringify(lsp) })
    const result = await provisionRemoteWorkspace(request)
    expect(result).toMatchObject({ ...installed, ...lsp, node: '/usr/bin/node' })
    expect(result).not.toHaveProperty('rg')
  })

  it('refuses an oversized helper before starting SSH', async () => {
    fixture.helper = Buffer.alloc(8 * 1024 * 1024 + 1)
    await expect(provisionRemoteWorkspace(request)).rejects.toThrow('helper exceeds the upload size limit')
    expect(fixture.children).toHaveLength(0)
  })

  it('refuses an oversized compressed language-server archive before uploading it', async () => {
    fixture.archiveOversized = true
    await expect(buildRemoteLspArchive()).rejects.toThrow('LSP exceeds the upload size limit')
    expect(fixture.children).toHaveLength(0)
  })
})

describe('bounded SSH setup commands', () => {
  it('terminates a command that exceeds its output budget and reports the size failure', async () => {
    fixture.responses.push({ stdout: Buffer.alloc(64 * 1024 + 1) })
    await expect(sshCommand('campus', 'output')).rejects.toThrow('too much output')
    expect(fixture.children[0]?.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does not retain an oversized stderr chunk in the returned failure', async () => {
    fixture.responses.push({ stderr: Buffer.alloc(64 * 1024 + 1, 'x'), code: 1 })
    await expect(sshCommand('campus', 'failure')).rejects.toThrow('SSH setup failed (exit 1): ')
  })

  it('contains a closed upload pipe while preserving the remote command result', async () => {
    fixture.responses.push({ stdout: 'done\n', inputError: true })
    await expect(sshCommand('campus', 'upload', Buffer.from('bytes'))).resolves.toBe('done')
  })

  it('reports a timeout even when its terminated process emits a close event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fixture.responses.push({ hold: true })
    const pending = sshCommand('campus', 'stalled', undefined, 100)
    const rejected = expect(pending).rejects.toThrow('timed out after 100 ms')
    await expect.poll(() => fixture.children.length).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(fixture.children[0]?.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
