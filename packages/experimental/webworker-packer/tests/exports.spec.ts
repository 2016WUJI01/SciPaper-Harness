/** Runtime reachability ignores declaration-only export roots, not runtime requests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { MemoryVfs, WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime'
import { packVfsImage, type PackOptions } from '../src/pack.ts'

const SUBJECT = '@deepseek-ai/dsh-image-export-fixture'

function fixture(test: TestContext, face: unknown, source = 'export const value = 1'): PackOptions {
  const root = mkdtempSync(join(tmpdir(), 'dsh-image-exports-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: SUBJECT,
    type: 'module',
    files: ['lib'],
    exports: {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './contract': face,
    },
  }))
  writeFileSync(join(root, 'lib/index.js'), source)
  writeFileSync(join(root, 'lib/index.d.ts'), 'export declare const value: number')
  writeFileSync(join(root, 'lib/contract.js'), 'export const value = 2')
  return {
    config: `- id: subject\n  name: '${SUBJECT}'\n`,
    profile: 'export-check',
    workspaces: new Map([[SUBJECT, root]]),
    resolveFrom: root,
    entries: [],
  }
}

it.for([
  { types: './lib/index.d.ts' },
  { 'types@>=5.2': './lib/index.d.ts' },
  { browser: { types: './lib/index.d.ts' } },
  [{ types: './lib/index.d.ts' }],
])('packs a declaration-only export without requesting a runtime entry: %j', (face, test) => {
  const result = packVfsImage(fixture(test, face))
  expect(result.missing).toEqual([])
  expect(Object.keys(result.files)).toContain(`node_modules/${SUBJECT}/lib/index.js`)
  expect(Object.keys(result.files)).not.toContain(`node_modules/${SUBJECT}/lib/index.d.ts`)
  expect(Object.keys(result.files)).not.toContain(`node_modules/${SUBJECT}/lib/contract.js`)
})

it.for([
  { types: './lib/index.d.ts', default: './lib/contract.js' },
  [{ types: './lib/index.d.ts' }, './lib/contract.js'],
])('retains the runtime target beside a types condition: %j', (face, test) => {
  const result = packVfsImage(fixture(test, face))
  expect(Object.keys(result.files)).toContain(`node_modules/${SUBJECT}/lib/contract.js`)
})

it('rejects a runtime import of a declaration-only export', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' }, `export { value } from '${SUBJECT}/contract'`)
  expect(() => packVfsImage(options)).toThrow('does not export "./contract"')
})

it('rejects an assembly entry that requests a declaration-only export', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' })
  expect(() => packVfsImage({ ...options, entries: [`${SUBJECT}/contract`] })).toThrow('worker assembly entry')
})

it('rejects a missing runtime target beside a types condition', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts', default: './lib/missing.js' })
  expect(() => packVfsImage(options)).toThrow('cannot resolve')
})

it('preserves SSH process bytes and rejects importing them as a Worker module', (test) => {
  const options = fixture(test, { default: './lib/contract.js' })
  const root = options.resolveFrom
  const helper = "#!/usr/bin/env node\nawait import('node:net');\n"
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-ssh', type: 'module', files: ['lib'],
    exports: { '.': './lib/index.js', './helper': './lib/helper.js', './client': './lib/client.js' },
  }))
  writeFileSync(join(root, 'lib/helper.js'), helper)
  writeFileSync(join(root, 'lib/client.js'), 'export const page = true')
  const input = {
    ...options, config: "- name: '@deepseek-ai/dsh-ssh'\n",
    workspaces: new Map([['@deepseek-ai/dsh-ssh', root]]),
  }
  writeFileSync(join(root, 'lib/index.js'), "export const helper = import.meta.resolve('@deepseek-ai/dsh-ssh/helper')")
  const result = packVfsImage(input)
  expect(new TextDecoder().decode(result.files['node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'])).toBe(helper)
  expect(new TextDecoder().decode(result.files['node_modules/@deepseek-ai/dsh-ssh/lib/client.js']))
    .toContain('export const page = true\n//# sourceURL=')
  expect(result.transform.visited).toBe(1)
  writeFileSync(join(root, 'lib/index.js'), "import '@deepseek-ai/dsh-ssh/helper'")
  expect(() => packVfsImage(input)).toThrow('standalone process asset, not a Worker module')
})

it('packs plugins nested inside an agent preset and its groups', (test) => {
  const options = fixture(test, { default: './lib/contract.js' })
  const config = `- name: cordis:group
  config:
    - id: preset
      config:
        id: research
        plugins:
          - name: cordis:group
            config:
              - name: '${SUBJECT}'
                config: { name: 'A display label' }
`
  const result = packVfsImage({ ...options, config })
  expect(result.roster).toEqual([SUBJECT])
  expect(result.missing).toEqual([])
  expect(Object.keys(result.files)).toContain(`node_modules/${SUBJECT}/lib/index.js`)
})

it('retains and lowers a computed-path module with its runtime dependencies', async (test) => {
  const options = fixture(test, { default: './lib/contract.js' })
  const name = '@deepseek-ai/dsh-tool-web'
  const directory = options.resolveFrom
  mkdirSync(join(directory, 'assets'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name, type: 'module', files: ['lib', 'assets'], exports: { '.': './lib/index.js' },
  }))
  writeFileSync(join(directory, 'assets/html-converter.cjs'),
    "const value = require('./value.cjs'); module.exports = async () => value")
  writeFileSync(join(directory, 'assets/value.cjs'), 'module.exports = 42')
  const root = '/custom-preview'
  const result = packVfsImage({ ...options, root, config: `- name: '${name}'\n`, workspaces: new Map([[name, directory]]) })
  expect(result.missing).toEqual([])
  const vfs = new MemoryVfs()
  for (const [path, bytes] of Object.entries(result.files)) {
    if (!path.endsWith('/')) vfs.seed(`${root}/${path}`, bytes)
  }
  const loader = new WorkerModuleLoader({ vfs, root, staticModules: {} })
  const convert = loader.requireFrom(root)(`${root}/node_modules/${name}/assets/html-converter.cjs`) as () => Promise<number>
  expect(await convert()).toBe(42)
})
