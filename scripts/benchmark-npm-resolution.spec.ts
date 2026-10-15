import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  benchmarkNpmResolution,
  buildRegistryIndex,
  parseBenchmarkOptions,
  publishWorkspaceRange,
  resolveNpmPackageLock,
  runCommandWithTimeout,
  type RegistryIndex,
} from './benchmark-npm-resolution.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeJson(root: string, path: string, value: unknown): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
}

function processCanExecute(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/, 1)[0]
    return !/^[ZXx]$/.test(state ?? '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('npm resolution benchmark', () => {
  it('parses repeat, timeout, threshold, and ref options', () => {
    expect(parseBenchmarkOptions([])).toEqual({ runs: 1, timeoutMs: 300_000 })
    expect(parseBenchmarkOptions([
      '--runs', '3', '--timeout-ms', '45000', '--max-ms', '20000', '--ref', 'master',
    ])).toEqual({ runs: 3, timeoutMs: 45_000, maxMs: 20_000, ref: 'master' })
    expect(parseBenchmarkOptions(['--', '--runs', '2'])).toEqual({ runs: 2, timeoutMs: 300_000 })
    expect(() => parseBenchmarkOptions(['--runs', '0'])).toThrow('--runs must be a positive integer')
  })

  it('projects workspace protocols to published ranges', () => {
    expect(publishWorkspaceRange('workspace:^', '1.2.3')).toBe('^1.2.3')
    expect(publishWorkspaceRange('workspace:~', '1.2.3')).toBe('~1.2.3')
    expect(publishWorkspaceRange('workspace:*', '1.2.3')).toBe('1.2.3')
    expect(publishWorkspaceRange('^4.0.0', '1.2.3')).toBe('^4.0.0')
  })

  it('combines installed metadata with current publishable workspace fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-registry-index-'))
    roots.push(root)
    writeJson(root, 'pnpm-lock.yaml', {})
    writeJson(root, 'node_modules/.pnpm/external@2.0.0/node_modules/external/package.json', {
      name: 'external',
      version: '2.0.0',
      dependencies: { child: '^1.0.0' },
      devDependencies: { ignored: '^1.0.0' },
    })
    writeJson(root, 'apps/cli/package.json', {
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': 'workspace:^', external: '^2.0.0' },
      devDependencies: { ignored: 'workspace:^' },
    })
    writeJson(root, 'packages/core/child/package.json', {
      name: '@deepseek-ai/dsh-child',
      version: '0.1.0',
    })

    const index = buildRegistryIndex(root)

    expect(index.get('external')?.get('2.0.0')).toMatchObject({ dependencies: { child: '^1.0.0' } })
    expect(index.get('@deepseek-ai/dsh')?.get('0.1.0')).toEqual({
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': '^0.1.0', external: '^2.0.0' },
    })
  })

  it('resolves overridden exact dependencies without inventing installed versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-overrides-'))
    roots.push(root)
    writeJson(root, 'pnpm-lock.yaml', {
      overrides: { 'fflate@>=0.8.0 <0.8.3': '0.8.3' },
    })
    writeJson(root, 'node_modules/.pnpm/office@1.0.0/node_modules/office/package.json', {
      name: 'office', version: '1.0.0', dependencies: { fflate: '0.8.2' },
    })
    writeJson(root, 'node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/package.json', {
      name: 'fflate', version: '0.8.3',
    })
    const index = buildRegistryIndex(root)
    expect(index.get('office')?.get('1.0.0')?.dependencies).toEqual({ fflate: '0.8.2' })
    expect([...index.get('fflate')?.keys() ?? []]).toEqual(['0.8.3'])
    expect(index.overrides).toEqual({ 'fflate@>=0.8.0 <0.8.3': '0.8.3' })

    const timeoutMs = process.platform === 'win32' ? 30_000 : 10_000
    const result = await resolveNpmPackageLock(index, { office: '1.0.0' }, timeoutMs)
    expect(result.packageLock.packages['node_modules/fflate']?.version).toBe('0.8.3')
    expect(result.archiveRequests).toBe(0)
    expect(result.unknownPackages).toEqual([])
    await expect(resolveNpmPackageLock(new Map(index), { office: '1.0.0' }, timeoutMs))
      .rejects.toThrow('No matching version found for fflate@0.8.2')
  })

  it('limits parent overrides to matching versions and direct edges', async () => {
    const index: RegistryIndex = Object.assign(new Map([
      ['office', new Map([
        ['1.0.0', { name: 'office', version: '1.0.0', dependencies: { fflate: '0.8.2', bridge: '1.0.0' } }],
        ['2.0.0', { name: 'office', version: '2.0.0', dependencies: { fflate: '0.8.2' } }],
      ])],
      ['bridge', new Map([['1.0.0', { name: 'bridge', version: '1.0.0', dependencies: { fflate: '0.8.2' } }]])],
      ['fflate', new Map([
        ['0.8.3', { name: 'fflate', version: '0.8.3' }],
        ['0.8.4', { name: 'fflate', version: '0.8.4' }],
      ])],
    ]), { overrides: {
      'fflate@>=0.8.0 <0.8.3': '0.8.4',
      'office@>=1 <2>fflate@>=0.8.0 <0.8.3': '0.8.3',
    } })
    const result = await resolveNpmPackageLock(index, {
      office: '1.0.0', next: 'npm:office@2.0.0',
    }, process.platform === 'win32' ? 30_000 : 10_000)

    expect(result.packageLock.packages['node_modules/office']?.dependencies?.fflate).toBe('0.8.3')
    expect(result.packageLock.packages['node_modules/next']?.dependencies?.fflate).toBe('0.8.4')
    expect(result.packageLock.packages['node_modules/bridge']?.dependencies?.fflate).toBe('0.8.4')
    expect(index.get('office')?.get('1.0.0')?.dependencies?.fflate).toBe('0.8.2')
    expect(result.archiveRequests).toBe(0)
  })

  it('applies version overrides to optional and peer edges while preserving unrelated ranges', async () => {
    const index: RegistryIndex = Object.assign(new Map([
      ['adapter', new Map([['1.0.0', {
        name: 'adapter', version: '1.0.0',
        optionalDependencies: { optional: '1.0.0' },
        peerDependencies: { peer: '1.0.0', other: '^2.0.0' },
      }]])],
      ['optional', new Map([['1.0.1', { name: 'optional', version: '1.0.1' }]])],
      ['peer', new Map([['1.0.1', { name: 'peer', version: '1.0.1' }]])],
      ['other', new Map([['2.0.0', { name: 'other', version: '2.0.0' }]])],
    ]), { overrides: { 'optional@1.0.0': '1.0.1', 'peer@1.0.0': '1.0.1', 'other@^1.0.0': '1.0.1' } })
    const result = await resolveNpmPackageLock(index, { adapter: '1.0.0' }, process.platform === 'win32' ? 30_000 : 10_000)
    expect(result.packageLock.packages['node_modules/adapter']).toMatchObject({
      optionalDependencies: { optional: '1.0.1' }, peerDependencies: { peer: '1.0.1', other: '^2.0.0' },
    })
    expect(result.packageLock.packages['node_modules/optional']?.version).toBe('1.0.1')
    expect(result.packageLock.packages['node_modules/peer']?.version).toBe('1.0.1')
    expect(result.packageLock.packages['node_modules/other']?.version).toBe('2.0.0')
    expect(result.archiveRequests).toBe(0)
  })

  it('projects linked workspace overrides to their real published versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-linked-overrides-'))
    roots.push(root)
    writeJson(root, 'pnpm-lock.yaml', { overrides: {
      '@scope/runtime': 'link:vendor/runtime', alias: 'link:vendor/runtime', 'office>child': '2.0.0',
    } })
    writeJson(root, 'vendor/runtime/package.json', { name: '@scope/runtime', version: '3.0.0' })
    const index = buildRegistryIndex(root)
    expect(index.overrides).toEqual({
      '@scope/runtime': '3.0.0', alias: 'npm:@scope/runtime@3.0.0', 'office>child': '2.0.0',
    })
    expect([...index.get('@scope/runtime')?.keys() ?? []]).toEqual(['3.0.0'])
  })

  it.each([
    [null, 'expected a lockfile object'],
    [{ overrides: [] }, 'overrides must be a selector-to-string mapping'],
    [{ overrides: { child: 1 } }, 'override child must be a string'],
    [{ overrides: { child: 'link:vendor/missing' } }, 'links to an unindexed workspace'],
    [{ overrides: { child: '-' } }, 'cannot be represented by the local npm registry'],
  ])('rejects an invalid installed override policy: %j', (lock, error) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-invalid-overrides-'))
    roots.push(root)
    writeJson(root, 'pnpm-lock.yaml', lock)
    expect(() => buildRegistryIndex(root)).toThrow(error)
  })

  it('runs npm against the local registry without requesting an archive', async () => {
    const index: RegistryIndex = new Map([[
      '@deepseek-ai/dsh',
      new Map([['0.1.0', { name: '@deepseek-ai/dsh', version: '0.1.0' }]]),
    ]])
    const result = await benchmarkNpmResolution(index, '0.1.0', process.platform === 'win32' ? 30_000 : 10_000)

    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.registryRequests).toBeGreaterThan(0)
    expect(result.archiveRequests).toBe(0)
    expect(result.unknownPackages).toEqual([])
  })

  it('returns npm placement for two aliased package versions without requesting archives', async () => {
    const index: RegistryIndex = new Map([[
      '@deepseek-ai/dsh',
      new Map([
        ['0.1.0', { name: '@deepseek-ai/dsh', version: '0.1.0' }],
        ['0.2.0', { name: '@deepseek-ai/dsh', version: '0.2.0' }],
      ]),
    ]])

    const result = await resolveNpmPackageLock(index, {
      '@deepseek-ai/dsh': '0.2.0',
      'dsh-previous': 'npm:@deepseek-ai/dsh@0.1.0',
    }, process.platform === 'win32' ? 30_000 : 10_000)

    expect(result.archiveRequests).toBe(0)
    expect(result.packageLock.packages['node_modules/@deepseek-ai/dsh']?.version).toBe('0.2.0')
    expect(result.packageLock.packages['node_modules/dsh-previous']).toMatchObject({
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
    })
  })

  it('isolates peer resolution from inherited npm configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-hostile-npm-config-'))
    roots.push(root)
    const userConfig = join(root, 'user.npmrc')
    writeFileSync(userConfig, '@deepseek-ai:registry=http://127.0.0.1:1/\nlegacy-peer-deps=true\nomit=peer\n')
    const previous = {
      userConfig: process.env.npm_config_userconfig,
      legacyPeerDeps: process.env.npm_config_legacy_peer_deps,
      omit: process.env.npm_config_omit,
    }
    process.env.npm_config_userconfig = userConfig
    process.env.npm_config_legacy_peer_deps = 'true'
    process.env.npm_config_omit = 'peer'
    try {
      const index: RegistryIndex = new Map([
        ['@deepseek-ai/dsh', new Map([['0.1.0', {
          name: '@deepseek-ai/dsh',
          version: '0.1.0',
          peerDependencies: { '@deepseek-ai/dsh-peer': '1.0.0' },
        }]])],
        ['@deepseek-ai/dsh-peer', new Map([['1.0.0', {
          name: '@deepseek-ai/dsh-peer',
          version: '1.0.0',
        }]])],
      ])

      const result = await resolveNpmPackageLock(index, { '@deepseek-ai/dsh': '0.1.0' }, process.platform === 'win32' ? 30_000 : 10_000)

      expect(result.archiveRequests).toBe(0)
      expect(result.packageLock.packages['node_modules/@deepseek-ai/dsh-peer']?.version).toBe('1.0.0')
    } finally {
      if (previous.userConfig === undefined) delete process.env.npm_config_userconfig
      else process.env.npm_config_userconfig = previous.userConfig
      if (previous.legacyPeerDeps === undefined) delete process.env.npm_config_legacy_peer_deps
      else process.env.npm_config_legacy_peer_deps = previous.legacyPeerDeps
      if (previous.omit === undefined) delete process.env.npm_config_omit
      else process.env.npm_config_omit = previous.omit
    }
  })

  it.skipIf(process.platform === 'win32')('force-kills a timed-out process tree', async () => {
    const source = [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGTERM', () => {})",
      'const child = spawn(process.execPath, [\'-e\', "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: \'ignore\' })',
      'console.log(child.pid)',
      'setInterval(() => {}, 1000)',
    ].join(';')
    let descendantPid: number | undefined
    try {
      const result = await runCommandWithTimeout(process.execPath, ['-e', source], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1_000,
        terminationGraceMs: 100,
      })
      const reportedPid = Number.parseInt(result.output.trim(), 10)
      if (!Number.isSafeInteger(reportedPid)) throw new Error(`child reported invalid pid ${result.output.trim()}`)
      descendantPid = reportedPid

      expect(result.timedOut).toBe(true)
      expect(result.signal).toBe('SIGKILL')
      await expect.poll(() => processCanExecute(reportedPid), { timeout: 5_000 }).toBe(false)
    } finally {
      if (descendantPid !== undefined && Number.isSafeInteger(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
  })
})
