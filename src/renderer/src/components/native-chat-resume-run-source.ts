import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import {
  findStructuredAgentSessionReadOwner,
  getStructuredAgentSessionReadOwner,
  type StructuredAgentSessionReadOwner
} from './native-chat/structured-agent-session-read-owner'
import { subscribeStructuredReadOwner } from './native-chat/structured-agent-session-read-owner-registry'
import {
  subscribeStructuredSessionUserActions,
  type StructuredSessionUserAction,
  type UserRequestSubmission
} from './native-chat/structured-agent-session-user-actions'
import {
  resumeRunUserRequestConfirmed,
  resumeRunOrderedUserRequest,
  type ResumeRun
} from './native-chat-resume-run'
import type { NativeChatRestartOffer } from './native-chat-resume-on-restart-store'
import type { ResumeOfferReadRequest } from './native-chat-resume-offer-read'

import { createResumeSourceReadLeases } from './native-chat-resume-source-read-leases'
import {
  confirmResumeRunSource,
  hasLaterResumeRunSource
} from './native-chat-resume-run-confirmation'
import { watchResumeRunStatus, watchResumeRunActivity } from './native-chat-resume-run-status-watch'
export { RESUME_RUN_SOURCE_READ_BUDGET_MS } from './native-chat-resume-source-read-leases'
const LOCAL = { kind: 'local' } as const
type Entry = ResumeRun['entries'][number]
type ReadSlot = {
  owner: StructuredAgentSessionReadOwner
  unsubscribe?: () => void
  readState?: ReturnType<StructuredAgentSessionReadOwner['getSnapshot']>['state']
  submissions?: readonly AgentJournalSubmission[]
  action?: Entry['localAction']
  baseline?: Entry['sourceCursor']
}
/** Observe existing owners and actual actions; extra observation has a finite lifetime. */
export function watchResumeRunSource(deps: {
  current: () => ResumeRun | null
  publish: (run: ResumeRun) => void
  offer: () => NativeChatRestartOffer
  refresh: () => ResumeOfferReadRequest | undefined
}): { offerChanged: (issued: ResumeRun | null) => void; settled: () => void; release: () => void } {
  let stopped = false
  let reading: ResumeOfferReadRequest | undefined
  const slots = new Map<string, ReadSlot>()
  const releaseProgress = watchResumeRunStatus(deps.current, deps.publish)
  const releases: (() => void)[] = []
  const listedIds = () =>
    new Set([...deps.offer().candidates, ...deps.offer().failed].map((row) => row.sessionId))
  let previouslyListed = listedIds()
  const entries = () => {
    const run = stopped ? null : deps.current()
    const continued = new Set(
      run?.continued
        ?.filter((record) => record.outcome === 'continued')
        .map((record) => record.sessionId)
    )
    return run?.entries.filter((entry) => !continued.has(entry.candidate.sessionId)) ?? []
  }
  const entryFor = (id: string) => entries().find((entry) => entry.candidate.sessionId === id)
  const change = (id: string, update: (entry: Entry) => Entry) => {
    const run = stopped ? null : deps.current()
    if (!run) {
      return
    }
    const next = run.entries.map((entry) =>
      entry.candidate.sessionId === id ? update(entry) : entry
    )
    if (next.some((entry, index) => entry !== run.entries[index])) {
      deps.publish({ ...run, entries: next })
    }
  }
  const refresh = () => {
    if (stopped || reading?.current()) {
      return
    }
    const issued = deps.current()
    const read = deps.refresh()
    if (!read) {
      return
    }
    reading = read
    void read.result.finally(() => {
      if (reading !== read) {
        return
      }
      reading = undefined
      if (!stopped && hasLaterResumeRunSource(deps.current(), issued)) {
        refresh()
      }
    })
  }
  const remember = (
    id: string,
    epoch: string,
    submission: UserRequestSubmission,
    action?: StructuredSessionUserAction
  ) => {
    const entry = entryFor(id)
    if (
      !entry ||
      entry.userRequest ||
      !resumeRunOrderedUserRequest(entry, epoch, submission, action) ||
      submission.dispatchState !== 'accepted' ||
      !submission.providerItemId
    ) {
      return
    }
    change(id, (current) => ({
      ...current,
      userRequest: {
        epoch,
        action,
        submission: {
          ...submission,
          ...(submission.source ? { source: { ...submission.source } } : {})
        }
      }
    }))
    refresh()
  }
  const detach = (id: string) => {
    const slot = slots.get(id)
    slots.delete(id)
    slot?.unsubscribe?.()
    leases.release(id)
  }
  const notice = (id: string) => {
    const slot = slots.get(id)
    let entry = entryFor(id)
    if (!slot || !entry || resumeRunUserRequestConfirmed(entry)) {
      detach(id)
      return
    }
    const state = slot.owner.getSnapshot().state
    if (state.status === 'ready' && state.cursor && !entry.sourceCursor) {
      change(id, (current) =>
        current.sourceCursor ? current : { ...current, sourceCursor: state.cursor ?? undefined }
      )
      entry = entryFor(id)
    }
    if (!entry) {
      return
    }
    let pending = false
    if (
      state.status === 'ready' &&
      state.epoch &&
      (slot.submissions !== state.submissions ||
        slot.action !== entry.localAction ||
        slot.baseline !== entry.sourceCursor)
    ) {
      slot.submissions = state.submissions
      slot.action = entry.localAction
      slot.baseline = entry.sourceCursor
      for (const submission of state.submissions) {
        if (!resumeRunOrderedUserRequest(entry, state.epoch, submission)) {
          continue
        }
        remember(
          id,
          state.epoch,
          submission,
          entry.localAction?.clientMessageId === submission.clientMessageId
            ? entry.localAction
            : undefined
        )
        pending ||=
          submission.dispatchState === 'pending' ||
          (submission.dispatchState === 'unknown' && !submission.recovered)
      }
      if (leases.has(id) && state !== slot.readState && !pending) {
        detach(id)
      }
    }
    if (state.status === 'error' && leases.has(id)) {
      detach(id)
    }
  }
  const attach = (id: string, owner: StructuredAgentSessionReadOwner | undefined) => {
    if (slots.get(id)?.owner === owner) {
      return
    }
    detach(id)
    const entry = entryFor(id)
    if (!owner || !entry || resumeRunUserRequestConfirmed(entry)) {
      return
    }
    const slot: ReadSlot = { owner }
    slots.set(id, slot)
    slot.unsubscribe = owner.subscribe(() => notice(id))
    notice(id)
  }
  const leases = createResumeSourceReadLeases({
    prepare: (id) => {
      const entry = entryFor(id)
      if (!entry || resumeRunUserRequestConfirmed(entry)) {
        return undefined
      }
      const owner =
        findStructuredAgentSessionReadOwner(id, LOCAL) ??
        getStructuredAgentSessionReadOwner(id, LOCAL)
      attach(id, owner)
      const slot = slots.get(id)
      if (!slot) {
        return undefined
      }
      slot.readState = owner.getSnapshot().state
      return owner
    },
    expired: detach
  })
  const admit = (id: string) => {
    const entry = entryFor(id)
    if (
      !entry ||
      resumeRunUserRequestConfirmed(entry) ||
      (deps.current()?.inFlight && !entry.localAction) ||
      leases.has(id)
    ) {
      return
    }
    leases.admit(id)
  }
  const offerChanged = (issued: ResumeRun | null) => {
    const offer = deps.offer()
    if (stopped || !offer.available) {
      return
    }
    const run = deps.current()
    if (run) {
      const next = confirmResumeRunSource(run, offer, issued)
      if (next !== run) {
        deps.publish(next)
      }
    }
    const listed = listedIds()
    const withdrawn = previouslyListed
    previouslyListed = listed
    for (const entry of entries()) {
      const id = entry.candidate.sessionId
      if (resumeRunUserRequestConfirmed(entry)) {
        detach(id)
        continue
      }
      if (!listed.has(id) && withdrawn.has(id)) {
        admit(id)
      }
    }
  }
  releases.push(
    subscribeStructuredSessionUserActions((observation) => {
      const { action } = observation
      const id = action.sessionId
      const entry = entryFor(id)
      if (!entry || resumeRunUserRequestConfirmed(entry)) {
        return
      }
      if (observation.kind === 'admitted') {
        change(id, (current) => ({ ...current, localAction: action }))
      } else if (
        observation.kind === 'issued' &&
        entry.localAction?.clientMessageId === action.clientMessageId
      ) {
        change(id, (current) => ({ ...current, localAction: action }))
        notice(id)
      } else if (
        observation.kind === 'accepted' &&
        entry.localAction?.clientMessageId === action.clientMessageId &&
        action.target?.kind === 'local'
      ) {
        remember(id, observation.epoch, observation.submission, action)
      }
    })
  )
  for (const entry of entries()) {
    const id = entry.candidate.sessionId
    releases.push(subscribeStructuredReadOwner(id, LOCAL, (owner) => attach(id, owner)))
    attach(id, findStructuredAgentSessionReadOwner(id, LOCAL))
  }
  releases.push(watchResumeRunActivity(entries, admit))
  return {
    offerChanged,
    settled: () => {
      releaseProgress()
      if (entries().some((entry) => entry.userRequest && !entry.userRequest.offer)) {
        refresh()
      }
    },
    release: () => {
      stopped = true
      releases.forEach((release) => release())
      releaseProgress()
      leases.dispose()
      for (const id of slots.keys()) {
        detach(id)
      }
    }
  }
}
