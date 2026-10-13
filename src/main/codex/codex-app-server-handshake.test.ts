// Codex names its version in its `initialize` answer; the connection keeps it for what depends on it.

import { describe, expect, it, vi } from 'vitest'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import {
  codexVersionFromInitialize,
  initializeCodexAppServerConnection
} from './codex-app-server-handshake'

describe("reading Codex's version from its handshake", () => {
  it("takes the version after the originator in the answer's userAgent", () => {
    expect(
      codexVersionFromInitialize({
        userAgent:
          'orca_desktop/0.159.0 (Mac OS 15.5.0; arm64) xterm-256color (orca_desktop; 0.0.0)'
      })
    ).toBe('0.159.0')
    expect(codexVersionFromInitialize({ userAgent: 'codex_cli_rs/0.142.0-alpha.3 (Linux)' })).toBe(
      '0.142.0-alpha.3'
    )
  })

  it('is null when the answer names no version', () => {
    for (const answer of [
      {},
      null,
      'codex',
      { userAgent: 42 },
      { userAgent: '' },
      { userAgent: 'codex_cli_rs/dev (Linux; 1.2.3)' }
    ]) {
      expect(codexVersionFromInitialize(answer)).toBeNull()
    }
  })

  it('answers the version once it has sent `initialized`', async () => {
    const notify = vi.fn()
    const request = vi.fn(async () => ({ userAgent: 'orca_desktop/0.160.1 (Windows 11; x86_64)' }))
    expect(await initializeCodexAppServerConnection({ request, notify })).toBe('0.160.1')
    expect(notify).toHaveBeenCalledWith('initialized')
  })

  it('keeps it on the connection to the child that answered', async () => {
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (message.method === 'initialize') {
          process.stdout.write(
            JSON.stringify({ id: message.id, result: { userAgent: 'orca_desktop/0.158.2 (test)' } }) + '\n'
          )
        }
      })
    `
    const connection = await openCodexAppServerConnection({
      command: process.execPath,
      args: ['-e', server]
    })
    try {
      expect(connection.codexVersion).toBe('0.158.2')
    } finally {
      await connection.close()
    }
  })
})
