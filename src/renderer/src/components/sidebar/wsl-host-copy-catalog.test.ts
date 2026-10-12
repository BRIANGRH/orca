import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why read the catalog: the shipped build resolves a key from en.json, not from the inline
// default, so changing copy under an existing key leaves the old words on screen.
const catalog: unknown = JSON.parse(
  readFileSync(join(__dirname, '../../i18n/locales/en.json'), 'utf8')
)

function lookup(path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) => (typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined),
    catalog
  )
}

const DIALOG = ['auto', 'components', 'sidebar', 'HostRemoveDialog']

describe('WSL host removal copy', () => {
  it('ships the copy that says removal ends the host’s terminals', () => {
    expect(lookup([...DIALOG, 'wslHostEndsTerminals'])).toBe(
      'Removes {{value0}} from Orca, ends its open terminals and stops Orca’s server in that distro. Files in the distro are untouched.'
    )
    expect(lookup([...DIALOG, 'wslHost'])).toBeUndefined()
  })
})
