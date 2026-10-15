/** Windows installation paths are mapped to owned fixtures while real file bytes are preserved. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import { prepareManagedPython } from '../src/components.ts'

const mapped = vi.hoisted(() => ({ source: '', destination: '' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (path: string, ...rest: unknown[]) => (actual.readdir as (...args: unknown[]) => ReturnType<typeof actual.readdir>)(
      path === mapped.source ? mapped.destination : path, ...rest),
    copyFile: (source: string, target: string) => actual.copyFile(source.startsWith(mapped.source) && mapped.source
      ? join(mapped.destination, basename(source)) : source, target),
  }
})

const roots: string[] = []
afterEach(async () => {
  mapped.source = ''; mapped.destination = ''
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})

async function fixture(home?: string) {
  const root = await mkdtemp(join(tmpdir(), 'research-managed-python-'))
  roots.push(root)
  const venv = join(root, 'venv'), base = join(root, 'base')
  await mkdir(join(venv, 'Scripts'), { recursive: true })
  await mkdir(base)
  for (const [name, content] of Object.entries({ 'python.exe': 'interpreter', 'pythonw.exe': 'windowless', 'python312.dll': 'runtime', 'README.txt': 'not copied' })) {
    await writeFile(join(base, name), content)
  }
  await writeFile(join(venv, 'Scripts/python.exe'), 'redirector')
  if (home !== undefined) await writeFile(join(venv, 'pyvenv.cfg'), `home = ${home}\r\ninclude-system-site-packages = false\r\n`)
  mapped.source = home === undefined ? '' : win32.toNamespacedPath(home)
  mapped.destination = base
  return { venv }
}

it.each([undefined, '', 'relative/python', 'C:\\Python312', '\\\\server\\share\\python'])('keeps the redirector for an absent or short base: %s', async (home) => {
  const { venv } = await fixture(home)
  await prepareManagedPython(venv, 'win32')
  expect(await readFile(join(venv, 'Scripts/python.exe'), 'utf8')).toBe('redirector')
  expect(await readFile(join(venv, 'Lib/site-packages/00_scipaper_python_paths.pth'), 'utf8')).toBe('import _scipaper_python_paths\n')
})

it.each(['C:\\Python', '\\\\server\\share\\Python', '\\\\?\\C:\\Python'])('copies the executable and DLLs for a deep base: %s', async (prefix) => {
  const home = `${prefix}\\${'deep-directory\\'.repeat(24)}base`
  const { venv } = await fixture(home)
  await prepareManagedPython(venv, 'win32')
  expect(await readFile(join(venv, 'Scripts/python.exe'), 'utf8')).toBe('interpreter')
  expect(await readFile(join(venv, 'Scripts/pythonw.exe'), 'utf8')).toBe('windowless')
  expect(await readFile(join(venv, 'Scripts/python312.dll'), 'utf8')).toBe('runtime')
  await expect(readFile(join(venv, 'Scripts/README.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(venv, 'pyvenv.cfg'), 'utf8'))
    .toBe(`home = ${win32.toNamespacedPath(home)}\r\ninclude-system-site-packages = false\r\n`)
})


it('reuses its existing hook and refuses a different hook without overwriting it', async () => {
  const { venv } = await fixture('C:\\Python312')
  await prepareManagedPython(venv, 'linux')
  await expect(readFile(join(venv, 'Lib/site-packages/00_scipaper_python_paths.pth'))).rejects.toMatchObject({ code: 'ENOENT' })
  await prepareManagedPython(venv, 'win32')
  await prepareManagedPython(venv, 'win32')
  const hook = join(venv, 'Lib/site-packages/00_scipaper_python_paths.pth')
  await writeFile(hook, 'import user_owned_hook\n')
  await expect(prepareManagedPython(venv, 'win32')).rejects.toThrow('bootstrap conflicts')
  expect(await readFile(hook, 'utf8')).toBe('import user_owned_hook\n')
})
