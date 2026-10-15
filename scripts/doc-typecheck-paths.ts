/**
 * Map a workspace source alias to built types, preserving existing lib declaration targets.
 * @param candidate - Workspace alias target from the base TypeScript configuration.
 * @returns The built declaration path; rejects aliases outside source or built declaration paths.
 */
export function builtDeclarationPath(candidate: string): string {
  if (candidate.includes('/lib/') && candidate.endsWith('.d.ts') && !candidate.split('/').includes('..')) {
    return candidate
  }
  // Two workspace path forms exist: whole-package entries end in /src, subpath
  // wildcards (browser-safe /types and /client channels) in /src/*.
  if (candidate.endsWith('/src')) {
    return `${candidate.slice(0, -'/src'.length)}/lib/types`
  }
  if (candidate.endsWith('/src/*')) {
    return `${candidate.slice(0, -'/src/*'.length)}/lib/types/*`
  }
  const sourceFile = /^(.*)\/src\/(.+)\.ts$/.exec(candidate)
  if (sourceFile?.[1] && sourceFile[2]) {
    return `${sourceFile[1]}/lib/types/${sourceFile[2]}.d.ts`
  }
  // Directory subpath entries (for example, runtime's /client): the
  // source dir maps to the same dir under lib/types (index resolution applies).
  const sourceDir = /^(.*)\/src\/(.+)$/.exec(candidate)
  if (sourceDir?.[1] && sourceDir[2]) {
    return `${sourceDir[1]}/lib/types/${sourceDir[2]}`
  }
  throw new Error(`doc-typecheck: cannot map workspace source path to built declarations: ${candidate}`)
}
