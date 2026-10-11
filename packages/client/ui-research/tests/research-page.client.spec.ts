import { expect, it, vi } from 'vitest'
import type { ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { loadResearchPage } from '../src/client/researchPage.ts'
import { page } from './fixtures/memory.ts'

it.each(['page', 'missing page'] as const)('drops a %s received after the owning effect is disposed', async (answer) => {
  const response = Promise.withResolvers<ResearchResponse>()
  const setPage = vi.fn()
  const setError = vi.fn()
  const dispose = loadResearchPage({
    latest: { current: 0 }, request: () => response.promise, field: 'memory',
    missingResponse: () => 'No memory returned', setPage, setError,
  })
  dispose()
  response.resolve(answer === 'page' ? { message: 'ok', memory: page() } : { message: 'empty' })
  await response.promise
  await Promise.resolve()
  expect(setPage).not.toHaveBeenCalled()
  expect(setError).not.toHaveBeenCalled()
})

it('drops a rejected read after the owning effect is disposed', async () => {
  const response = Promise.withResolvers<ResearchResponse>()
  const setPage = vi.fn()
  const setError = vi.fn()
  const dispose = loadResearchPage({
    latest: { current: 0 }, request: () => response.promise, field: 'memory',
    missingResponse: () => 'No memory returned', setPage, setError,
  })
  dispose()
  response.reject(new Error('Disposed read failed'))
  await expect(response.promise).rejects.toThrow('Disposed read failed')
  expect(setPage).not.toHaveBeenCalled()
  expect(setError).not.toHaveBeenCalled()
})

it('resolves the missing-page message only when a pending response arrives', async () => {
  const response = Promise.withResolvers<ResearchResponse>()
  let message = 'No memory returned'
  const missingResponse = vi.fn(() => message)
  const setPage = vi.fn()
  const setError = vi.fn()
  const dispose = loadResearchPage({
    latest: { current: 0 }, request: () => response.promise, field: 'memory',
    missingResponse, setPage, setError,
  })
  expect(missingResponse).not.toHaveBeenCalled()
  message = '未返回记忆'
  response.resolve({ message: 'empty' })
  await response.promise
  await Promise.resolve()
  expect(setError).toHaveBeenCalledExactlyOnceWith(message)
  expect(setPage).not.toHaveBeenCalled()
  dispose()
})
