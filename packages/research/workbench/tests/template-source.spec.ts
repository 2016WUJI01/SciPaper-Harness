import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { importTemplate } from '../src/artifacts.ts'
import { newProject } from '../src/project.ts'

// Device nodes cannot be created portably; preserve real path validation and
// supply only the filesystem's special-file classification at the stat seam.
const source = vi.hoisted(() => ({ special: '' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const info = await actual.stat(...args)
      if (String(args[0]) === source.special) {
        info.isDirectory = () => false
        info.isFile = () => false
      }
      return info
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  source.special = ''
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('rejects a template source that the filesystem classifies as neither a directory nor a regular file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'research-template-source-')))
  roots.push(root)
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const project = newProject({ root: projectRoot, title: 'Template', brief: '' }, 'workspace' as WorkspaceId)
  source.special = join(root, 'special.tex')
  await writeFile(source.special, 'not a regular template source')
  await expect(importTemplate(project, [source.special], 10000))
    .rejects.toThrow(`Template source is neither a file nor a directory: ${source.special}`)
  await expect(importTemplate(project, [join(root, 'missing.tex')], 10000)).rejects.toThrow(/ENOENT/)
})
