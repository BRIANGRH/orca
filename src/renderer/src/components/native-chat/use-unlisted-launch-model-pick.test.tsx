// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { useUnlistedLaunchModelPick } from './use-unlisted-launch-model-pick'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))
const cold = createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
// Claude's session-less listing marks no default row.
const listed = applyStructuredAgentSessionModelCatalog(
  cold,
  CLAUDE_SESSION_OPTION_CATALOG,
  {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'opus[1m]', label: 'Opus', isDefault: false, efforts: levels('low', 'high', 'xhigh') },
      { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: levels('low', 'high') }
    ]
  },
  { newLaunch: true }
)
const remembered = { model: 'claude-gone', effort: 'max' }

type Props = {
  optionState: StructuredAgentSessionOptionState
  held?: Record<string, string>
  acceptsPicks?: boolean
}

function render(initial: Props) {
  const setStructuredOption = vi.fn(async (_id: string, _value: string) => true)
  const view = renderHook(
    (props: Props) =>
      useUnlistedLaunchModelPick({
        sessionId: 'session-1',
        optionState: props.optionState,
        launchSeed: remembered,
        held: props.held ?? {},
        acceptsPicks: props.acceptsPicks ?? true,
        setStructuredOption
      }),
    { initialProps: initial }
  )
  return { ...view, setStructuredOption }
}

describe('a new chat whose remembered Claude model the loaded list lacks', () => {
  it('picks the shown replacement once, model then the nearest effort', async () => {
    const { rerender, setStructuredOption } = render({ optionState: listed })
    await waitFor(() => expect(setStructuredOption).toHaveBeenCalledTimes(2))
    expect(setStructuredOption.mock.calls).toEqual([
      ['model', 'opus[1m]'],
      ['effort', 'xhigh']
    ])
    rerender({ optionState: { ...listed } })
    expect(setStructuredOption).toHaveBeenCalledTimes(2)
  })

  it('waits until the chat takes picks', async () => {
    const { rerender, setStructuredOption } = render({ optionState: listed, acceptsPicks: false })
    expect(setStructuredOption).not.toHaveBeenCalled()
    rerender({ optionState: listed, acceptsPicks: true })
    await waitFor(() => expect(setStructuredOption).toHaveBeenCalledWith('model', 'opus[1m]'))
  })

  it('leaves a model the user holds alone', () => {
    const { setStructuredOption } = render({ optionState: listed, held: { model: 'sonnet' } })
    expect(setStructuredOption).not.toHaveBeenCalled()
  })

  it('picks nothing while the list is loading or failed', () => {
    expect(render({ optionState: cold }).setStructuredOption).not.toHaveBeenCalled()
    const builtin = settleStructuredAgentSessionBuiltinCatalog(cold)
    expect(render({ optionState: builtin }).setStructuredOption).not.toHaveBeenCalled()
  })
})
