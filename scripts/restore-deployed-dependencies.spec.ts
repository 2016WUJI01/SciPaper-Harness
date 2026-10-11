import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { restoreDeployedDependencies } from './restore-deployed-dependencies.ts'

function fixture(test: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-restore-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return { source: join(root, 'source'), deployment: join(root, 'deployment') }
}

function write(directory: string, manifest: object) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }))
}

it('restores a hoisted CLI and its nested research bundle with one shared peer', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*', cordis: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cli'), { dependencies: { research: '*', cordis: '*' } })
  write(join(source, 'node_modules/cli/node_modules/research'), { peerDependencies: { cordis: '*' } })
  write(join(source, 'node_modules/cordis'), {})
  expect(await restoreDeployedDependencies(deployment, source)).toEqual(['cli', 'cordis', 'research'])
  expect(await restoreDeployedDependencies(deployment, source)).toEqual([])
})

it('preserves different transitive versions beside their consumers', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*', parser: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cli'), { dependencies: { parser: '*' } })
  write(join(source, 'node_modules/cli/node_modules/parser'), { version: '2.0.0' })
  write(join(source, 'node_modules/parser'), {})
  expect(await restoreDeployedDependencies(deployment, source)).toEqual([
    'cli', 'parser', join('cli', 'node_modules', 'parser'),
  ])
  expect(JSON.parse(readFileSync(join(deployment, 'node_modules/parser/package.json'), 'utf8'))).toHaveProperty('version', '1.0.0')
  expect(JSON.parse(readFileSync(join(deployment, 'node_modules/cli/node_modules/parser/package.json'), 'utf8'))).toHaveProperty('version', '2.0.0')
})

it('ignores absent optional dependencies and terminates dependency cycles', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*' }, optionalDependencies: { native: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cli'), {
    dependencies: { cli: '*' }, peerDependencies: { optional: '*' }, peerDependenciesMeta: { optional: { optional: true } },
  })
  expect(await restoreDeployedDependencies(deployment, source)).toEqual(['cli'])
})

it('rejects a missing required transitive dependency', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cli'), { dependencies: { missing: '*' } })
  await expect(restoreDeployedDependencies(deployment, source)).rejects.toThrow('required dependency missing is missing')
})

it('rejects a conflicting deployed package without merging or deleting its files', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cli'), { version: '2.0.0' })
  write(join(deployment, 'node_modules/cli'), {})
  writeFileSync(join(deployment, 'node_modules/cli/retained.txt'), 'original')
  await expect(restoreDeployedDependencies(deployment, source)).rejects.toThrow('conflicts with installed source version 2.0.0')
  expect(readFileSync(join(deployment, 'node_modules/cli/retained.txt'), 'utf8')).toBe('original')
})

it('materializes a deployed package link before restoring its dependency graph', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cli'), { dependencies: { research: '*' } })
  write(join(source, 'node_modules/cli/node_modules/research'), {})
  mkdirSync(join(deployment, 'node_modules'))
  symlinkSync(join(source, 'node_modules/cli'), join(deployment, 'node_modules/cli'), 'junction')
  expect(await restoreDeployedDependencies(deployment, source)).toEqual(['research'])
  expect(lstatSync(join(deployment, 'node_modules/cli')).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(source, 'node_modules/cli/node_modules/research/package.json'), 'utf8')).toContain('1.0.0')
})

it('keeps distinct installed sources with the same version and different closures separate', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { first: '*', second: '*' } })
  write(deployment, {})
  for (const [consumer, version] of [['first', '1.0.0'], ['second', '2.0.0']]) {
    const directory = join(source, 'node_modules', consumer!)
    write(directory, { dependencies: { library: '*' } })
    write(join(directory, 'node_modules/library'), { peerDependencies: { parser: '*' } })
    write(join(directory, 'node_modules/library/node_modules/parser'), { version })
  }
  const restored = await restoreDeployedDependencies(deployment, source)
  expect(restored).toContain(join('second', 'node_modules', 'library'))
  expect(JSON.parse(readFileSync(join(deployment, 'node_modules/parser/package.json'), 'utf8'))).toHaveProperty('version', '1.0.0')
  expect(JSON.parse(readFileSync(join(deployment, 'node_modules/second/node_modules/library/node_modules/parser/package.json'), 'utf8'))).toHaveProperty('version', '2.0.0')
  expect(await restoreDeployedDependencies(deployment, source)).toEqual([])
})

