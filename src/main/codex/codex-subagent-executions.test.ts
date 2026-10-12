import { describe, expect, it } from 'vitest'
import { CodexSubagentExecutions } from './codex-subagent-executions'

describe('CodexSubagentExecutions retention and identity', () => {
  it('bounds settled history through repeated execution without evicting live children', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('long-lived', 'long-lived', 'parent')
    executions.observeTurn('long-lived', 'long-lived-turn', 'working')
    for (let index = 0; index < 1_000; index++) {
      const id = `child-${index}`
      executions.observeTurn(id, id, 'working')
      executions.register(id, id, 'parent')
      executions.observeTurn(id, id, 'completed')
    }
    expect(executions.workingChildren().map((child) => child.agentThreadId)).toEqual(['long-lived'])
    const { children, settledTurns } = executions.retentionSizes()
    expect(children).toBeLessThanOrEqual(128)
    expect(settledTurns).toBeLessThanOrEqual(256)
  })

  it('keeps every running child past the settled-history bound', () => {
    const executions = new CodexSubagentExecutions()
    for (let index = 0; index < 200; index++) {
      expect(executions.observeTurn(`child-${index}`, `turn-${index}`, 'working')).not.toBeNull()
      executions.register(`child-${index}`, `child-${index}`, 'parent')
    }
    expect(executions.workingChildren()).toHaveLength(200)
    executions.observeTurn('child-0', 'turn-0', 'completed')
    executions.register('next', 'next', 'parent')
    expect(executions.find('child-0')).toBeUndefined()
    expect(executions.workingChildren()).toHaveLength(199)
  })

  it('corrects an unverifiable execution with its own terminal event and ignores stale starts', () => {
    const executions = new CodexSubagentExecutions()
    executions.register('child', 'child', 'parent')
    executions.observeTurn('child', 'turn', 'working')
    executions.closeThread('child')
    expect(executions.workingChildren()).toEqual([])
    expect(executions.observeTurn('child', 'turn', 'working')).toBeNull()
    expect(executions.observeTurn('child', 'turn', 'completed')?.execution.state).toBe('completed')
    executions.observeTurn('child', 'new-turn', 'working')
    executions.observeTurn('child', 'turn', 'failed')
    expect(executions.workingChildren()[0]?.execution?.turnId).toBe('new-turn')
    executions.clear()
    expect(executions.retentionSizes()).toEqual({ children: 0, settledTurns: 0 })
  })
})
