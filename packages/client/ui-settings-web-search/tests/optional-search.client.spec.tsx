// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { SEARCH_BACKENDS, SearchBackendBadge, SearchBackendConfig, type CredentialStatus, type SearchBackendBadgeProps, type SearchBackendConfigProps } from '../src/client/OptionalSearchBackend.tsx'
import type { ComponentProps, MouseEvent } from 'react'
import { en } from '../src/client/locales.ts'

const submitHandler = vi.hoisted(() => ({ invoke: undefined as (() => void) | undefined }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const primitives = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return { ...primitives, Button: (props: ComponentProps<typeof primitives.Button>) => {
    // Capture the public callback as well as rendering the real disabled button.
    submitHandler.invoke = () => { props.onClick?.({} as MouseEvent<HTMLButtonElement>) }
    return <primitives.Button {...props} />
  } }
})

afterEach(() => { cleanup(); submitHandler.invoke = undefined })
const globalProps = {} as GlobalStandardProps

it('does not repeat credential queries when the slot injects a fresh props object', async () => {
  const readCredential = vi.fn(async () => ({ configured: false, writable: true }))
  const onCredentialChanged = vi.fn(() => () => {})
  const subject = { kind: 'bundle', pkg: { name: '@deepseek-ai/dsh-web-search-exa-bundle', installed: false, enabled: false, rows: [] } } as const
  const stable = {
    ...globalProps,
    subject,
    t: makeTranslate(en),
    readCredential,
    writeCredential: vi.fn(),
    onCredentialChanged,
  } satisfies SearchBackendBadgeProps
  const view = render(<SearchBackendBadge {...stable} />)
  await screen.findByText(en.backendPending)
  expect(readCredential).toHaveBeenCalledTimes(1)
  view.rerender(<SearchBackendBadge {...{ ...stable }} />)
  await waitFor(() => { expect(readCredential).toHaveBeenCalledTimes(1) })
  expect(onCredentialChanged).toHaveBeenCalledTimes(1)
})

it('labels an enabled search backend without a key as pending configuration', async () => {
  const props = {
    ...globalProps,
    subject: { kind: 'bundle', pkg: { name: '@deepseek-ai/dsh-web-search-exa-bundle', installed: false, enabled: true, rows: [] } } as const,
    t: makeTranslate(en),
    readCredential: vi.fn(async () => ({ configured: false, writable: true })),
    writeCredential: vi.fn(),
    onCredentialChanged: vi.fn(() => () => {}),
  } satisfies SearchBackendBadgeProps
  render(<SearchBackendBadge {...props} />)
  expect(await screen.findByText(en.backendEnabledPending)).toBeTruthy()
  expect(screen.queryByText(en.backendReady)).toBeNull()
})


function credentialFixture() {
  const initial = Promise.withResolvers<CredentialStatus | undefined>()
  const readCredential = vi.fn(() => initial.promise)
  const writeCredential = vi.fn(async (_ref: string, _value: string) => {})
  const unsubscribe = vi.fn()
  let publish!: (ref: string) => void
  const onCredentialChanged = vi.fn((listener: (ref: string) => void) => { publish = listener; return unsubscribe })
  const backend = SEARCH_BACKENDS[0]!
  const props = { ...globalProps, backend, t: makeTranslate(en),
    readCredential, writeCredential, onCredentialChanged } as SearchBackendConfigProps
  return { initial, readCredential, writeCredential, unsubscribe, props, publish: (ref: string) => { publish(ref) } }
}

