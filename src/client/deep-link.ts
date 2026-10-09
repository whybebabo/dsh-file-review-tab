/**
 * Chat → sidebar deep-link channel.
 *
 * The chat turn-tail row knows which paths (and which turn) the user wants to
 * inspect, but better-sidebar's native right Sidebar mints its own tab ids and
 * does not refresh an already-open tab's `meta` (dsh-better-sidebar #632 /
 * 0.19.1 adapter behaviour). Passing a `path` seed is also unsafe there: the
 * native surface routes path-bearing opens to the file editor, so the review
 * tab would never mount.
 *
 * The channel therefore carries the seed inside this plugin: the chat row
 * publishes it and then opens the tab by type; the tab body subscribes and
 * replays whatever arrived, whether it mounted just now or was already open.
 * Sessions are keyed separately, and each publish gets a monotonic nonce so a
 * replay can never be mistaken for a fresh link.
 */

import { ARCHIVE_PAGE_TURNS } from './session-changes.ts'

/** One chat-issued review target inside a session. */
export interface FileReviewSeed {
  readonly paths: readonly string[]
  /** Turn anchor: expand only this turn's rows for the given paths. */
  readonly turn?: number
  /** Monotonic publish id; a new value means a new link to replay. */
  readonly nonce: number
}

/** A row a deep link resolved to, keyed the way the tab keys its state. */
export interface DeepLinkRow {
  readonly turn: number
  readonly path: string
}

/** Everything one replay must do, computed without touching component state. */
export interface DeepLinkPlan {
  /** Rows to expand, as `turn|path` state keys. */
  readonly expanded: readonly string[]
  /** The row to scroll to (the first match), or null when nothing matched. */
  readonly first: DeepLinkRow | null
  /**
   * Archive section to reveal: a link into an auto-archived turn must render
   * that turn before its row can be scrolled to. Null when the target is
   * already in the main list.
   */
  readonly archive: { readonly pages: number } | null
}

/** State-map key for one (turn, file) change group. */
function rowKey(turn: number, path: string): string {
  return `${turn}|${path}`
}

/**
 * Resolve a deep link against EVERY change the tab can render, including turns
 * still hidden behind a closed archive section.
 *
 * The target is deliberately resolved against the full change set rather than
 * the currently mounted rows. A link into an archived turn is replayed in the
 * same commit that opens the archive, so at that moment its rows are not
 * mounted yet; resolving against the mounted set made the match fail, the
 * pending scroll get cleared, and the link land nowhere with no retry.
 *
 * @param turns - Every turn, ascending (the source of truth for all rows).
 * @param archivedTurns - The auto-archived subset, newest first.
 * @param paths - Paths the link targets.
 * @param targetTurn - Turn anchor, or undefined for a path-only (legacy) link.
 * @returns The expand set, the scroll target, and the archive reveal to apply.
 */
export function planDeepLink(
  turns: readonly { readonly turn: number; readonly live: boolean; readonly files: readonly { readonly path: string }[] }[],
  archivedTurns: readonly { readonly turn: number }[],
  paths: readonly string[],
  targetTurn: number | undefined,
): DeepLinkPlan {
  const expanded: string[] = []
  let first: DeepLinkRow | null = null
  // `turns` is ascending; walk it in the tab's render order (newest first) so
  // `first` is the same row the previous mounted-set search would have picked.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn === undefined) continue
    for (const file of turn.files) {
      if (!paths.includes(file.path)) continue
      if (targetTurn !== undefined && turn.turn !== targetTurn) continue
      expanded.push(rowKey(turn.turn, file.path))
      first ??= { turn: turn.turn, path: file.path }
    }
  }

  let archive: { pages: number } | null = null
  if (first !== null) {
    const owner = turns.find(turn => turn.turn === first.turn)
    // A live turn never archives, so only a settled archived turn needs reveal.
    if (owner !== undefined && owner.live !== true) {
      const archivedIndex = archivedTurns.findIndex(turn => turn.turn === first.turn)
      if (archivedIndex !== -1) {
        archive = { pages: Math.ceil((archivedIndex + 1) / ARCHIVE_PAGE_TURNS) }
      }
    }
  }
  return { expanded, first, archive }
}

type SeedListener = (sessionId: string, seed: FileReviewSeed) => void
type InvalidationListener = (sessionId: string) => void

const latest = new Map<string, FileReviewSeed>()
const listeners = new Set<SeedListener>()
const invalidationListeners = new Set<InvalidationListener>()
let nonce = 0

/** Publish a deep link for one session and return the stored seed. */
export function publishFileReviewSeed(
  sessionId: string,
  paths: readonly string[],
  turn?: number,
): FileReviewSeed {
  nonce += 1
  const seed: FileReviewSeed = {
    paths: [...paths],
    ...(turn === undefined ? {} : { turn }),
    nonce,
  }
  latest.set(sessionId, seed)
  for (const listener of listeners) listener(sessionId, seed)
  return seed
}

/** The most recent seed for a session, if the tab has not consumed it yet. */
export function currentFileReviewSeed(sessionId: string): FileReviewSeed | undefined {
  return latest.get(sessionId)
}

/** Observe every publish; the caller filters by session. */
export function subscribeFileReviewSeed(listener: SeedListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Notify every mounted review surface that one session's disk state changed. */
export function publishFileReviewInvalidation(sessionId: string): void {
  for (const listener of invalidationListeners) listener(sessionId)
}

/** Observe disk-state invalidations issued by this plugin's review surfaces. */
export function subscribeFileReviewInvalidation(listener: InvalidationListener): () => void {
  invalidationListeners.add(listener)
  return () => { invalidationListeners.delete(listener) }
}
