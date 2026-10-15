// @vitest-environment jsdom
/** The join action remains safe when called without the native button's disabled protection. */
import { afterEach, expect, it, vi } from 'vitest'
import { createElement, type ButtonHTMLAttributes, type MouseEventHandler, type MouseEvent } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { JoinProjectDialog } from '../src/client/ProjectDialog.tsx'

const captured = vi.hoisted(() => ({ join: undefined as MouseEventHandler<HTMLButtonElement> | undefined }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return { ...actual, Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
    if (props.children === 'projectJoin') captured.join = props.onClick
    return createElement(actual.Button, props)
  } }
})
afterEach(() => { cleanup(); captured.join = undefined })

it('does not assign a conversation when no destination has been selected', () => {
  const run = vi.fn()
  const openResult = vi.fn()
  const onClose = vi.fn()
  render(<JoinProjectDialog t={key => key} projects={[]} sessionId="ordinary" run={run} openResult={openResult} onClose={onClose} />)
  expect(captured.join).toBeDefined()
  act(() => { captured.join!({} as MouseEvent<HTMLButtonElement>) })
  expect(run).not.toHaveBeenCalled()
  expect(openResult).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})