it('saves a configured backend key, refreshes its status, and keeps drafts after a refused write', async () => {
  const f = credentialFixture()
  render(<SearchBackendConfig {...f.props} />)
  expect(screen.getByText(en.backendChecking)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
  await act(async () => { f.initial.resolve({ configured: false, writable: true }) })
  expect(screen.getByText(en.backendPending)).toBeTruthy()
  const input = screen.getByLabelText(en.apiKey) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'test-key' } })
  const saved = Promise.withResolvers<undefined>()
  f.writeCredential.mockImplementationOnce(() => saved.promise)
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect(f.writeCredential).toHaveBeenCalledExactlyOnceWith('EXA_API_KEY', 'test-key')
  expect(screen.getByRole('button', { name: en.saving }).hasAttribute('disabled')).toBe(true)
  f.readCredential.mockResolvedValueOnce({ configured: true, writable: true })
  await act(async () => { saved.resolve(undefined) })
  expect(screen.getByText(en.backendReady)).toBeTruthy()
  expect(input.value).toBe('')
  fireEvent.change(input, { target: { value: 'retry-key' } })
  f.writeCredential.mockRejectedValueOnce(new Error('write refused'))
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect((await screen.findByRole('alert')).textContent).toBe(en.saveFailed)
  expect(input.value).toBe('retry-key')
  f.readCredential.mockResolvedValueOnce(undefined)
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect(await screen.findByText(en.backendUnknown)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('handles credential read failures, changed references, and a rejected refresh after saving', async () => {
  const f = credentialFixture()
  render(<SearchBackendConfig {...f.props} />)
  await act(async () => { f.initial.reject(new Error('offline')) })
  expect(screen.getByText(en.backendUnknown)).toBeTruthy()
  f.publish('OTHER_KEY')
  expect(f.readCredential).toHaveBeenCalledTimes(1)
  f.readCredential.mockResolvedValueOnce({ configured: true, writable: false })
  await act(async () => { f.publish('EXA_API_KEY') })
  expect(screen.getByText(en.backendReady)).toBeTruthy()
  expect(screen.getByLabelText(en.apiKey).hasAttribute('disabled')).toBe(true)
  f.readCredential.mockResolvedValueOnce({ configured: false, writable: true })
  await act(async () => { f.publish('EXA_API_KEY') })
  fireEvent.change(screen.getByLabelText(en.apiKey), { target: { value: 'new-key' } })
  f.readCredential.mockRejectedValueOnce(new Error('refresh offline'))
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect(await screen.findByText(en.backendUnknown)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['resolve', 'reject'] as const)('unsubscribes and ignores a late %s after unmount', async (completion) => {
  const f = credentialFixture()
  const view = render(<SearchBackendConfig {...f.props} />)
  view.unmount()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
  await act(async () => {
    if (completion === 'resolve') f.initial.resolve(undefined)
    else f.initial.reject(new Error('late read'))
  })
  expect(view.container.innerHTML).toBe('')
})

it('renders unknown and configured badge states while ignoring unrelated subjects', async () => {
  const f = credentialFixture()
  const props = { ...f.props, subject: { kind: 'bundle', pkg: { name: f.props.backend.bundle, installed: true, enabled: true, rows: [] } } } as SearchBackendBadgeProps
  const view = render(<SearchBackendBadge {...props} />)
  expect(screen.getByText(en.backendChecking)).toBeTruthy()
  await act(async () => { f.initial.resolve(undefined) })
  expect(screen.getByText(en.backendUnknown)).toBeTruthy()
  f.readCredential.mockResolvedValueOnce({ configured: true, writable: false })
  await act(async () => { f.publish('EXA_API_KEY') })
  expect(screen.getByText(en.backendReady)).toBeTruthy()
  view.rerender(<SearchBackendBadge {...props} subject={{ kind: 'bundle', pkg: { name: 'other-bundle', installed: true, enabled: true, rows: [] } }} />)
  expect(view.container.innerHTML).toBe('')
  expect(f.unsubscribe).toHaveBeenCalledOnce()
  view.rerender(<SearchBackendBadge {...props} subject={{ kind: 'item', id: 'other-plugin' }} />)
  expect(view.container.innerHTML).toBe('')
})


it('rejects programmatic submission with an empty draft or an already pending save', async () => {
  const f = credentialFixture()
  const saved = Promise.withResolvers<undefined>()
  render(<SearchBackendConfig {...f.props} />)
  await act(async () => { f.initial.resolve({ configured: false, writable: true }) })
  act(() => { submitHandler.invoke!() })
  expect(f.writeCredential).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(en.apiKey), { target: { value: 'one-key' } })
  f.writeCredential.mockImplementationOnce(() => saved.promise)
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  act(() => { submitHandler.invoke!() })
  expect(f.writeCredential).toHaveBeenCalledTimes(1)
  await act(async () => { saved.resolve(undefined) })
})
