import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'
import { expect, it, type TestContext } from 'vitest'
import { normalizeDeployedBuildRules } from './normalize-deployed-build-rules.ts'

function fixture(test: TestContext, rules: Record<string, boolean | string>) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-deploy-build-rules-'))
  test.onTestFinished(() => { rmSync(workspace, { recursive: true, force: true }) })
  const deployment = join(workspace, 'stage')
  const local = join(workspace, 'packages', 'local # helper')
  mkdirSync(deployment)
  mkdirSync(local, { recursive: true })
  writeFileSync(join(deployment, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const path = join(deployment, 'pnpm-workspace.yaml')
  writeFileSync(path, dump({ allowBuilds: rules, patchedDependencies: { native: '../native.patch' } }))
  return { workspace, deployment, local, path }
}

for (const permission of [true, false]) it(`preserves local-file permission ${permission} using the deployed file URL`, async (test) => {
  const { workspace, deployment, local, path } = fixture(test, {
    '@scope/helper@file:packages/local # helper': permission,
    koffi: true,
    protobufjs: false,
  })
  await normalizeDeployedBuildRules(deployment, workspace)
  expect(load(readFileSync(path, 'utf8'))).toEqual({
    allowBuilds: { [`@scope/helper@${pathToFileURL(realpathSync(local)).href}`]: permission, koffi: true, protobufjs: false },
    patchedDependencies: { native: '../native.patch' },
  })
  const first = readFileSync(path, 'utf8')
  await normalizeDeployedBuildRules(deployment, workspace)
  expect(readFileSync(path, 'utf8')).toBe(first)
})

it('rejects conflicting permissions without rewriting the staged policy', async (test) => {
  const { workspace, deployment, local, path } = fixture(test, {})
  const original = dump({ allowBuilds: {
    '@scope/helper@file:packages/local # helper': true,
    [`@scope/helper@${pathToFileURL(realpathSync(local)).href}`]: false,
  } })
  writeFileSync(path, original)
  await expect(normalizeDeployedBuildRules(deployment, workspace)).rejects.toThrow('conflicting build permissions')
  expect(readFileSync(path, 'utf8')).toBe(original)
})

it('rejects an unlocked deployment before modifying lifecycle permissions', async (test) => {
  const { workspace, deployment, path } = fixture(test, { koffi: true })
  rmSync(join(deployment, 'pnpm-lock.yaml'))
  const original = readFileSync(path, 'utf8')
  await expect(normalizeDeployedBuildRules(deployment, workspace)).rejects.toThrow('pnpm-lock.yaml')
  expect(readFileSync(path, 'utf8')).toBe(original)
})

for (const conflict of [false, true]) it(`canonicalizes absolute junction aliases before comparing build permissions (conflict=${conflict})`, async (test) => {
  const { workspace, deployment, local, path } = fixture(test, {})
  const alias = join(workspace, 'alias')
  symlinkSync(local, alias, 'junction')
  const original = dump({ allowBuilds: {
    [`@scope/helper@${pathToFileURL(alias).href}`]: false,
    '@scope/helper@file:packages/local # helper': conflict,
  } })
  writeFileSync(path, original)
  if (conflict) {
    await expect(normalizeDeployedBuildRules(deployment, workspace)).rejects.toThrow('conflicting build permissions')
    expect(readFileSync(path, 'utf8')).toBe(original)
  } else {
    await normalizeDeployedBuildRules(deployment, workspace)
    expect(load(readFileSync(path, 'utf8'))).toEqual({ allowBuilds: { [`@scope/helper@${pathToFileURL(realpathSync(local)).href}`]: false } })
  }
})

it('retains an empty permission policy when no allowBuilds section exists', async (test) => {
  const { workspace, deployment, path } = fixture(test, {})
  writeFileSync(path, 'packages: []\n')
  await normalizeDeployedBuildRules(deployment, workspace)
  expect(load(readFileSync(path, 'utf8'))).toEqual({ packages: [], allowBuilds: {} })
})
