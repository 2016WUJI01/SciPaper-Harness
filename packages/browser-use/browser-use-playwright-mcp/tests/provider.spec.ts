import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-browser-use-runtime/mcp'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

it('uses the pinned Playwright executable with isolated Chromium launch settings', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_CDP_ENDPOINT', 'http://invalid.example:1')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chromium', toolCallTimeoutMs: 123 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'playwright-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 123 })
  expect(options.env?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('')
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect('default' in Provider).toBe(false)
})

it('supports headed launch and attaches without borrowing an existing browser profile', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false, executablePath: '/visible/chromium' }))
  expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--executable-path', '/visible/chromium'])
  Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[1]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--cdp-endpoint', 'http://127.0.0.1:9222'])
})

it('keeps a per-Session profile only when persistentProfile is explicitly selected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-playwright-profile-'))
  roots.push(home)
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Llm)
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Agents)
  await ctx.plugin(AgentLoop, { agents: [] })
  const first = await ctx.agentLoop.create(SessionId('persistent-first'))
  const second = await ctx.agentLoop.create(SessionId('persistent-second'))
  Provider.apply(ctx, Provider.Config({ mode: 'launch', headless: false, persistentProfile: true, executablePath: '/visible/chromium' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--executable-path', '/visible/chromium'])
  const firstArgs = options.argsForAgent!(first)
  expect(firstArgs[0]).toBe('--user-data-dir')
  expect(relative(home, firstArgs[1]!)).toMatch(/^browser-profiles[\\/]playwright-mcp[\\/][a-f0-9]{64}$/u)
  expect(existsSync(firstArgs[1]!)).toBe(true)
  expect(options.argsForAgent!(first)).toEqual(firstArgs)
  expect(options.argsForAgent!(second)).not.toEqual(firstArgs)
  Provider.apply(ctx, Provider.Config({ mode: 'launch' }))
  expect(vi.mocked(mountSessionMcp).mock.calls[1]![1].argsForAgent).toBeUndefined()
})

it.each(['linux', 'win32'] as const)('uses upstream discovery for a headless %s browser without an executable override', (platform) => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { value: platform })
    Provider.apply(new Context(), Provider.Config({ mode: 'launch' }))
    expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless'])
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
})

it('selects an installed Windows browser for a headed launch and preserves discovery when none exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-playwright-windows-'))
  roots.push(root)
  const directory = join(root, 'Microsoft', 'Edge', 'Application')
  await mkdir(directory, { recursive: true })
  const executable = join(directory, 'msedge.exe')
  await writeFile(executable, 'fixture executable')
  vi.stubEnv('ProgramFiles(x86)', root)
  vi.stubEnv('ProgramFiles', '')
  vi.stubEnv('LOCALAPPDATA', '')
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false }))
    expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--executable-path', executable])
    vi.stubEnv('ProgramFiles(x86)', '')
    Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false }))
    expect(vi.mocked(mountSessionMcp).mock.calls[1]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated'])
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
})

it('finds a visible Edge or Chrome binary without reading their existing user profiles', () => {
  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }
  const edge = join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  const chrome = join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
  expect(Provider.headedWindowsBrowser(env, path => path === edge)).toBe(edge)
  expect(Provider.headedWindowsBrowser(env, path => path === chrome)).toBe(chrome)
  expect(Provider.headedWindowsBrowser(env, () => false)).toBeUndefined()
})

it('rejects malformed endpoints before mounting any browser resources', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://localhost:bad/path' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})
