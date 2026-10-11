import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflow = record(yaml.load(readFileSync(resolve(root, '.github/workflows/build-preview-cloudflare.yml'), 'utf8')))
const preview = record(record(workflow.jobs).preview)
if (!Array.isArray(preview.steps)) throw new TypeError('Preview workflow must define steps')
const steps = preview.steps.map(record)
const requiredSecrets = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected a mapping')
  return value as Record<string, unknown>
}

function step(name: string): Record<string, unknown> {
  const found = steps.find(candidate => candidate.name === name)
  if (!found) throw new Error(`Missing preview step: ${name}`)
  return found
}

function evaluate(selector: unknown, context: Record<string, unknown>): unknown {
  if (typeof selector !== 'string' || !selector.startsWith('${{') || !selector.endsWith('}}')) {
    throw new TypeError('Expected an Actions expression')
  }
  return runInNewContext(selector.slice(3, -2), context, { timeout: 1000 })
}

function deploymentContext(options: {
  repository?: string
  headRepository?: string
  project?: string
  actor?: string
  author?: string
  eventName?: string
  missingSecrets?: readonly string[]
} = {}): Record<string, unknown> {
  const repository = options.repository ?? 'M-24rjgc/SciPaper-Harness'
  const github = {
    repository,
    actor: options.actor ?? 'maintainer',
    event_name: options.eventName ?? 'pull_request',
    event: { pull_request: { head: { repo: { full_name: options.headRepository ?? repository } }, user: { login: options.author ?? 'maintainer' } } },
  }
  const vars = { CF_PREVIEW_PROJECT: options.project ?? '' }
  return {
    github,
    vars,
    env: { CF_PROJECT: evaluate(record(workflow.env).CF_PROJECT, { github, vars }) },
    secrets: Object.fromEntries(requiredSecrets.map(name => [name, options.missingSecrets?.includes(name) ? '' : `test-${name}`])),
  }
}

function enabled(context: Record<string, unknown>): unknown {
  return evaluate(record(step('Select preview publication mode').env).DEPLOY_PREVIEW, context)
}

