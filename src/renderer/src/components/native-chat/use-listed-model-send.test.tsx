// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionOptionState } from '../../../../shared/structured-agent-session-options'
import { useListedModelSend } from './use-listed-model-send'

const LISTED: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  models: [
    {
      id: 'opus[1m]',
      label: 'Opus',
      isDefault: false,
      efforts: ['low', 'xhigh'].map((value) => ({ value, label: value }))
    }
  ]
}

function prepareWith(listed: AgentSessionModelCatalogResult | null, accepts = true) {
  const setStructuredOption = vi.fn(async (_id: string, _value: string) => accepts)
  const { result } = renderHook(() =>
    useListedModelSend(
      createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
      { kind: 'new', seedOptions: { model: 'claude-gone', effort: 'max' }, heldOptions: {} },
      listed,
      setStructuredOption
    )
  )
  return { prepare: result.current, setStructuredOption }
}

describe('the step before a send', () => {
  it('moves a gone model to the listed one, model first, then its effort', async () => {
    const { prepare, setStructuredOption } = prepareWith(LISTED)
    await prepare?.()
    expect(setStructuredOption.mock.calls).toEqual([
      ['model', 'opus[1m]'],
      ['effort', 'xhigh']
    ])
  })

  it('stops after a refused model, and has no step while no list has loaded', async () => {
    const refused = prepareWith(LISTED, false)
    await refused.prepare?.()
    expect(refused.setStructuredOption).toHaveBeenCalledTimes(1)
    expect(prepareWith({ origin: 'unknown' }).prepare).toBeUndefined()
    expect(prepareWith(null).prepare).toBeUndefined()
  })
})
