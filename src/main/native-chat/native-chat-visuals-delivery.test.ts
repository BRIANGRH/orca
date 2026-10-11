import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_MAX_BYTES,
  NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE,
  parseNativeChatVisualDirectiveLine
} from '../../shared/native-chat-visual-directive'
import { NATIVE_CHAT_VISUAL_THEME_TOKENS } from '../../shared/native-chat-visual-shell'
import { ORCAD_NATIVE_CHAT_VISUALS_ARTIFACTS } from '../../shared/orcad-artifacts'
import { createNativeChatVisualsDelivery } from './native-chat-visuals-delivery'
import {
  NATIVE_CHAT_VISUALS_SKILL_NAME,
  resetNativeChatVisualsSkillLocationForTests,
  resolveNativeChatVisualsSkillLocation
} from './native-chat-visuals-skill-location'

const RESOURCE_DIR = join(__dirname, '..', '..', '..', 'resources', 'native-chat-visuals')
const SKILL_TEXT = readFileSync(
  join(RESOURCE_DIR, 'skills', NATIVE_CHAT_VISUALS_SKILL_NAME, 'SKILL.md'),
  'utf8'
)
const SKILL = { pluginDir: '/app/plugin', skillsRoot: '/app/plugin/skills' }

const scratch: string[] = []
afterEach(() => {
  resetNativeChatVisualsSkillLocationForTests()
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-visuals-delivery-'))
  scratch.push(dir)
  return dir
}

const logger = () => ({ warn: vi.fn(), error: vi.fn() })

describe('preparing a chat for visuals', () => {
  it('reads the preference for each launch and prepares nothing while it is off', async () => {
    let enabled = false
    const resolveSkill = vi.fn(async () => SKILL)
    const prepare = createNativeChatVisualsDelivery({
      logger: logger(),
      isEnabled: () => enabled,
      resolveSkill
    })
    await expect(prepare('disabled-chat')).resolves.toBeNull()
    expect(resolveSkill).not.toHaveBeenCalled()
    enabled = true
    await expect(prepare('enabled-chat')).resolves.toEqual({ skill: SKILL })
    enabled = false
    await expect(prepare('next-chat')).resolves.toBeNull()
    expect(resolveSkill).toHaveBeenCalledOnce()
  })

  it('leaves the chat without visuals when the skill is missing or cannot be found', async () => {
    const missingSkill = logger()
    await expect(
      createNativeChatVisualsDelivery({
        logger: missingSkill,
        resolveSkill: async () => null
      })('chat-1')
    ).resolves.toBeNull()
    expect(missingSkill.warn).toHaveBeenCalledOnce()
    const failed = logger()
    await expect(
      createNativeChatVisualsDelivery({
        logger: failed,
        resolveSkill: async () => {
          throw new Error('unreadable install')
        }
      })('chat-1')
    ).resolves.toBeNull()
    expect(failed.warn).toHaveBeenCalledWith(
      'native-chat visuals skill could not be prepared',
      expect.objectContaining({ scope: 'nativeChatVisuals.skill', sessionId: 'chat-1' })
    )
  })
})

describe('the bundled skill', () => {
  it('is found in a checkout, and a missing install is not remembered', async () => {
    await expect(resolveNativeChatVisualsSkillLocation([tempDir()])).resolves.toBeNull()
    await expect(resolveNativeChatVisualsSkillLocation([tempDir(), RESOURCE_DIR])).resolves.toEqual(
      { pluginDir: RESOURCE_DIR, skillsRoot: join(RESOURCE_DIR, 'skills') }
    )
  })

  it('ships every file in the headless server build too', () => {
    const shipped = ORCAD_NATIVE_CHAT_VISUALS_ARTIFACTS.map((file) =>
      file.slice('native-chat-visuals/'.length)
    )
    expect(shipped).toEqual([
      '.claude-plugin/plugin.json',
      `skills/${NATIVE_CHAT_VISUALS_SKILL_NAME}/SKILL.md`
    ])
    const manifest = JSON.parse(readFileSync(join(RESOURCE_DIR, shipped[0]!), 'utf8'))
    expect(manifest.name).toMatch(/^[a-z0-9-]+$/)
  })

  it('teaches the reply line the renderer parses, with its limits', () => {
    const example = SKILL_TEXT.split('\n').find((line) => line.startsWith('::orca-visual{'))
    expect(example && parseNativeChatVisualDirectiveLine(example)).toEqual({
      path: 'reports/latency-by-region.html',
      legacy: false,
      title: 'Latency by region'
    })
    expect(SKILL_TEXT).toContain(`At most ${NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE} per reply`)
    expect(SKILL_TEXT).toContain(`under ${NATIVE_CHAT_VISUAL_MAX_BYTES / 1024} KB`)
    expect(SKILL_TEXT).not.toContain('ORCA_CHAT_VISUALS_DIR')
    expect(SKILL_TEXT).toMatch(new RegExp(`^name: ${NATIVE_CHAT_VISUALS_SKILL_NAME}$`, 'm'))
  })

  it('names only theme variables the visual frame sets', () => {
    const named = [...SKILL_TEXT.matchAll(/`(--[a-z0-9-]+)`/g)].map(([, name]) => name)
    const ranges = [...SKILL_TEXT.matchAll(/`--chart-1` to `--chart-(\d)`/g)].flatMap(([, last]) =>
      Array.from({ length: Number(last) }, (_, index) => `--chart-${index + 1}`)
    )
    expect(named.length).toBeGreaterThan(0)
    const frameTokens: readonly string[] = NATIVE_CHAT_VISUAL_THEME_TOKENS
    expect([...named, ...ranges].filter((name) => !frameTokens.includes(name))).toEqual([])
  })
})
