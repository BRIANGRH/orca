import { afterEach, expect, it, vi } from 'vitest'
import {
  captureLoginShellEnvironment,
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from './login-shell-environment'

afterEach(resetLoginShellEnvironmentCacheForTests)

it('shares concurrent probes only within the same shell and environment', async () => {
  const release = Promise.withResolvers<void>()
  const spawner = vi.fn(async (_shell: string, env: NodeJS.ProcessEnv) => {
    await release.promise
    return { PI_CONFIG_DIR: env.PROFILE_ROOT }
  })
  const first = { HOME: '/host/a', PROFILE_ROOT: '.first' }
  const second = { HOME: '/host/a', PROFILE_ROOT: '.second' }
  const pending = [
    resolveLoginShellEnvironment({ shellOverride: '/bin/bash', env: first, spawner }),
    resolveLoginShellEnvironment({ shellOverride: '/bin/bash', env: second, spawner }),
    ...Array.from({ length: 20 }, () =>
      resolveLoginShellEnvironment({
        shellOverride: '/bin/bash',
        env: { PROFILE_ROOT: '.first', HOME: '/host/a' },
        spawner
      })
    )
  ]
  expect(spawner).toHaveBeenCalledTimes(2)
  release.resolve()
  const values = await Promise.all(pending)
  expect(values[0]?.PI_CONFIG_DIR).toBe('.first')
  expect(values[1]?.PI_CONFIG_DIR).toBe('.second')
  expect(values.slice(2).every((value) => value.PI_CONFIG_DIR === '.first')).toBe(true)
  await resolveLoginShellEnvironment({ shellOverride: '/bin/zsh', env: first, spawner })
  expect(spawner).toHaveBeenCalledTimes(3)
})

it('falls back to the supplied execution environment when its shell probe fails', async () => {
  const env = { HOME: '/execution-host', PI_CONFIG_DIR: '.execution-root' }
  const spawner = vi.fn(async () => {
    throw new Error('probe failed')
  })
  await expect(
    resolveLoginShellEnvironment({ shellOverride: '/bin/bash', env, spawner })
  ).resolves.toEqual(env)
})

it('bounds retained environments and supports explicit refresh', async () => {
  const spawner = vi.fn(async (_shell: string, env: NodeJS.ProcessEnv) => env)
  for (let index = 0; index < 10; index++) {
    await resolveLoginShellEnvironment({
      shellOverride: '/bin/bash',
      env: { HOME: `/host/${index}` },
      spawner
    })
  }
  await resolveLoginShellEnvironment({
    shellOverride: '/bin/bash',
    env: { HOME: '/host/0' },
    spawner
  })
  expect(spawner).toHaveBeenCalledTimes(11)
  await resolveLoginShellEnvironment({
    shellOverride: '/bin/bash',
    env: { HOME: '/host/0' },
    spawner,
    force: true
  })
  expect(spawner).toHaveBeenCalledTimes(12)
})

it('says whether the shell produced the env, and a failed forced capture keeps the cached one', async () => {
  const env = { HOME: '/host' }
  const spawner = vi
    .fn<(shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>>()
    .mockResolvedValueOnce({ PATH: '/profile/bin' })
    .mockResolvedValueOnce(null)
  const options = { shellOverride: '/bin/bash', env, spawner }
  await expect(captureLoginShellEnvironment(options)).resolves.toEqual({
    status: 'captured',
    env: { PATH: '/profile/bin' }
  })
  await expect(captureLoginShellEnvironment({ ...options, force: true })).resolves.toEqual({
    status: 'fallback',
    env
  })
  await expect(resolveLoginShellEnvironment(options)).resolves.toEqual({ PATH: '/profile/bin' })
  expect(spawner).toHaveBeenCalledTimes(2)
})

it('serves the cached env to other readers while a forced capture runs', async () => {
  const release = Promise.withResolvers<NodeJS.ProcessEnv | null>()
  const spawner = vi
    .fn<(shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>>()
    .mockResolvedValueOnce({ PATH: '/first' })
    .mockReturnValueOnce(release.promise)
  const options = { shellOverride: '/bin/bash', env: { HOME: '/host' }, spawner }
  await resolveLoginShellEnvironment(options)
  const forced = resolveLoginShellEnvironment({ ...options, force: true })
  const tick = new Promise((resolve) => setImmediate(() => resolve('still waiting')))
  await expect(Promise.race([resolveLoginShellEnvironment(options), tick])).resolves.toEqual({
    PATH: '/first'
  })
  release.resolve({ PATH: '/second' })
  await expect(forced).resolves.toEqual({ PATH: '/second' })
  await expect(resolveLoginShellEnvironment(options)).resolves.toEqual({ PATH: '/second' })
  expect(spawner).toHaveBeenCalledTimes(2)
})

it('serves a cached fallback to other readers while a forced capture runs', async () => {
  const release = Promise.withResolvers<NodeJS.ProcessEnv | null>()
  const spawner = vi
    .fn<(shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>>()
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(release.promise)
  const env = { HOME: '/host' }
  const options = { shellOverride: '/bin/bash', env, spawner }
  await expect(captureLoginShellEnvironment(options)).resolves.toMatchObject({ status: 'fallback' })
  const forced = resolveLoginShellEnvironment({ ...options, force: true })
  const tick = new Promise((resolve) => setImmediate(() => resolve('still waiting')))
  await expect(Promise.race([resolveLoginShellEnvironment(options), tick])).resolves.toEqual(env)
  release.resolve({ PATH: '/profile/bin' })
  await expect(forced).resolves.toEqual({ PATH: '/profile/bin' })
  await expect(resolveLoginShellEnvironment(options)).resolves.toEqual({ PATH: '/profile/bin' })
  expect(spawner).toHaveBeenCalledTimes(2)
})

it('runs one forced capture at a time, so an older run never lands over a newer one', async () => {
  const runs = [
    Promise.withResolvers<NodeJS.ProcessEnv | null>(),
    Promise.withResolvers<NodeJS.ProcessEnv | null>()
  ]
  const spawner = vi
    .fn<(shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>>()
    .mockResolvedValueOnce({ PATH: '/first' })
    .mockReturnValueOnce(runs[0].promise)
    .mockReturnValueOnce(runs[1].promise)
  const options = { shellOverride: '/bin/bash', env: { HOME: '/host' }, spawner }
  await resolveLoginShellEnvironment(options)
  const forced = [
    resolveLoginShellEnvironment({ ...options, force: true }),
    resolveLoginShellEnvironment({ ...options, force: true })
  ]
  expect(spawner).toHaveBeenCalledTimes(2)
  runs[0].resolve({ PATH: '/newest' })
  await expect(Promise.all(forced)).resolves.toEqual([{ PATH: '/newest' }, { PATH: '/newest' }])
  // Had the second call started its own run, this older answer would now replace the newest.
  runs[1].resolve({ PATH: '/old' })
  await new Promise((resolve) => setImmediate(resolve))
  await expect(resolveLoginShellEnvironment(options)).resolves.toEqual({ PATH: '/newest' })
  // The next forced call after it settles runs the shell again.
  await expect(resolveLoginShellEnvironment({ ...options, force: true })).resolves.toEqual({
    PATH: '/old'
  })
  expect(spawner).toHaveBeenCalledTimes(3)
})
