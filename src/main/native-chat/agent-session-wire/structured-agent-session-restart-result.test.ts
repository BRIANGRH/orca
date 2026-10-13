import { expect, it, vi } from 'vitest'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

it('an ordinary held-card Send produces client provenance and withdraws the restart failure', async () => {
  const state = await interruptedRestart('queued-cards')
  state.acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const first = await state.host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(first.continued).toMatchObject([{ outcome: 'refused' }])
  expect(first.failed).toHaveLength(1)
  const before = await state.host.history({ sessionId: SESSION, direction: 'tail' })
  const messageId = before.page.queuedMessages?.[0]?.messageId
  if (!before.ok || !before.page.liveCursor || !messageId || !first.failed?.[0]) {
    throw new Error('Missing card/failure/source baseline')
  }
  const sent = await state.host.queuedMessageSend(CALLER, {
    messageId,
    envelope: envelope('agentSession.queuedMessageSend', { messageId })
  })
  expect(sent).toMatchObject({ ok: true })
  await vi.waitFor(
    async () =>
      expect(
        (await state.host.journalSnapshot(SESSION)).submissions.find(
          (entry) => entry.queuedMessageId === messageId
        )
      ).toMatchObject({ dispatchState: 'accepted', providerItemId: expect.any(String) }),
    { timeout: 10000 }
  )
  await vi.waitFor(async () => expect(await state.host.restartResume.listFailures()).toEqual([]), {
    timeout: 10000
  })
  const submission = (await state.host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.queuedMessageId === messageId
  )
  if (!submission) {
    throw new Error('No produced submission')
  }
  expect.soft(submission.origin).toBe('client')
  expect.soft(submission.submittedSequence).toBeGreaterThan(before.page.liveCursor.sequence)
  expect(submission.source).toBeUndefined()
})

it('the ready child can accept a manual Send while its original refusal remains until Dismiss', async () => {
  const state = await interruptedRestart('turn', false)
  const { agentSessionFailureFact } = await import('../../../shared/agent-session-failure')
  const { agentSessionFailureWords } = await import('../../../shared/agent-session-failure-words')
  const { hostTestMessage } = await import('./structured-agent-session-host-test-data')
  state.dispatch.mockResolvedValueOnce({
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('providerRejected', {
        detail: { text: 'refused continuation', audience: 'log' }
      }),
      { surface: 'rejection' }
    )
  })
  const original = await state.host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(original.continued).toMatchObject([{ outcome: 'refused' }])
  expect(state.acquire).toHaveBeenCalledOnce()
  const body = hostTestMessage('Continue with my changes')
  const params = {
    body,
    userSend: true as const,
    envelope: envelope('agentSession.send', { body })
  }
  expect(await state.host.send(CALLER, params)).toMatchObject({ ok: true })
  await vi.waitFor(
    async () =>
      expect(
        (await state.host.journalSnapshot(SESSION)).submissions.find(
          (record) => record.clientMessageId === params.envelope.clientOperationId
        )
      ).toMatchObject({
        dispatchState: 'accepted',
        source: { kind: 'user' },
        providerItemId: expect.any(String)
      }),
    { timeout: 10000 }
  )
  expect(state.acquire).toHaveBeenCalledOnce()
  expect(await state.host.restartResume.listFailures()).toHaveLength(1)
  await state.host.restartResume.dismiss([SESSION])
  expect(await state.host.restartResume.listFailures()).toEqual([])
})

it('an in-progress host reservation lists empty before later filing its refused continuation', async () => {
  const state = await interruptedRestart('turn', false)
  const { agentSessionFailureFact } = await import('../../../shared/agent-session-failure')
  const { agentSessionFailureWords } = await import('../../../shared/agent-session-failure-words')
  const delayed = Promise.withResolvers<Awaited<ReturnType<typeof state.dispatch>>>()
  state.dispatch.mockReturnValueOnce(delayed.promise)
  const pending = state.host.restartResume.continueAfterRestart([SESSION], 'modal')
  await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce(), { timeout: 10000 })
  expect(await state.host.restartResume.list()).toEqual([])
  expect(await state.host.restartResume.listFailures()).toEqual([])
  delayed.resolve({
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('providerRejected', {
        detail: { text: 'refused continuation', audience: 'log' }
      }),
      { surface: 'rejection' }
    )
  })
  expect((await pending).continued).toMatchObject([{ outcome: 'refused' }])
  expect(await state.host.restartResume.listFailures()).toHaveLength(1)
})
