import { describe, expect, it } from 'vitest'
import { nearestAgentEffort, valuesOnListedModel } from './agent-session-unlisted-model'

const efforts = (...values: string[]) => values.map((value) => ({ value }))

describe('valuesOnListedModel', () => {
  const models = [
    { id: 'sonnet', efforts: efforts('low', 'medium') },
    { id: 'opus', isDefault: true, efforts: efforts('low', 'medium', 'high', 'xhigh') }
  ]

  it('moves a model the loaded list lacks to its default, effort to the nearest level', () => {
    expect(valuesOnListedModel({ model: 'gone', effort: 'max' }, models)).toEqual({
      model: 'opus',
      effort: 'xhigh'
    })
  })

  it('takes the first row when none is marked default', () => {
    const unmarked = models.map(({ isDefault: _default, ...row }) => row)
    expect(valuesOnListedModel({ model: 'gone', effort: 'high' }, unmarked)).toEqual({
      model: 'sonnet',
      effort: 'medium'
    })
  })

  it('drops an effort the default offers no level near', () => {
    expect(
      valuesOnListedModel({ model: 'gone', effort: 'max' }, [
        { id: 'haiku', isDefault: true, efforts: [] }
      ])
    ).toEqual({
      model: 'haiku'
    })
  })

  it('keeps a listed model, and any model while the list is empty', () => {
    const listed = { model: 'sonnet', effort: 'low' }
    expect(valuesOnListedModel(listed, models)).toBe(listed)
    const gone = { model: 'gone', effort: 'max' }
    expect(valuesOnListedModel(gone, [])).toBe(gone)
  })
})

describe('nearestAgentEffort', () => {
  it('keeps an offered level and takes the higher one on a tie', () => {
    expect(nearestAgentEffort('high', ['low', 'high'])).toBe('high')
    expect(nearestAgentEffort('medium', ['low', 'high'])).toBe('high')
  })

  it('names no level for one it cannot rank', () => {
    expect(nearestAgentEffort('turbo', ['low', 'high'])).toBeUndefined()
  })
})
