/** Worker protocol faults and join races complement the real HTML and PDF parser suites. */
import { EventEmitter, getEventListeners } from 'node:events'
import type { WorkerOptions } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderFetchBody } from '../src/html.ts'
import { extractPdfText } from '@deepseek-ai/dsh-web-fetch-http/src/pdf.ts'

const control = vi.hoisted(() => ({
  create: vi.fn<(entry: string, options: WorkerOptions) => ControlledWorker>(),
}))

vi.mock('node:worker_threads', () => ({
  Worker: function Worker(entry: string, options: WorkerOptions): ControlledWorker {
    return control.create(entry, options)
  },
}))

class ControlledWorker extends EventEmitter {
  readonly stdout = { resume: vi.fn() }
  readonly stderr = { resume: vi.fn() }
  readonly joining = Promise.withResolvers<undefined>()
  readonly joined = Promise.withResolvers<number>()
  readonly terminate = vi.fn(() => {
    this.joining.resolve(undefined)
    return this.joined.promise
  })
}

let workers: ControlledWorker[] = []
const operations: Promise<unknown>[] = []
const controllers: AbortController[] = []

beforeEach(() => {
  control.create.mockImplementation(() => {
    const worker = new ControlledWorker()
    workers.push(worker)
    return worker
  })
})

afterEach(async () => {
  for (const controller of controllers) controller.abort(new Error('parser test cleanup'))
  for (const worker of workers) worker.joined.resolve(0)
  await Promise.allSettled(operations)
  for (const worker of workers) worker.removeAllListeners()
  workers = []
  operations.length = 0
  controllers.length = 0
  control.create.mockReset()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const parsers = [
  {
    name: 'HTML',
    start: (signal: AbortSignal) => renderFetchBody({ kind: 'html', content: '<p>result</p>' }, signal, 90_000),
    message: { text: 'result', sourceTruncated: false },
    result: { text: 'result', sourceTruncated: false },
    failed: 'HTML conversion Worker failed',
    exited: 'HTML conversion Worker exited before returning text (7)',
  },
  {
    name: 'PDF',
    start: (signal: AbortSignal) => extractPdfText(new Uint8Array([1, 2, 3]), 32, signal),
    message: { content: 'result', truncated: false },
    result: { content: 'result', truncated: false },
    failed: 'PDF parser Worker failed',
    exited: 'PDF parser Worker exited before returning text (7)',
  },
]

function begin(start: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController()
  controllers.push(controller)
  const registration = vi.spyOn(AbortSignal.prototype, 'addEventListener')
  let operation: Promise<unknown>
  let subscribed: unknown
  try {
    operation = start(controller.signal)
    subscribed = registration.mock.contexts.at(-1)
  } finally { registration.mockRestore() }
  // Attach rejection handling at acquisition, including when an assertion interrupts the test.
  operations.push(operation.catch(() => {}))
  if (!(subscribed instanceof AbortSignal)) throw new Error('Parser did not subscribe to cancellation')
  const worker = workers.at(-1)
  if (worker === undefined) throw new Error('Parser did not acquire a Worker')
  const settled = vi.fn()
  void operation.then(settled, settled)
  return { controller, operation, worker, settled, subscribed }
}

function expectReleased(worker: ControlledWorker): void {
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(worker.eventNames()).toEqual([])
  expect(worker.stdout.resume).toHaveBeenCalledOnce()
  expect(worker.stderr.resume).toHaveBeenCalledOnce()
}

describe.each(parsers)('$name parser Worker lifecycle', (parser) => {
  it('waits for the Worker to join before publishing text and removes every listener', async () => {
    const { operation, worker, settled, subscribed } = begin(parser.start)
    expect(getEventListeners(subscribed, 'abort')).toHaveLength(1)
    worker.emit('message', parser.message)
    await worker.joining.promise
    expect(settled).not.toHaveBeenCalled()
    expect(getEventListeners(subscribed, 'abort')).toEqual([])
    worker.emit('error', new Error('late Worker error'))
    worker.emit('exit', 7)
    worker.joined.resolve(0)
    await expect(operation).resolves.toEqual(parser.result)
    expectReleased(worker)
    expect(getEventListeners(subscribed, 'abort')).toEqual([])
  })

  it('preserves a Worker error as the cause and waits for cleanup before rejecting', async () => {
    const { operation, worker, settled } = begin(parser.start)
    const cause = new Error('isolated parser failed')
    worker.emit('error', cause)
    await worker.joining.promise
    expect(settled).not.toHaveBeenCalled()
    worker.joined.resolve(1)
    await expect(operation).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: parser.failed, cause })
    expectReleased(worker)
  })

  it('rejects an exit without a response only after joining', async () => {
    const { operation, worker, settled } = begin(parser.start)
    worker.emit('exit', 7)
    await worker.joining.promise
    expect(settled).not.toHaveBeenCalled()
    worker.joined.resolve(7)
    await expect(operation).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: parser.exited })
    expectReleased(worker)
  })

  it('joins and removes the abort listener when Worker subscription throws', async () => {
    const failure = new Error('Worker listener registration failed')
    control.create.mockImplementationOnce(() => {
      const worker = new ControlledWorker()
      workers.push(worker)
      vi.spyOn(worker, 'once').mockImplementationOnce(() => { throw failure })
      return worker
    })
    const { operation, worker, settled, subscribed } = begin(parser.start)
    await worker.joining.promise
    expect(settled).not.toHaveBeenCalled()
    worker.joined.resolve(0)
    await expect(operation).rejects.toBe(failure)
    expectReleased(worker)
    expect(getEventListeners(subscribed, 'abort')).toEqual([])
  })

  it.each([null, 4, {}, { text: 4, content: 4 }, { text: 'x', content: 'x' },
    { text: 'x', content: 'x', sourceTruncated: 1, truncated: 1 },
  ])('rejects an invalid Worker response %# and joins', async (message) => {
    const { operation, worker } = begin(parser.start)
    worker.emit('message', message)
    await worker.joining.promise
    worker.joined.resolve(0)
    await expect(operation).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expectReleased(worker)
  })

  it.each([new Error('caller stopped parsing'), 'caller stopped parsing'])('joins once before rejecting cancellation (%#)', async (reason) => {
    const { controller, operation, worker, settled, subscribed } = begin(parser.start)
    controller.abort(reason)
    await worker.joining.promise
    expect(settled).not.toHaveBeenCalled()
    worker.joined.resolve(0)
    if (reason instanceof Error) await expect(operation).rejects.toBe(reason)
    else await expect(operation).rejects.toMatchObject({ code: 'WEB_ABORTED', cause: reason })
    expectReleased(worker)
    expect(getEventListeners(subscribed, 'abort')).toEqual([])
  })

  it('observes cancellation during Worker creation before installing listeners', async () => {
    const controller = new AbortController()
    controllers.push(controller)
    const reason = new Error('cancel while acquiring Worker')
    const worker = new ControlledWorker()
    workers.push(worker)
    control.create.mockImplementationOnce(() => {
      controller.abort(reason)
      return worker
    })
    const operation = parser.start(controller.signal)
    operations.push(operation.catch(() => {}))
    await worker.joining.promise
    worker.joined.resolve(0)
    await expect(operation).rejects.toBe(reason)
    expectReleased(worker)
  })

  it('rejects cancellation during the join even after text has arrived', async () => {
    const { controller, operation, worker, settled } = begin(parser.start)
    worker.emit('message', parser.message)
    await worker.joining.promise
    const reason = new Error('cancel after parser response')
    controller.abort(reason)
    expect(settled).not.toHaveBeenCalled()
    worker.joined.resolve(0)
    await expect(operation).rejects.toBe(reason)
    expectReleased(worker)
  })

  it('propagates a failed termination instead of reporting successful cancellation', async () => {
    const { controller, operation, worker, subscribed } = begin(parser.start)
    controller.abort(new Error('cancel parser'))
    await worker.joining.promise
    const failure = new Error('Worker termination failed')
    worker.joined.reject(failure)
    await expect(operation).rejects.toBe(failure)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(getEventListeners(subscribed, 'abort')).toEqual([])
  })
})

