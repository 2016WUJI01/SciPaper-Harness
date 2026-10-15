/** Revision-guarded reads shared by the evidence and memory views. */
import type { ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'

/** Pages whose reads follow the current research record's revision. */
type PageField = 'evidenceGraph' | 'memory'

/** One view's read, publication callbacks and shared invalidation counter. */
interface PageRead<Field extends PageField> {
  latest: { current: number }
  request(): Promise<ResearchResponse>
  field: Field
  missingResponse(): string
  setPage(page: NonNullable<ResearchResponse[Field]>): void
  setError(message: string): void
}

/**
 * Publish only a read that has not been superseded or disposed. A successful
 * read clears its prior error; failures leave the previous page in place.
 * @param read - the request and view state; a saved mutation increments `latest` before publishing its page.
 * @returns the effect disposer, which invalidates pending success and failure callbacks.
 */
export function loadResearchPage<Field extends PageField>(read: PageRead<Field>): () => void {
  const ticket = ++read.latest.current
  read.request().then((result) => {
    if (ticket !== read.latest.current) return
    const page = result[read.field]
    if (!page) throw new Error(read.missingResponse())
    read.setPage(page)
    read.setError('')
  }).catch((reason: unknown) => {
    if (ticket === read.latest.current) read.setError(reason instanceof Error ? reason.message : String(reason))
  })
  return () => { read.latest.current++ }
}
