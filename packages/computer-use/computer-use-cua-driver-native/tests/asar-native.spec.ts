import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { patchAsarLibraryResolver, preparePackagedCuaImport, unpackedAsarLibraryPath } from '../src/asar-native.ts'

interface InstalledResolver {
  resolveLibPath: (options: { crateName: string; override: string }) => string
}

describe('packaged Cua native library path', () => {
  it('redirects only the app.asar path component to its real unpacked directory', () => {
    expect(unpackedAsarLibraryPath('R:\\resources\\app.asar\\dsh\\cua_driver_sdk.dll'))
      .toBe('R:\\resources\\app.asar.unpacked\\dsh\\cua_driver_sdk.dll')
    expect(unpackedAsarLibraryPath('/opt/app/resources/app.asar/dsh/libcua_driver_sdk.so'))
      .toBe('/opt/app/resources/app.asar.unpacked/dsh/libcua_driver_sdk.so')
    expect(unpackedAsarLibraryPath('C:\\other\\app.asar.unpacked\\driver.dll'))
      .toBe('C:\\other\\app.asar.unpacked\\driver.dll')
  })

  it('patches a shared resolver once and preserves ordinary paths', () => {
    let calls = 0
    const resolver = { resolveLibPath: (path: unknown): string => { calls++; return String(path) } }
    patchAsarLibraryResolver(resolver)
    const first = resolver.resolveLibPath
    patchAsarLibraryResolver(resolver)
    expect(resolver.resolveLibPath).toBe(first)
    expect(resolver.resolveLibPath('R:\\resources\\app.asar\\driver.dll'))
      .toBe('R:\\resources\\app.asar.unpacked\\driver.dll')
    expect(resolver.resolveLibPath('C:\\standalone\\driver.dll'))
      .toBe('C:\\standalone\\driver.dll')
    expect(calls).toBe(2)
  })

  it('patches the installed SDK resolver only for a compiled Electron archive entry', async () => {
    const sdkRequire = createRequire(import.meta.resolve('@trycua/cua-driver'))
    const resolver = sdkRequire('@ubjs/node/typescript/dist/resolve-lib.js') as InstalledResolver
    const original = resolver.resolveLibPath
    const electron = Object.getOwnPropertyDescriptor(process.versions, 'electron')
    const root = await mkdtemp(join(tmpdir(), 'dsh-cua-asar-'))
    const modules = join(root, 'node_modules')
    let linked = false
    try {
      await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), modules, 'junction')
      linked = true
      const archive = join(root, 'app.asar')
      const unpacked = join(root, 'app.asar.unpacked')
      await mkdir(archive)
      await mkdir(unpacked)
      // Keep import.meta intact: only TypeScript is erased before importing the installed-layout entry.
      const source = await readFile(new URL('../src/asar-native.ts', import.meta.url), 'utf8')
      const entry = join(archive, 'asar-native.mjs')
      await writeFile(entry, stripTypeScriptTypes(source))
      const installed = await import(pathToFileURL(entry).href) as typeof import('../src/asar-native.ts')
      const library = join(archive, 'driver.binary')
      const realLibrary = join(unpacked, 'driver.binary')
      await writeFile(library, 'archive entry')
      await writeFile(realLibrary, 'unpacked native library')
      const options = { crateName: 'cua_driver_sdk', override: library }
      expect(resolver.resolveLibPath(options)).toBe(library)

      Reflect.deleteProperty(process.versions, 'electron')
      installed.preparePackagedCuaImport()
      preparePackagedCuaImport(pathToFileURL(entry).href)
      expect(resolver.resolveLibPath).toBe(original)
      Object.defineProperty(process.versions, 'electron', { configurable: true, value: '40.0.0' })
      preparePackagedCuaImport()
      preparePackagedCuaImport(pathToFileURL(join(unpacked, 'asar-native.mjs')).href)
      expect(resolver.resolveLibPath).toBe(original)

      installed.preparePackagedCuaImport()
      expect(resolver.resolveLibPath(options)).toBe(realLibrary)
      resolver.resolveLibPath = original
      preparePackagedCuaImport(pathToFileURL(entry).href)
      const patched = resolver.resolveLibPath
      expect(patched).not.toBe(original)
      expect(resolver.resolveLibPath(options)).toBe(realLibrary)
      expect(await readFile(resolver.resolveLibPath(options), 'utf8')).toBe('unpacked native library')
      installed.preparePackagedCuaImport()
      expect(resolver.resolveLibPath).toBe(patched)
      expect(resolver.resolveLibPath({ ...options, override: realLibrary })).toBe(realLibrary)
      expect(() => resolver.resolveLibPath({ ...options, override: join(archive, 'missing.binary') })).toThrow('does not exist')
    } finally {
      resolver.resolveLibPath = original
      if (electron === undefined) Reflect.deleteProperty(process.versions, 'electron')
      else Object.defineProperty(process.versions, 'electron', electron)
      if (linked) await unlink(modules)
      await rm(root, { recursive: true, force: true })
    }
    expect(resolver.resolveLibPath).toBe(original)
    expect(Object.getOwnPropertyDescriptor(process.versions, 'electron')).toEqual(electron)
  })
})