describe('parser Worker limits', () => {
  it.each(['plain text', 'x'.repeat(2_000_001)])('returns bounded plain text without creating a Worker (%#)', async (content) => {
    const result = await renderFetchBody({ kind: 'text', content }, new AbortController().signal, 90_000)
    expect(result).toEqual({ text: content.slice(0, 2_000_000), sourceTruncated: content.length > 2_000_000 })
    expect(control.create).not.toHaveBeenCalled()
  })

  it('rejects HTML output beyond its retained-text cap', async () => {
    const { operation, worker } = begin(parsers[0]!.start)
    worker.emit('message', { text: 'x'.repeat(8_000_001), sourceTruncated: false })
    worker.joined.resolve(0)
    await expect(operation).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expectReleased(worker)
  })

  it('rejects PDF output beyond the requested character limit', async () => {
    const { operation, worker } = begin(parsers[1]!.start)
    worker.emit('message', { content: 'x'.repeat(33), truncated: false })
    worker.joined.resolve(0)
    await expect(operation).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expectReleased(worker)
  })

  it('accepts extractable PDF text when the textless flag is false', async () => {
    const { operation, worker } = begin(parsers[1]!.start)
    worker.emit('message', { content: 'x'.repeat(32), truncated: true, textless: false })
    worker.joined.resolve(0)
    await expect(operation).resolves.toEqual({ content: 'x'.repeat(32), truncated: true })
    expectReleased(worker)
  })

  it('preserves the HTML deadline while joining after a successful response', async () => {
    vi.useFakeTimers()
    const { operation, worker, settled } = begin(signal => renderFetchBody({ kind: 'html', content: '<p>result</p>' }, signal, 100))
    worker.emit('message', parsers[0]!.message)
    await worker.joining.promise
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).not.toHaveBeenCalled()
    worker.joined.resolve(0)
    await expect(operation).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' })
    expectReleased(worker)
    expect(vi.getTimerCount()).toBe(0)
  })
})
