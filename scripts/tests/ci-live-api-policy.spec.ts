/** Real-API opt-in and trust policy must not suppress keyless packaging checks. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  if?: string
  run?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
}

interface Workflow {
  on: Record<string, unknown>
  jobs: Record<string, { if?: string; steps?: Step[] }>
}

function workflow(name: string): Workflow {
  return load(readFileSync(resolve(import.meta.dirname, '../../.github/workflows', name), 'utf8')) as Workflow
}

// These expressions use only boolean/string comparisons shared by Actions and
// JavaScript. This is deliberately not a general GitHub Actions interpreter.
function enabled(expression: string | undefined, context: Record<string, unknown>): boolean {
  if (!expression) throw new Error('Live API checks must have an explicit condition')
  return runInNewContext(expression, context, { timeout: 1000 }) as boolean
}

const runtime = workflow('build-exe-for-python-sdk.yml')
const e2e = workflow('e2e.yml')
const steps = Object.values(runtime.jobs).flatMap(job => job.steps ?? [])
const liveSteps = steps.filter(step => step.name?.includes('installed-wheel real API'))
const official = 'deepseek-harness/deepseek-harness'
const repositories = [official, 'M-24rjgc/SciPaper-Harness', 'another-owner/another-fork']
const events = ['pull_request', 'push', 'schedule', 'workflow_dispatch']

describe('real API workflow policy', () => {
  it('covers exactly both preflights and live wheel tests without pull_request_target', () => {
    expect(liveSteps.map(step => step.name)).toEqual([
      'Preflight installed-wheel real API test (POSIX)',
      'Preflight installed-wheel real API test (Windows)',
      'Run installed-wheel real API black-box test (POSIX)',
      'Run installed-wheel real API black-box test (Windows)',
    ])
    expect(runtime.on).toHaveProperty('workflow_call')
    expect(runtime.on).toHaveProperty('workflow_dispatch')
    expect(runtime.on).not.toHaveProperty('pull_request_target')
    expect(e2e.on).not.toHaveProperty('pull_request_target')
  })

  for (const repository of repositories) {
    it(`evaluates the actual YAML trust and opt-in matrix for ${repository}`, () => {
      for (const optIn of ['', '0', '1', 'true']) {
        for (const event of events) {
          for (const fork of [false, true]) {
            for (const author of ['maintainer', 'dependabot[bot]']) {
              const expected = (repository === official || optIn === '1')
                && (event !== 'pull_request' || (!fork && author !== 'dependabot[bot]'))
              const context = {
                vars: { DSH_LIVE_E2E: optIn },
                github: {
                  repository, event_name: event, actor: 'maintainer',
                  event: event === 'pull_request'
                    ? { pull_request: { head: { repo: { fork } }, user: { login: author } } }
                    : {},
                },
              }
              expect(enabled(e2e.jobs.e2e!.if, context)).toBe(expected)
              for (const ci of [false, true]) {
                for (const os of ['Linux', 'Windows', 'macOS']) {
                  for (const step of liveSteps) {
                    const matchingPlatform = step.name!.endsWith('(Windows)') ? os === 'Windows' : os !== 'Windows'
                    expect(enabled(step.if, { ...context, inputs: { ci }, runner: { os } }))
                      .toBe(expected && ci && matchingPlatform)
                  }
                }
              }
            }
          }
        }
      }
    })
  }

  it('keeps missing keys fatal in enabled lanes instead of testing secret availability in conditions', () => {
    const preflights = [...liveSteps.filter(step => step.name!.startsWith('Preflight')),
      e2e.jobs.e2e!.steps!.find(step => step.name === 'Preflight (require DEEPSEEK_API_KEY)')!]
    expect(preflights).toHaveLength(3)
    for (const step of preflights) {
      expect(step.env?.DEEPSEEK_API_KEY).toBe('${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}')
      expect(step.run).toContain('DEEPSEEK_API_KEY')
      expect(step.run).toMatch(/exit 1|throw /)
      expect(step['continue-on-error']).not.toBe(true)
    }
    for (const condition of [...liveSteps.map(step => step.if), e2e.jobs.e2e!.if]) {
      expect(condition).not.toMatch(/secrets\.|env\.|API_KEY/)
    }
  })

  it('keeps keyless installed-wheel and platform validation independent of live API opt-in', () => {
    for (const name of [
      'Run installed-wheel keyless black-box tests (POSIX)',
      'Run installed-wheel keyless black-box tests (Windows)',
      'Check Linux GLIBC requirements',
    ]) {
      const step = steps.find(candidate => candidate.name === name)!
      expect(step).toBeDefined()
      expect(step.if).toMatch(/^runner\.os (?:==|!=) '(?:Windows|Linux)'$/)
      expect(step['continue-on-error']).not.toBe(true)
    }
  })
})
