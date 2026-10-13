// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildNativeChatPickerItems } from './native-chat-picker-items'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { NATIVE_CHAT_SUPPORTED_AGENT_LIST } from '../../../../shared/native-chat-agent-support'
import {
  ORCA_NATIVE_CHAT_COMMANDS,
  sessionSlashCommandSuggestions,
  type SlashCommandSuggestion
} from '../../../../shared/native-chat-slash-commands'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'

function transport(sessionCommands?: NativeChatStructuredComposerTransport['sessionCommands']) {
  return { sessionCommands } as NativeChatStructuredComposerTransport
}

/** Orca's `/resume` row leads every desktop catalog. */
function withResume(commands: readonly SlashCommandSuggestion[]) {
  return [ORCA_NATIVE_CHAT_COMMANDS[0], ...commands.filter(({ name }) => name !== 'resume')]
}

describe('composer catalog authority', () => {
  it('keeps PTY and unsupported structured providers on their original catalogs', () => {
    const pty = renderHook(() => useNativeChatComposerCatalog('claude'))
    expect(pty.result.current.agentCommands).toEqual(
      withResume(getVerifiedNativeChatCommands('claude'))
    )
    expect(pty.result.current.sessionSkillNames).toBeUndefined()
    const oldHost = renderHook(() => useNativeChatComposerCatalog('claude', transport()))
    expect(oldHost.result.current.agentCommands).toEqual(withResume(structuredSlashCommands()))
    expect(oldHost.result.current.sessionSkillNames).toBeUndefined()
  })
  it('offers supported conversation commands when the host has no reported catalog', () => {
    const { result, rerender } = renderHook(
      ({ conversationCommands }) =>
        useNativeChatComposerCatalog('claude', { ...transport(), conversationCommands }),
      {
        initialProps: {
          conversationCommands: ['clear', 'compact'] as NonNullable<
            NativeChatStructuredComposerTransport['conversationCommands']
          >
        }
      }
    )
    expect(result.current.agentCommands.map(({ name }) => name)).toEqual([
      'resume',
      'model',
      'effort',
      'clear',
      'compact'
    ])
    rerender({ conversationCommands: ['clear'] })
    expect(result.current.agentCommands.map(({ name }) => name)).toEqual([
      'resume',
      'model',
      'effort',
      'clear'
    ])
  })
  // Codex reports no catalog, so the hook's fallback is its entire `/` menu; the
  // agent has to reach structuredSlashCommands or `/goal` is invisible there.
  it('offers Codex the commands its model runs from message text', () => {
    const { result } = renderHook(() => useNativeChatComposerCatalog('codex', transport()))
    expect(result.current.agentCommands).toEqual(withResume(structuredSlashCommands([], 'codex')))
    expect(result.current.agentCommands.map(({ name }) => name)).toContain('goal')
  })
  it('leaves the Claude route on its own commands, reported or not', () => {
    const reported = [{ name: 'init', kind: 'command' as const }]
    const withReport = renderHook(() => useNativeChatComposerCatalog('claude', transport(reported)))
    expect(withReport.result.current.agentCommands).toEqual(
      withResume(sessionSlashCommandSuggestions('claude', reported))
    )
    const withoutReport = renderHook(() => useNativeChatComposerCatalog('claude', transport()))
    expect(withoutReport.result.current.agentCommands.map(({ name }) => name)).toEqual([
      'resume',
      'model',
      'effort'
    ])
  })
  it('respects empty catalogs and command-only catalogs without reviving disk skills', () => {
    const { result, rerender } = renderHook(
      ({ reported }) => useNativeChatComposerCatalog('claude', transport(reported)),
      {
        initialProps: {
          reported: [] as NonNullable<NativeChatStructuredComposerTransport['sessionCommands']>
        }
      }
    )
    // Orca's own row is not the agent's catalog, so an empty report still offers it.
    expect(result.current).toEqual({
      agentCommands: [ORCA_NATIVE_CHAT_COMMANDS[0]],
      sessionSkillNames: []
    })
    rerender({ reported: [{ name: 'custom-command', kind: 'command' }] })
    expect(result.current).toEqual({
      agentCommands: [ORCA_NATIVE_CHAT_COMMANDS[0], { name: 'custom-command' }],
      sessionSkillNames: []
    })
  })
  it('offers exactly one /resume, Orca-owned, for every native-chat agent on both lanes', () => {
    for (const agent of NATIVE_CHAT_SUPPORTED_AGENT_LIST) {
      for (const lane of [undefined, transport(), transport([])]) {
        const { result } = renderHook(() => useNativeChatComposerCatalog(agent, lane))
        const rows = result.current.agentCommands.filter(({ name }) => name === 'resume')
        expect(rows).toEqual([ORCA_NATIVE_CHAT_COMMANDS[0]])
      }
    }
  })
  it("replaces a reported /resume, whether the host calls it a command or can't tell", () => {
    const { result } = renderHook(() =>
      useNativeChatComposerCatalog(
        'codex',
        transport([
          { name: 'resume', kind: 'command', description: 'Resume a saved chat' },
          { name: 'review', kind: 'command', kindUnspecified: true }
        ])
      )
    )
    expect(result.current.agentCommands).toEqual([
      ORCA_NATIVE_CHAT_COMMANDS[0],
      { name: 'review', description: 'Review the current changes', kindUnspecified: true }
    ])
  })
})

