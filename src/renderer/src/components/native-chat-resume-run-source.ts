import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import {
  findStructuredAgentSessionReadOwner,
  getStructuredAgentSessionReadOwner,
  type StructuredAgentSessionReadOwner
} from './native-chat/structured-agent-session-read-owner'
import { subscribeStructuredReadOwner } from './native-chat/structured-agent-session-read-owner-registry'
import {
  resumeRunUserRequestConfirmed,
  resumeRunOrderedUserRequest,
  type ResumeRun
} from './native-chat-resume-run'
import type { NativeChatRestartOffer } from './native-chat-resume-on-restart-store'

import { readResumeRunSourceCursor } from './native-chat-resume-run-source-cursor'
const LOCAL = { kind: 'local' } as const
type Entry = ResumeRun['entries'][number]
/** Reuse visible readers; extra observation is admitted only after activity or withdrawal. */
export function watchResumeRunSource(deps: {
  current: () => ResumeRun | null
  publish: (run: ResumeRun) => void
  offer: () => NativeChatRestartOffer
  refresh: () => Promise<void>
}): { offerChanged: () => void; release: () => void } {
  let stopped = false
  const slots = new Map<
    string,
    {
      owner?: StructuredAgentSessionReadOwner
      unsubscribe?: () => void
      deactivate?: () => void
      ownRead?: boolean
      submissions?: readonly AgentJournalSubmission[]
      pending?: AgentJournalSubmission
      cut?: Entry['dismissal']
      baseline?: AgentJournalCursor
      readState?: ReturnType<StructuredAgentSessionReadOwner['getSnapshot']>['state']
    }
  >()
  const releases: (() => void)[] = []
  const checkpointQueue: string[] = []
  const checkpointing = new Set<string>()
  let readingCheckpoints = 0
  const activity = new Map<string, string>()
  const listedIds = () =>
    new Set([...deps.offer().candidates, ...deps.offer().failed].map((row) => row.sessionId))
  let previouslyListed = listedIds()
  const continued = new Set(
    deps
      .current()
      ?.continued?.filter((record) => record.outcome === 'continued')
      .map((record) => record.sessionId)
  )
  const entries = () =>
    stopped
      ? []
      : (deps.current()?.entries.filter((entry) => !continued.has(entry.candidate.sessionId)) ?? [])
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
  const detach = (id: string) => {
    const slot = slots.get(id)
    slots.delete(id)
    slot?.unsubscribe?.()
    slot?.deactivate?.()
  }
  const notice = (id: string) => {
    const slot = slots.get(id)
    const entry = entryFor(id)
    const state = slot?.owner?.getSnapshot().state
    if (!slot || !entry || !state || resumeRunUserRequestConfirmed(entry)) {
      detach(id)
      return
    }
    const epoch = state.epoch
    if (
      state.status === 'ready' &&
      epoch &&
      entry.sourceCursor &&
      (slot.submissions !== state.submissions ||
        slot.cut !== entry.dismissal ||
        slot.baseline !== entry.sourceCursor)
    ) {
      slot.submissions = state.submissions
      slot.cut = entry.dismissal
      slot.baseline = entry.sourceCursor
      slot.pending = undefined
      let submission: AgentJournalSubmission | undefined
      for (const record of state.submissions) {
        if (!resumeRunOrderedUserRequest(entry, epoch, record)) {
          continue
        }
        if (record.dispatchState === 'accepted' && record.providerItemId) {
          submission ??= record
        }
        if (
          record.dispatchState === 'pending' ||
          (record.dispatchState === 'unknown' && !record.recovered)
        ) {
          slot.pending ??= record
        }
      }
      if (
        submission &&
        entry.userRequest?.submission.clientMessageId !== submission.clientMessageId
      ) {
        change(id, (current) => ({
          ...current,
          userRequest: {
            epoch,
            submission: {
              ...submission,
              ...(submission.source ? { source: { ...submission.source } } : {})
            }
          }
        }))
        void deps.refresh()
      }
    }
    if (state.status === 'ready' && !entry.sourceCursor && state.cursor && !checkpointing.has(id)) {
      change(id, (current) =>
        current.sourceCursor ? current : { ...current, sourceCursor: state.cursor ?? undefined }
      )
      notice(id)
      return
    }
    if (
      slot.ownRead &&
      state !== slot.readState &&
      (state.status === 'error' ||
        (state.status === 'ready' && entry.sourceCursor && !slot.pending))
    ) {
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
    const slot: NonNullable<ReturnType<typeof slots.get>> = { owner }
    slots.set(id, slot)
    slot.unsubscribe = owner.subscribe(() => notice(id))
    notice(id)
  }
  const admit = (id: string) => {
    const entry = entryFor(id)
    if (!entry || resumeRunUserRequestConfirmed(entry)) {
      return
    }
    const existing = findStructuredAgentSessionReadOwner(id, LOCAL)
    const owner = existing ?? getStructuredAgentSessionReadOwner(id, LOCAL)
    attach(id, owner)
    const slot = slots.get(id)
    if (!slot || owner.hasActiveReaders() || slot.deactivate) {
      return
    }
    slot.ownRead = true
    slot.readState = owner.getSnapshot().state
    const deactivate = owner.activate()
    if (slots.get(id) !== slot) {
      deactivate()
    } else {
      slot.deactivate = deactivate
    }
  }
  const drain = () => {
    while (!stopped && readingCheckpoints < 4 && checkpointQueue.length > 0) {
      const id = checkpointQueue.shift()
      if (id === undefined) {
        break
      }
      readingCheckpoints += 1
      void readResumeRunSourceCursor(id)
        .then((cursor) => {
          if (cursor) {
            change(id, (entry) => (entry.sourceCursor ? entry : { ...entry, sourceCursor: cursor }))
          }
          const slot = slots.get(id)
          if (slot) {
            slot.submissions = undefined
          }
          notice(id)
        })
        .finally(() => {
          readingCheckpoints -= 1
          checkpointing.delete(id)
          notice(id)
          drain()
        })
    }
  }
  const checkpoint = (id: string) => {
    if (entryFor(id)?.sourceCursor || checkpointing.has(id)) {
      return
    }
    checkpointing.add(id)
    checkpointQueue.push(id)
    drain()
  }
  const offerChanged = () => {
    const offer = deps.offer()
    if (stopped || !offer.available) {
      return
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
      if (entry.userRequest) {
        change(id, (current) =>
          current.userRequest
            ? {
                ...current,
                userRequest: {
                  ...current.userRequest,
                  offer: {
                    listedAt: offer.listedAt,
                    candidate: offer.candidates.find((row) => row.sessionId === id),
                    failure: offer.failed.find((row) => row.sessionId === id)
                  }
                }
              }
            : current
        )
      }
      if (!listed.has(id) && withdrawn.has(id)) {
        admit(id)
      }
    }
  }
  const feed = getStructuredAgentSessionStatusFeed(LOCAL)
  const feedNotice = () => {
    for (const entry of entries()) {
      const id = entry.candidate.sessionId
      const status = feed.getSnapshot().get(id)
      const key = JSON.stringify([
        status?.status,
        status?.latestPrompt,
        status?.statusStartedAt,
        status?.hostExecutionOwned,
        status?.hostExecutionPhase
      ])
      const before = activity.get(id)
      activity.set(id, key)
      if (before !== undefined && before !== key) {
        admit(id)
      }
    }
  }
  for (const entry of entries()) {
    const id = entry.candidate.sessionId
    releases.push(subscribeStructuredReadOwner(id, LOCAL, (owner) => attach(id, owner)))
    attach(id, findStructuredAgentSessionReadOwner(id, LOCAL))
    checkpoint(id)
  }
  feedNotice()
  releases.push(feed.subscribe(feedNotice))
  // Current absence can admit a bounded read, but only a fresh answer qualifies newly found evidence.
  if (deps.offer().available) {
    for (const entry of entries()) {
      const id = entry.candidate.sessionId
      if (!previouslyListed.has(id)) {
        admit(id)
      }
    }
  }
  return {
    offerChanged,
    release: () => {
      stopped = true
      releases.forEach((release) => release())
      for (const id of slots.keys()) {
        detach(id)
      }
      checkpointQueue.length = 0
    }
  }
}