describe('PR preview workflow', () => {
  it('keeps every PR author on the selected GitHub-hosted runner', () => {
    expect(Object.keys(record(workflow.jobs))).toEqual(['preview'])
    expect(preview['runs-on']).toBe('ubuntu-24.04')
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
    expect(steps.find(item => item.uses === 'actions/checkout@v6')?.with).toEqual({ 'persist-credentials': false })
  })

  it('keeps immutable installation and restore-only dependency caching', () => {
    expect(record(workflow.env).PRIMARY_NODE_VERSION).toBe('24')
    expect(record(workflow.env).DSH_TELEMETRY_DISABLED).toBe('1')
    expect(steps.map(item => item.run)).toContain('pnpm install --frozen-lockfile')
    expect(steps.filter(item => typeof item.uses === 'string' && item.uses.startsWith('actions/cache'))).toHaveLength(1)
    expect(steps.find(item => item.uses === 'actions/cache/restore@v4')?.with).toMatchObject({
      key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    })
  })

  it('builds, shapes and retains the site and VFS image even without deployment credentials', () => {
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
    expect(preview.if).toBeUndefined()
    expect(preview['continue-on-error']).toBeUndefined()
    const build = step('Build workspace')
    const pack = step('Build the preview page and pack the VFS image')
    const shape = step('Shape the upload')
    const artifact = step('Retain preview artifacts')
    const mode = step('Select preview publication mode')
    expect(build.run).toBe('pnpm run build')
    expect(pack.run).toBe('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview')
    expect(shape.run).toEqual(expect.stringContaining("find apps/web/dist -name '*.map' -delete"))
    expect(shape.run).toEqual(expect.stringContaining('cp apps/web/dist/preview.html apps/web/dist/index.html'))
    expect(shape.run).toEqual(expect.stringContaining('gzip -t apps/web/dist/preview/vfs-image.tar.gz'))
    expect(artifact).toMatchObject({
      id: 'preview_artifact',
      uses: 'actions/upload-artifact@v4',
      with: {
        name: 'pr-preview-${{ github.event.pull_request.number }}',
        path: 'apps/web/dist',
        'if-no-files-found': 'error',
      },
    })
    for (const item of [build, pack, shape, artifact, mode]) {
      expect(item.if).toBeUndefined()
      expect(item['continue-on-error']).toBeUndefined()
    }
    const ordered = [build, pack, shape, artifact, mode, step('Upload to Cloudflare Pages')].map(item => steps.indexOf(item))
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
  })

  it('keeps an unconfigured fork in artifact-only mode', () => {
    const context = deploymentContext()
    expect(record(context.env).CF_PROJECT).toBe('')
    expect(enabled(context)).toBe(false)
    expect(enabled(deploymentContext({ missingSecrets: requiredSecrets }))).toBe(false)
  })

  it('allows the protected upstream project and an explicitly configured same-repository project', () => {
    const upstream = deploymentContext({ repository: 'deepseek-harness/deepseek-harness' })
    expect(record(upstream.env).CF_PROJECT).toBe('dsh-build-preview')
    expect(enabled(upstream)).toBe(true)
    const configured = deploymentContext({ project: 'scipaper-preview' })
    expect(record(configured.env).CF_PROJECT).toBe('scipaper-preview')
    expect(enabled(configured)).toBe(true)
  })

  it.each(requiredSecrets)('requires %s before any deployment or verification', (missingSecret) => {
    expect(enabled(deploymentContext({ project: 'scipaper-preview', missingSecrets: [missingSecret] }))).toBe(false)
  })

  it.each([
    { headRepository: 'contributor/fork' },
    { actor: 'dependabot[bot]' },
    { author: 'dependabot[bot]' },
    { eventName: 'pull_request_target' },
    { eventName: 'push' },
  ])('rejects an untrusted deployment context: %j', (options) => {
    expect(enabled(deploymentContext({ project: 'scipaper-preview', ...options }))).toBe(false)
  })

  it('makes the artifact-only result explicit without publishing a preview link', () => {
    const mode = step('Select preview publication mode')
    expect(mode.id).toBe('deployment')
    expect(mode.run).toEqual(expect.stringContaining('echo "enabled=$DEPLOY_PREVIEW" >> "$GITHUB_OUTPUT"'))
    expect(mode.run).toEqual(expect.stringContaining('Artifact-only preview'))
    expect(mode.run).toEqual(expect.stringContaining('deployment and protected-image verification were not run'))
    expect(mode.run).toEqual(expect.stringContaining('$GITHUB_STEP_SUMMARY'))
    expect(record(mode.env).ARTIFACT_URL).toBe('${{ steps.preview_artifact.outputs.artifact-url }}')
    expect(mode.run).not.toMatch(/CF_ACCESS_CLIENT|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/u)
  })

  it('uses the same fail-closed gate for deploy, protected-image verification and URL comment', () => {
    expect(workflow.concurrency).toEqual({
      group: 'build-preview-cloudflare-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    })
    const remoteSteps = [
      step('Upload to Cloudflare Pages'),
      step('Verify the protected deployment serves the image'),
      step('Comment the preview URL'),
    ]
    for (const item of remoteSteps) {
      expect(item.if).toBe("steps.deployment.outputs.enabled == 'true'")
      expect(item['continue-on-error']).toBeUndefined()
    }
    expect(remoteSteps[0]!.run).toEqual(expect.stringContaining('npx --yes wrangler@4 pages deploy apps/web/dist'))
    expect(remoteSteps[0]!.run).toEqual(expect.stringContaining('--branch "pr-${{ github.event.pull_request.number }}"'))
    const verify = remoteSteps[1]!
    expect(verify.run).toEqual(expect.stringContaining('/preview/vfs-image.tar.gz'))
    expect(record(verify.env).CF_ACCESS_CLIENT_SECRET).toBe('${{ secrets.CF_ACCESS_CLIENT_SECRET }}')
    expect(verify.run).toEqual(expect.stringContaining('if [ "$code" != "200" ]; then'))
    expect(verify.run).toEqual(expect.stringContaining("if grep -qi '^content-encoding:' headers.txt; then"))
    expect(verify.run).toEqual(expect.stringContaining('if [ "$magic" != "1f8b" ]; then'))
    expect(remoteSteps[2]!.run).toEqual(expect.stringContaining('<!-- dsh-preview-url -->'))
    expect(remoteSteps[2]!.run).toEqual(expect.stringContaining('gh pr comment "$PR" --body-file -'))
  })
})