it('traverses deployed dependencies of a workspace package injected into the source tree', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*', cordis: '*' } })
  write(deployment, {})
  // Legacy hoisted deploy can replace the CLI workspace link with copied files,
  // while injecting its transitive packages only into the deployment tree.
  write(join(source, 'node_modules/cli'), { dependencies: { acp: '*', research: '*', cordis: '*' } })
  write(join(source, 'node_modules/cordis'), {})
  write(join(deployment, 'node_modules/acp'), { peerDependencies: { cordis: '*' } })
  write(join(deployment, 'node_modules/research'), { dependencies: { knowledge: '*' } })
  write(join(deployment, 'node_modules/knowledge'), { peerDependencies: { cordis: '*' } })

  expect(await restoreDeployedDependencies(deployment, source)).toEqual(['cli', 'cordis'])
  expect(await restoreDeployedDependencies(deployment, source)).toEqual([])
  expect(lstatSync(join(deployment, 'node_modules/cli')).isSymbolicLink()).toBe(false)
  expect(() => lstatSync(join(deployment, 'node_modules/acp/node_modules/cordis'))).toThrow()
  expect(() => lstatSync(join(deployment, 'node_modules/knowledge/node_modules/cordis'))).toThrow()
})

it('rejects a missing required edge further down a deployed injected graph', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cli'), { dependencies: { acp: '*' } })
  write(join(deployment, 'node_modules/acp'), { dependencies: { missing: '*' } })
  await expect(restoreDeployedDependencies(deployment, source)).rejects.toThrow('required dependency missing is missing')
})

it('resolves original workspace links before reusing injected deployed packages', async (test) => {
  const { source, deployment } = fixture(test)
  const workspace = join(dirname(source), 'workspace')
  write(source, { dependencies: { cli: '*', cordis: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cordis'), {})
  write(join(workspace, 'cli'), { dependencies: { acp: '*', cordis: '*' } })
  write(join(workspace, 'acp'), { peerDependencies: { cordis: '*' } })
  for (const name of ['cli', 'acp']) {
    mkdirSync(join(workspace, name, 'node_modules'))
    symlinkSync(join(source, 'node_modules/cordis'), join(workspace, name, 'node_modules/cordis'), 'junction')
  }
  symlinkSync(join(workspace, 'cli'), join(source, 'node_modules/cli'), 'junction')
  symlinkSync(join(workspace, 'acp'), join(workspace, 'cli/node_modules/acp'), 'junction')
  write(join(deployment, 'node_modules/acp'), { peerDependencies: { cordis: '*' } })

  expect(await restoreDeployedDependencies(deployment, source)).toEqual(['cli', 'cordis'])
  expect(await restoreDeployedDependencies(deployment, source)).toEqual([])
  expect(() => lstatSync(join(deployment, 'node_modules/acp/node_modules/cordis'))).toThrow()
})

it('does not borrow undeployed dependencies from unrelated ancestor node_modules', async (test) => {
  const { source, deployment } = fixture(test)
  write(source, { dependencies: { cli: '*' } })
  write(deployment, {})
  write(join(source, 'node_modules/cli'), { dependencies: { acp: '*' } })
  write(join(deployment, 'node_modules/acp'), { dependencies: { unrelated: '*' } })
  write(join(dirname(deployment), 'node_modules/unrelated'), {})
  await expect(restoreDeployedDependencies(deployment, source)).rejects.toThrow('required dependency unrelated is missing')
})
