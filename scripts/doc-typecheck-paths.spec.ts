import { describe, expect, it } from 'vitest'
import { builtDeclarationPath } from './doc-typecheck-paths.ts'

describe('builtDeclarationPath', () => {
  it('maps package source directories and exact entry files to built declarations', () => {
    expect(builtDeclarationPath('./packages/*/*/src')).toBe('./packages/*/*/lib/types')
    expect(builtDeclarationPath('./packages/runtime-diagnostics/invariants/src/index.ts'))
      .toBe('./packages/runtime-diagnostics/invariants/lib/types/index.d.ts')
    expect(builtDeclarationPath('./packages/core/session/src/invariant.ts'))
      .toBe('./packages/core/session/lib/types/invariant.d.ts')
  })

  it('preserves aliases that already identify built declaration files', () => {
    for (const candidate of [
      './packages/research/workbench/lib/typert.remote-client.d.ts',
      './packages/core/session/lib/types/index.d.ts',
    ]) {
      expect(builtDeclarationPath(candidate)).toBe(candidate)
    }
  })

  it('rejects aliases outside supported source and built declaration targets', () => {
    for (const candidate of [
      './packages/runtime-diagnostics/invariants/source/index.ts',
      './packages/research/workbench/source/typert.remote-client.d.ts',
      './packages/research/workbench/lib/typert.remote-client.ts',
      './packages/research/workbench/lib/typert.remote-client.d.ts.map',
      './packages/research/workbench/lib/../source/typert.remote-client.d.ts',
    ]) {
      expect(() => builtDeclarationPath(candidate)).toThrow('cannot map workspace source path')
    }
  })
})