it('keeps a skill named resume out of the way of the Orca row', () => {
  const { result } = renderHook(() =>
    useNativeChatComposerCatalog(
      'claude',
      transport([
        { name: 'resume', kind: 'command', kindUnspecified: true },
        { name: 'resume', kind: 'skill' }
      ])
    )
  )
  const items = buildNativeChatPickerItems(
    result.current.agentCommands,
    [],
    'res',
    '/',
    result.current.sessionSkillNames
  )
  expect(items).toEqual([
    expect.objectContaining({ kind: 'command', name: 'resume', skillCollision: true })
  ])
})

it('Enter completes a known pre-init skill while still dispatching a built-in command', () => {
  const reported = [
    { name: 'clear', kind: 'command' as const, kindUnspecified: true as const },
    { name: 'project-skill', kind: 'command' as const, kindUnspecified: true as const }
  ]
  const complete = vi.fn(),
    dispatch = vi.fn()
  const { result, rerender } = renderHook(
    ({ activeSuggestion }) => {
      const catalog = useNativeChatComposerCatalog('claude', transport(reported))
      const items = buildNativeChatPickerItems(
        catalog.agentCommands,
        [
          {
            id: 'project-skill',
            name: 'project-skill',
            description: 'Project skill',
            providers: ['claude'],
            sourceKind: 'repo',
            sourceLabel: 'Project',
            rootPath: '/project/.claude/skills',
            directoryPath: '/project/.claude/skills/project-skill',
            skillFilePath: '/project/.claude/skills/project-skill/SKILL.md',
            installed: true,
            updatedAt: null
          }
        ],
        '',
        '/',
        catalog.sessionSkillNames
      )
      return useNativeChatComposerKeyDown({
        autocomplete: {
          mode: 'slash',
          query: '',
          items,
          triggerKey: '/',
          prefix: '/',
          dispatchable: true,
          grouped: true,
          commandsEnabled: true,
          skillsEnabled: true,
          skillStatus: 'ready'
        },
        mentionFiles: { files: [], loading: false, failed: false },
        completeMention: vi.fn(),
        activeSuggestion,
        draft: '/',
        isComposing: () => false,
        completePickerItem: complete,
        dispatchPickerCommand: dispatch,
        dismissPicker: vi.fn(),
        interrupt: vi.fn(),
        send: vi.fn(),
        setActiveSuggestion: vi.fn(),
        setDraft: vi.fn(),
        setCaret: vi.fn()
      })
    },
    // Orca's `/resume` leads the commands: resume, clear, then the skill.
    { initialProps: { activeSuggestion: 2 } }
  )
  const enter = { key: 'Enter', nativeEvent: {}, preventDefault: vi.fn() } as unknown as Parameters<
    typeof result.current
  >[0]
  result.current(enter)
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'project-skill', kind: 'skill' })
  )
  expect(dispatch).not.toHaveBeenCalled()
  rerender({ activeSuggestion: 1 })
  result.current(enter)
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ name: 'clear', kind: 'command' }))
})
