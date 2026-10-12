// The mode a start launches with: Claude's Approve for me needs its model listed for it in the saved
// catalog; anything the catalog cannot confirm launches Ask.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'

function record(provider: string, options: Record<string, string> | undefined): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch mode reads only the record's id, agent and options.
  return { sessionId: 'session-1', provider, ...(options ? { options } : {}) } as AgentSessionRecord
}

const listing = (
  models: { id: string; isDefault?: boolean; supportsAutoMode?: boolean }[]
): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 1,
  models: models.map((model) => ({
    label: model.id,
    efforts: [],
    isDefault: false,
    ...model
  }))
})

function launchPermission(
  provider: string,
  options: Record<string, string> | undefined,
  answer: AgentSessionModelCatalogResult | Error = { origin: 'unknown' },
  newChatPermissionMode?: () => unknown
) {
  const read = vi.fn(async () => {
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  })
  const modelCatalog = {
    read,
    recordLiveListing: vi.fn(),
    prewarm: vi.fn(async () => undefined),
    stop: vi.fn(),
    providerStarted: vi.fn()
  }
  return {
    read,
    result: structuredAgentSessionLaunchPermission(
      {
        agents: claudeAndCodexDeclared(),
        modelCatalog,
        ...(newChatPermissionMode ? { newChatPermissionMode } : {})
      },
      record(provider, options)
    )
  }
}

describe('the permission mode a chat starts with', () => {
  it('launches a saved mode that needs no model as it is, without reading the catalog', async () => {
    const claude = launchPermission('claude', { permissionMode: 'accept-edits' })
    await expect(claude.result).resolves.toBe('accept-edits')
    expect(claude.read).not.toHaveBeenCalled()
    const codex = launchPermission('codex', { permissionMode: 'auto' })
    await expect(codex.result).resolves.toBe('auto')
    expect(codex.read).not.toHaveBeenCalled()
  })

  it('asks for a chat saved before modes existed when the host has no new-chat setting', async () => {
    await expect(launchPermission('claude', undefined).result).resolves.toBe('ask')
  })

  it('runs the new-chat setting for a chat saved before modes existed, read per call', async () => {
    let setting = 'full-access'
    const read = (): unknown => setting
    await expect(launchPermission('claude', undefined, undefined, read).result).resolves.toBe(
      'full-access'
    )
    await expect(
      launchPermission('codex', { model: 'gpt-5' }, undefined, read).result
    ).resolves.toBe('full-access')
    setting = 'ask'
    await expect(launchPermission('codex', undefined, undefined, read).result).resolves.toBe('ask')
  })

  it('narrows the new-chat setting to what the agent offers', async () => {
    const acceptEdits = (): unknown => 'accept-edits'
    await expect(
      launchPermission('claude', undefined, undefined, acceptEdits).result
    ).resolves.toBe('accept-edits')
    await expect(launchPermission('codex', undefined, undefined, acceptEdits).result).resolves.toBe(
      'ask'
    )
    // Approve for me still needs a model listed for it, as a saved choice does.
    await expect(
      launchPermission('claude', undefined, undefined, () => 'auto').result
    ).resolves.toBe('ask')
  })

  it('keeps a chat saved choice over the new-chat setting', async () => {
    await expect(
      launchPermission('claude', { permissionMode: 'ask' }, undefined, () => 'full-access').result
    ).resolves.toBe('ask')
  })

  it('runs Claude auto on a model the saved catalog lists as supporting it', async () => {
    const supported = launchPermission(
      'claude',
      { permissionMode: 'auto', model: 'opus' },
      listing([{ id: 'opus', supportsAutoMode: true }])
    )
    await expect(supported.result).resolves.toBe('auto')
    expect(supported.read).toHaveBeenCalledWith(expect.objectContaining({ savedOnly: true }))
  })

  it('matches a chat with no model to the listed default', async () => {
    await expect(
      launchPermission(
        'claude',
        { permissionMode: 'auto' },
        listing([
          { id: 'sonnet', isDefault: true, supportsAutoMode: false },
          { id: 'opus', supportsAutoMode: true }
        ])
      ).result
    ).resolves.toBe('ask')
  })

  it('asks when the catalog cannot confirm the model runs auto', async () => {
    for (const answer of [
      { origin: 'unknown' } as const,
      listing([{ id: 'opus' }]),
      listing([{ id: 'sonnet', supportsAutoMode: true }]),
      new Error('catalog unavailable')
    ]) {
      await expect(
        launchPermission('claude', { permissionMode: 'auto', model: 'opus' }, answer).result
      ).resolves.toBe('ask')
    }
  })

  it('has none for an agent with no modes', async () => {
    await expect(launchPermission('grok', { permissionMode: 'full-access' }).result).resolves.toBe(
      null
    )
  })
})
