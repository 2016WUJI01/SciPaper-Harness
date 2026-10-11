/** Restore production dependencies that legacy pnpm deploy hoists into its source tree. */
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

interface Manifest {
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

async function manifestAt(directory: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
}

function resolvePackage(from: string, name: string, boundary?: string): string | undefined {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (directory === boundary || dirname(directory) === directory) return undefined
  }
}

async function copyPackage(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const nested = join(source, 'node_modules')
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nested && !path.startsWith(nested + sep),
  })
}

/**
 * Restore the complete production graph split between legacy deploy and its source tree.
 * Matching versions from the same installed source are reused; other sources stay nested.
 * Package-local node_modules are traversed by declared edges, never copied whole,
 * so shared peers retain the deployment's single instance.
 * @param deployment - pnpm's generated production directory.
 * @param source - the original workspace selected by pnpm deploy.
 * @returns Paths of restored packages relative to the deployment's node_modules.
 * @throws if a required dependency is absent from both installed trees.
 */
export async function restoreDeployedDependencies(deployment: string, source: string): Promise<string[]> {
  const queue = [{ destination: deployment, source }]
  const visited = new Set<string>()
  const origins = new Map<string, string>()
  const restored: string[] = []
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    if (visited.has(current.destination)) continue
    visited.add(current.destination)
    if ((await lstat(current.destination)).isSymbolicLink()) {
      await unlink(current.destination)
      await copyPackage(current.source, current.destination)
    }
    const manifest = await manifestAt(current.source)
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const dependency of Object.keys(dependencies).sort()) {
      const installed = resolvePackage(current.destination, dependency, deployment)
      // Injected workspace copies can lose their local dependency links during
      // deploy while their children are already installed in the target tree.
      const sourceBoundary = current.source.startsWith(deployment + sep) ? deployment : undefined
      const origin = resolvePackage(current.source, dependency, sourceBoundary) ?? installed
      if (origin === undefined) {
        if (Object.hasOwn(manifest.optionalDependencies ?? {}, dependency)
          || manifest.peerDependenciesMeta?.[dependency]?.optional === true) continue
        throw new Error(`deploy: required dependency ${dependency} is missing from ${current.source} and ${current.destination}`)
      }
      const source = origins.get(origin) ?? await realpath(origin)
      const expected = await manifestAt(source)
      const available = installed !== undefined && installed.startsWith(deployment + sep)
        && (await manifestAt(installed)).version === expected.version
        && (origins.get(installed) === undefined || origins.get(installed) === source)
      let destination = available ? installed : join(current.destination, 'node_modules', dependency)
      if (!available) {
        // Reuse the flat installation for absent packages; version or source conflicts
        // need a private node_modules directory below their consumer.
        const flat = join(deployment, 'node_modules', dependency)
        if (!existsSync(flat)) destination = flat
        if (existsSync(destination)) {
          throw new Error(`deploy: ${destination} conflicts with installed source version ${expected.version ?? '(missing)'}`)
        }
        await copyPackage(source, destination)
        restored.push(destination.slice(join(deployment, 'node_modules').length + 1))
      }
      origins.set(destination, source)
      queue.push({ source, destination })
    }
  }
  return restored
}
