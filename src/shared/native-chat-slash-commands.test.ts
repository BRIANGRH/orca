import { describe, expect, it } from 'vitest'
import {
  applySlashSuggestion,
  filterSlashCommands,
  getAgentSlashCommands,
  isSlashCommandDraft,
  ORCA_NATIVE_CHAT_COMMANDS,
  parseOrcaNativeChatCommand,
  sessionReportedSkillNames,
  sessionSlashCommandSuggestions,
  slashCommandDispatchText,
  withOrcaNativeChatCommands
} from './native-chat-slash-commands'

describe('getAgentSlashCommands', () => {
  it('returns Codex-specific commands (e.g. /model, /resume) for codex', () => {
    const names = getAgentSlashCommands('codex').map((c) => c.name)
    expect(names).toContain('model')
    expect(names).toContain('resume')
    expect(names).toContain('diff')
  })

  it('returns Claude commands for claude (no Codex-only /model)', () => {
    const names = getAgentSlashCommands('claude').map((c) => c.name)
    expect(names).toContain('clear')
    expect(names).toContain('compact')
    expect(names).not.toContain('model')
    // Claude's terminal writes no /context reply the chat could show.
    expect(names).not.toContain('context')
  })

  it('offers OpenClaude /context, whose report lands in its transcript', () => {
    const names = getAgentSlashCommands('openclaude').map((c) => c.name)
    expect(names).toEqual([...getAgentSlashCommands('claude').map((c) => c.name), 'context'])
  })

  it('falls back to a small common set for an unknown agent (never empty)', () => {
    const names = getAgentSlashCommands('some-other-agent').map((c) => c.name)
    expect(names).toEqual(['clear', 'help'])
  })
})

describe('isSlashCommandDraft', () => {
  it('is true for a leading slash, even with leading whitespace', () => {
    expect(isSlashCommandDraft('/clear')).toBe(true)
    expect(isSlashCommandDraft('  /model')).toBe(true)
  })

  it('is false for ordinary prose or a mid-line slash', () => {
    expect(isSlashCommandDraft('fix the bug')).toBe(false)
    expect(isSlashCommandDraft('run a/b test')).toBe(false)
    expect(isSlashCommandDraft('')).toBe(false)
  })
})

describe('filterSlashCommands', () => {
  const codex = getAgentSlashCommands('codex')

  it('returns all commands for an empty query (bare /)', () => {
    expect(filterSlashCommands(codex, '')).toHaveLength(codex.length)
  })

  it('prefix-matches case-insensitively', () => {
    const names = filterSlashCommands(codex, 'mod').map((c) => c.name)
    expect(names).toEqual(['model'])
    expect(filterSlashCommands(codex, 'MOD').map((c) => c.name)).toEqual(['model'])
  })
})

describe('dispatch vs completion text', () => {
  it('dispatch text has no trailing space (Enter dispatches the command)', () => {
    expect(slashCommandDispatchText({ name: 'clear' })).toBe('/clear')
  })

  it('completion text has a trailing space (Tab completes for arguments)', () => {
    expect(applySlashSuggestion({ name: 'model' })).toBe('/model ')
  })
})

describe('a session that reports its own command surface', () => {
  const reported = [
    { name: 'clear', kind: 'command' as const },
    { name: 'opsx:apply', kind: 'command' as const },
    { name: 'ref-oss', kind: 'skill' as const }
  ]

  it('offers exactly the reported commands, described from the curated catalog', () => {
    expect(sessionSlashCommandSuggestions('claude', reported)).toEqual([
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'opsx:apply' }
    ])
  })

  it('does not resurrect a curated command the session never reported', () => {
    const names = sessionSlashCommandSuggestions('claude', reported).map((c) => c.name)
    expect(names).not.toContain('compact')
  })

  it('splits skills out for the picker to group on its own', () => {
    expect(sessionReportedSkillNames(reported)).toEqual(['ref-oss'])
  })

  it('prefers the description the session reported over the curated one', () => {
    expect(
      sessionSlashCommandSuggestions('claude', [
        { name: 'clear', kind: 'command', description: 'Wipe the transcript' },
        { name: 'goal', kind: 'command', description: 'Set or view the goal' },
        { name: 'compact', kind: 'command' }
      ])
    ).toEqual([
      { name: 'clear', description: 'Wipe the transcript' },
      { name: 'goal', description: 'Set or view the goal' },
      { name: 'compact', description: 'Summarize and compact the conversation' }
    ])
  })

  it('keeps a reported description and argument hint the curated catalog never claims', () => {
    expect(
      sessionSlashCommandSuggestions('codex', [
        {
          name: 'opsx:apply',
          kind: 'command',
          description: 'Apply the plan',
          argumentHint: '<plan-id>',
          kindUnspecified: true
        }
      ])
    ).toEqual([
      {
        name: 'opsx:apply',
        description: 'Apply the plan',
        argumentHint: '<plan-id>',
        kindUnspecified: true
      }
    ])
  })
})

describe('Orca-owned commands', () => {
  it('reads /resume only as the exact leading token', () => {
    expect(parseOrcaNativeChatCommand('/resume')).toEqual({ name: 'resume', argument: '' })
    expect(parseOrcaNativeChatCommand('/resume ')).toEqual({ name: 'resume', argument: '' })
    for (const draft of ['/resumex', '/resume-other', '/Resume', ' /resume', 'please /resume']) {
      expect(parseOrcaNativeChatCommand(draft)).toBeNull()
    }
  })

  it('passes the rest of the draft through as the search, whitespace-collapsed', () => {
    expect(parseOrcaNativeChatCommand('/resume  auth   retry ')).toEqual({
      name: 'resume',
      argument: 'auth retry'
    })
    // A line break after the token still never reaches the agent.
    expect(parseOrcaNativeChatCommand('/resume\nauth')).toEqual({
      name: 'resume',
      argument: 'auth'
    })
  })

  it("replaces a provider's own /resume row instead of listing it twice", () => {
    const codex = getAgentSlashCommands('codex')
    const composed = withOrcaNativeChatCommands(codex)
    expect(composed.filter(({ name }) => name === 'resume')).toEqual([ORCA_NATIVE_CHAT_COMMANDS[0]])
    expect(composed).toHaveLength(codex.length)
    expect(composed.slice(1)).toEqual(codex.filter(({ name }) => name !== 'resume'))
  })

  it('still offers its rows when the agent catalog is empty', () => {
    expect(withOrcaNativeChatCommands([])).toEqual(ORCA_NATIVE_CHAT_COMMANDS)
  })

  it('leaves agent catalogs themselves untouched for surfaces that do not compose them', () => {
    expect(getAgentSlashCommands('claude').map(({ name }) => name)).not.toContain('resume')
    expect(getAgentSlashCommands('omp').map(({ name }) => name)).toContain('resume')
  })
})
