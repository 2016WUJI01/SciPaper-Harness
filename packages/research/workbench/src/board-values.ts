/** Browser-safe experiment-board selectors shared by Host collection and Client rendering. */
import type { ExperimentRecord, ResearchProject } from './types.ts'

/**
 * Whether a run name matches a pattern in which `*` matches anything.
 * @param pattern - the name, with `*` for any run of characters.
 * @param name - a run name.
 * @returns whether the whole name matches.
 */
export function nameMatches(pattern: string, name: string): boolean {
  const expression = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${expression}$`).test(name)
}

/**
 * The runs a board value follows: the run with that id, else every run of that name (and seed).
 * @param project - the runs on record.
 * @param ref - the run it names (an id, or a name) and the seed, when one is picked.
 * @returns the followed runs, in record order.
 */
export function followedRuns(project: Pick<ResearchProject, 'experiments'>, ref: { run?: string | undefined; seed?: number | undefined }): ExperimentRecord[] {
  if (ref.run === undefined) return []
  const byId = project.experiments.filter(run => run.id === ref.run)
  if (byId.length) return byId
  return project.experiments.filter(run => run.spec.name === ref.run && (ref.seed === undefined || run.spec.seed === ref.seed))
}

/**
 * The run a chart line follows: the latest of those {@link followedRuns} finds.
 * @param project - the runs on record.
 * @param ref - the run it names (an id, or a name) and the seed, when one is picked.
 * @returns the latest followed run, or undefined when none is.
 */
export function latestRun(project: Pick<ResearchProject, 'experiments'>, ref: { run?: string | undefined; seed?: number | undefined }): ExperimentRecord | undefined {
  return followedRuns(project, ref).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
}
