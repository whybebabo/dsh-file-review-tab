/**
 * Client cache and hook for the Host's per-mutation hunk coordinates.
 *
 * The comparison surfaces read the conversation snapshot, and its hunks are the
 * engine's context fragments — text only, no line numbers. Numbering those from
 * 1 puts a change at the end of a long file on "line 1". The Host recorded each
 * mutation's real coordinates at settlement (see the node half's hunk-anchors
 * module); this module fetches them once per session and hands them to the
 * renderer.
 *
 * Deliberately a cache rather than view state: a call's coordinates never change
 * once recorded, so the sidebar tab, a chat hover preview and every remount reuse
 * the same answer. Only the FIRST lookup of a call id costs a round trip, and a
 * call the recorder never saw stays marked as asked — a session whose mutations
 * happened outside the tool pipeline must not turn every render into a request.
 */

import { useEffect, useMemo, useState } from 'react'
import type { AnchorCall, RecordedAnchor } from '../change-types.ts'
import type { ProducedFileDiff } from '../change-types.ts'
import type { HunkAnchorLookup } from './diff-hunks.ts'

/** Immutable per-session lookup: a new map identity whenever it gains entries. */
const anchorsBySession = new Map<string, HunkAnchorLookup>()

/** Call ids already asked about, including the ones the Host had nothing for. */
const askedBySession = new Map<string, Set<string>>()

const EMPTY: HunkAnchorLookup = new Map()

/**
 * Group one file's hunks into the calls that produced them.
 *
 * Fragments of a call are consecutive and keep the engine's hunk order, so this
 * both names the calls to ask about and supplies the text the Host needs to place
 * a hunk whose coordinates were never recorded. Hunks without a call id (the
 * recorded Code Mode path, which already carries coordinates) are skipped.
 * @param diffs - the file's hunks, in settlement order.
 * @returns one entry per call, in first-seen order.
 */
export function anchorCalls(diffs: readonly ProducedFileDiff[]): AnchorCall[] {
  const byCall = new Map<string, { path: string; hunks: { oldText: string | null; newText: string }[] }>()
  for (const diff of diffs) {
    if (diff.callId === undefined) continue
    let call = byCall.get(diff.callId)
    if (call === undefined) {
      call = { path: diff.path, hunks: [] }
      byCall.set(diff.callId, call)
    }
    call.hunks.push({ oldText: diff.oldText, newText: diff.newText })
  }
  return [...byCall.entries()].map(([callId, call]) => ({ callId, path: call.path, hunks: call.hunks }))
}

/**
 * Coordinates remembered for one session, as the lookup the renderer takes.
 * @param sessionId - the session whose anchors are wanted.
 * @returns the cached map (empty before any lookup completes).
 */
export function cachedHunkAnchors(sessionId: string): HunkAnchorLookup {
  return anchorsBySession.get(sessionId) ?? EMPTY
}

/** Merge a Host answer into the cache and return the new lookup. */
export function rememberHunkAnchors(
  sessionId: string,
  entries: readonly RecordedAnchor[],
): HunkAnchorLookup {
  const next = new Map(anchorsBySession.get(sessionId) ?? [])
  for (const entry of entries) next.set(entry.callId, entry.anchors)
  anchorsBySession.set(sessionId, next)
  return next
}

/**
 * Drop a session's cache. Called when a session is disposed: a later session can
 * reuse neither the id nor the call ids.
 * @param sessionId - the session leaving.
 */
export function forgetHunkAnchors(sessionId: string): void {
  anchorsBySession.delete(sessionId)
  askedBySession.delete(sessionId)
}

/**
 * Claim the ids that still need a lookup, marking them as asked.
 *
 * Claiming before the request is what stops two surfaces painting the same hunk
 * in one commit from fetching it twice. An id marked this way is never asked
 * again unless {@link releaseCallIds} returns it: a call the recorder never saw
 * answers successfully with no coordinates, and that must not become a request
 * per render.
 * @param sessionId - session key for the shared cache.
 * @param callIds - the calls the painted hunks came from.
 * @returns the ids to ask about now; empty when nothing new is wanted.
 */
export function claimCallIds(sessionId: string, callIds: readonly string[]): string[] {
  const asked = askedFor(sessionId)
  const wanted: string[] = []
  for (const id of callIds) {
    if (asked.has(id) || wanted.includes(id)) continue
    asked.add(id)
    wanted.push(id)
  }
  return wanted
}

/**
 * Un-claim ids whose lookup failed.
 *
 * A thrown lookup is NOT the Host saying "this call has no coordinates" — it is
 * the Host not answering (an unmounted Remote, a transport error). Releasing the
 * ids is what lets a later attempt (new hunks, a now-visible tab, a remount) ask
 * again instead of leaving those hunks permanently unanchored.
 * @param sessionId - session key for the shared cache.
 * @param callIds - the ids whose request failed.
 */
export function releaseCallIds(sessionId: string, callIds: readonly string[]): void {
  const asked = askedFor(sessionId)
  for (const id of callIds) asked.delete(id)
}

/** The ids of one session already looked up (recorded or not). */
function askedFor(sessionId: string): Set<string> {
  const existing = askedBySession.get(sessionId)
  if (existing !== undefined) return existing
  const created = new Set<string>()
  askedBySession.set(sessionId, created)
  return created
}

/**
 * Coordinates for the calls a set of painted hunks came from, fetched on demand.
 *
 * Call it unconditionally from the component that draws the hunks; the request
 * lives in an effect, so a surface that never paints a diff never asks the Host.
 * @param sessionId - session key for the shared cache.
 * @param callIds - the calls the painted hunks came from, in any order.
 * @param load - Host lookup; undefined while the Remote is unavailable.
 * @param enabled - false pauses the lookup (a hidden tab, a closed preview).
 * @returns the lookup `toNativeHunks` takes.
 */
export function useHunkAnchors(
  sessionId: string,
  callIds: readonly string[],
  load: ((ids: readonly string[]) => Promise<readonly RecordedAnchor[]>) | undefined,
  enabled = true,
): HunkAnchorLookup {
  // The DISTINCT set of ids is the only thing that can require another request;
  // joining it into a string keeps the effect's dependency list stable even
  // though callers rebuild the array on every render.
  const key = useMemo(() => [...new Set(callIds)].sort().join('\u0000'), [callIds])
  const [lookup, setLookup] = useState<HunkAnchorLookup>(() => cachedHunkAnchors(sessionId))

  useEffect(() => {
    setLookup(cachedHunkAnchors(sessionId))
  }, [sessionId])

  useEffect(() => {
    if (!enabled || load === undefined) return
    const wanted = claimCallIds(sessionId, key === '' ? [] : key.split('\u0000'))
    if (wanted.length === 0) return
    let active = true
    void load(wanted)
      .then((entries) => {
        if (active) setLookup(rememberHunkAnchors(sessionId, entries))
      })
      .catch(() => {
        // The Host never answered — not an answer about these calls, so release
        // them and let a later attempt ask again.
        releaseCallIds(sessionId, wanted)
      })
    return () => { active = false }
  }, [sessionId, key, enabled, load])

  return lookup
}