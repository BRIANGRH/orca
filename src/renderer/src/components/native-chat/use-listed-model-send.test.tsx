// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  getStructuredAgentSessionLaunchSelection: () => null
}))

import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
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

function stateWith(catalog: AgentSessionModelCatalogResult) {
  return applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
    CLAUDE_SESSION_OPTION_CATALOG,
    catalog,
    { newLaunch: true }
  )
}

function prepareWith(catalog: AgentSessionModelCatalogResult, accepts = true) {
  const ref = { current: stateWith(catalog) }
  const setStructuredOption = vi.fn(async (id: string, value: string) => {
    // The pick lands in the chat's state, as the real option path commits it.
    ref.current = commitStructuredAgentSessionOption(ref.current, id, value)
    return accepts
  })
  const { result } = renderHook(() =>
    useListedModelSend(
      ref,
      { kind: 'new', seedOptions: { model: 'claude-gone', effort: 'max' }, heldOptions: {} },
      'session-1',
      setStructuredOption
    )
  )
  return { prepare: result.current, setStructuredOption }
}

describe('the step before a send', () => {
  it('moves a gone model to the listed one, model then effort, once across two sends', async () => {
    const { prepare, setStructuredOption } = prepareWith(LISTED)
    await prepare()
    await prepare()
    expect(setStructuredOption.mock.calls).toEqual([
      ['model', 'opus[1m]'],
      ['effort', 'xhigh']
    ])
  })

  it('stops after a refused model', async () => {
    const { prepare, setStructuredOption } = prepareWith(LISTED, false)
    await prepare()
    expect(setStructuredOption).toHaveBeenCalledTimes(1)
  })

  const unverified: [string, AgentSessionModelCatalogResult][] = [
    ['still listing', { ...LISTED, listingInProgress: true }],
    ['behind a failed sign-in', { ...LISTED, unavailable: { reason: 'notSignedIn' } }],
    ['absent', { origin: 'unknown' }]
  ]
  it.each(unverified)('keeps the model while the list is %s', async (_name, catalog) => {
    const { prepare, setStructuredOption } = prepareWith(catalog)
    await prepare()
    expect(setStructuredOption).not.toHaveBeenCalled()
  })
})
