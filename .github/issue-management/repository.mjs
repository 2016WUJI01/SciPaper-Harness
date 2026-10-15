/** Repository identity for local PR checks and the configured organization Project. */

import process from 'node:process'

import config from './config.json' with { type: 'json' }

/**
 * Resolve the event repository, defaulting to the configured repository outside Actions.
 * @returns {string} Validated owner/repository name for same-repository REST reads.
 */
export function repositoryName() {
  const name = process.env.GITHUB_REPOSITORY ?? `${config.organization}/${config.repository}`
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('GITHUB_REPOSITORY must identify owner/repository')
  }
  return name
}

/**
 * Identify the repository whose Issues belong to the configured organization Project.
 * @returns {boolean} Whether Project validation and lifecycle mutations apply.
 */
export function usesConfiguredProject() {
  return repositoryName().toLowerCase() === `${config.organization}/${config.repository}`.toLowerCase()
}
