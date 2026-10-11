/** Preserve workspace lifecycle permissions after pnpm converts local dependencies to file URLs. */
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'

interface WorkspaceManifest {
  allowBuilds?: Record<string, boolean | string>
}

/**
 * Rewrite only existing local-file lifecycle rules for the frozen deployment.
 * Registry rules, explicit denials, and other workspace settings are retained.
 * @param deployment - pnpm's generated production directory.
 * @param workspace - original workspace root used by relative file rules.
 * @returns Completion after writing the staged rules.
 * @throws if two rules assign different permissions to the same installed source.
 */
export async function normalizeDeployedBuildRules(deployment: string, workspace: string): Promise<void> {
  // Legacy deploy can silently ignore the shared lockfile with the hoisted linker.
  // Refuse that output before any deferred lifecycle scripts run.
  await readFile(join(deployment, 'pnpm-lock.yaml'), 'utf8')
  const path = join(deployment, 'pnpm-workspace.yaml')
  const manifest = load(await readFile(path, 'utf8')) as WorkspaceManifest
  const rules = new Map(Object.entries(manifest.allowBuilds ?? {}))
  for (const [key, value] of Object.entries(manifest.allowBuilds ?? {})) {
    const match = /^(.*@)file:(?!\/\/)(.+)$/.exec(key)
    const name = match?.[1]
    const localPath = match?.[2]
    if (name === undefined || localPath === undefined) continue
    const normalized = name + pathToFileURL(await realpath(resolve(workspace, localPath))).href
    if (rules.has(normalized) && rules.get(normalized) !== value) {
      throw new Error(`deploy: conflicting build permissions for ${normalized}`)
    }
    rules.set(normalized, value)
    rules.delete(key)
  }
  manifest.allowBuilds = Object.fromEntries(rules)
  await writeFile(path, dump(manifest))
}
