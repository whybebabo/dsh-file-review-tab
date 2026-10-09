/**
 * Session-wide produced-file derivation from a finalized ConversationSnapshot.
 *
 * dsh 0.1.5 removed the pre-rendered `callView` from `ToolResultNode`; the
 * mutation facts now live in the call head (`call.name` + `call.argsRaw`) and
 * the tool-private result metadata (`meta.diffs`). This module folds those
 * into per-turn file changes for the sidebar tab, walking the settled tool
 * nodes and, recursively, their Code Mode (`run_code`) sub-calls. Turn
 * attribution still rides the Chat snapshot's `turnEnds` / live counters.
 *
 * Client-only and model-free: the vocabulary is the mutation tools' own call
 * arguments and result metadata, never the closing prose.
 */
import type {
  ConversationSnapshot, ToolCallBlock, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ProducedFileDiff, RecordedMutation } from '../change-types.ts'
import { appliedDiffs, callIntent } from './mutation-call.ts'
import { appendMutation, flattenSettlements, orderBySequence, settlementsOf } from '../mutation-order.ts'
import { normalizeSnapshot } from './snapshot-compat.ts'
import { diffsFromBeforeAfter } from './recorded-diffs.ts'

/** One changed file inside one turn, hunks appended in settlement order. */
export interface SessionFileChange {
  readonly path: string
  readonly diffs: readonly ProducedFileDiff[]
  /** Terminal commands deleted this path in this turn (display-only). */
  readonly deleted?: true
  /**
   * Event sequence the pending deletion happened at. A deletion is an event, so
   * a cross-channel write with a LATER sequence proves the path was recreated
   * and clears the flag. Absent when the snapshot omitted the sequence, in which
   * case the deletion is kept (the conservative reading).
   */
  readonly deletedSeq?: number | undefined
}

/** One turn's produced files, in first-seen order. */
export interface TurnFileChanges {
  readonly turn: number
  /** Whether the owning turn is still running (its change set may grow). */
  readonly live: boolean
  readonly files: readonly SessionFileChange[]
}

/**
 * Internal per-path accumulator: the hunk list plus the last deletion state.
 *
 * `deletedSeq` is the event sequence the pending deletion happened at. A
 * deletion is an EVENT rather than a lasting property, so the sequence is what
 * lets a cross-channel merge tell whether a later write recreated the path.
 */
interface FileAccumulator {
  diffs: ProducedFileDiff[]
  deleted?: true
  deletedSeq?: number | undefined
}

/** One mutation extracted from a settled tool block. */
interface BlockChange {
  readonly path: string
  readonly diffs: readonly ProducedFileDiff[]
  readonly deleted?: true
}

/** A block's changes plus the event sequence that orders them in its turn. */
interface SequencedChange {
  readonly seq: number | undefined
  readonly change: BlockChange
}

/** The call head of a running or settled tool block, when it carries one. */
function callOf(block: ToolCallBlock): { readonly name: string; readonly argsRaw: string } | null {
  const record = block as {
    call?: { name?: unknown; argsRaw?: unknown } | null
    name?: unknown
    argsRaw?: unknown
  }
  if (record.call !== undefined && record.call !== null) {
    if (typeof record.call.name === 'string' && typeof record.call.argsRaw === 'string') {
      return { name: record.call.name, argsRaw: record.call.argsRaw }
    }
    return null
  }
  if (typeof record.name === 'string' && typeof record.argsRaw === 'string') {
    return { name: record.name, argsRaw: record.argsRaw }
  }
  return null
}

/** The applied hunks for one settled block, or the call-argument intent. */
function blockChanges(block: ToolCallBlock): readonly BlockChange[] {
  const call = callOf(block)
  if (call === null) return []
  const intent = callIntent(call.name, call.argsRaw)
  if (intent === null) return []
  const settled = (block as { isError?: unknown }).isError !== undefined
  if (settled && (block as ToolResultNode).isError) return []

  const changes: BlockChange[] = []
  if (intent.path !== null) {
    let diffs = intent.diffs
    if (settled) {
      const applied = appliedDiffs((block as ToolResultNode).meta)
      if (applied !== null) {
        const own = applied.filter(diff => diff.path === intent.path)
        if (own.length > 0) diffs = own
      }
    }
    if (diffs.length > 0) changes.push({ path: intent.path, diffs })
  }
  for (const path of intent.deletions) changes.push({ path, diffs: [], deleted: true })
  return changes
}

/**
 * Settled changes for a tool block tree (the block itself plus `subCalls`).
 *
 * The tree contributes one settlement per top-level node, NOT one per nested
 * dispatch: the Host recorder attributes a `run_code` root's mutations to the
 * ROOT's seq (a nested dispatch it observes carries no separate conversation
 * sequence of its own). Ordering the two channels against different clocks
 * would be comparing incomparable numbers, and a child's seq could also fall
 * past the turn boundary that owns its root.
 */
function collectChanges(block: ToolCallBlock, out: BlockChange[]): void {
  const settledNode = block as ToolResultNode
  if (settledNode.kind === 'tool-result') {
    for (const change of blockChanges(block)) out.push(change)
  }
  const subCalls = (block as { subCalls?: unknown }).subCalls
  if (!Array.isArray(subCalls)) return
  for (const child of subCalls) {
    const node = child as ToolCallBlock
    if ((node as ToolResultNode).kind === 'tool-result') collectChanges(node, out)
  }
}

/**
 * Attribute an event seq to its owning turn. Completed turns own the seq
 * range up to their `turn/end` seq; anything past the last completed end
 * belongs to the live turn (the in-flight `partial` / running call's turn,
 * or the next turn number when nothing live is observable).
 */
function turnAttribution(snapshot: ConversationSnapshot): (seq: number) => { turn: number; live: boolean } {
  const view = normalizeSnapshot(snapshot)
  const ends = [...(view?.turnEnds.entries() ?? [])].sort((a, b) => a[1] - b[1])
  const liveTurn = view?.partial?.turn
    ?? view?.runningCalls[0]?.turn
    ?? ((ends.at(-1)?.[0] ?? 0) + 1)
  return (seq: number) => {
    for (const [turn, endSeq] of ends) {
      if (endSeq >= seq) return { turn, live: false }
    }
    return { turn: liveTurn, live: true }
  }
}

/** Derive one session's per-turn produced-file changes (uncached core). */
function derive(snapshot: ConversationSnapshot): TurnFileChanges[] {
  const attribute = turnAttribution(snapshot)
  const byTurn = new Map<number, { live: boolean; changes: SequencedChange[] }>()
  const view = normalizeSnapshot(snapshot)
  for (const node of (view?.nodes ?? []) as readonly ToolResultNode[]) {
    if (node.kind !== 'tool-result' || node.isError) continue
    const changes: BlockChange[] = []
    collectChanges(node, changes)
    if (changes.length === 0) continue
    // One top-level node, one settlement order: its own seq is the clock the
    // recorded channel uses for this root's mutations too.
    const seq = typeof node.seq === 'number' ? node.seq : undefined
    const { turn, live } = attribute(node.seq)
    let group = byTurn.get(turn)
    if (group === undefined) {
      group = { live, changes: [] }
      byTurn.set(turn, group)
    }
    for (const change of changes) group.changes.push({ seq, change })
  }
  return [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, group]) => {
      const files = new Map<string, FileAccumulator>()
      // Order by event sequence: hunks accumulate in the order they happened.
      // Shared seqs (one top-level node) keep the collector's order, and an
      // unknown seq leaves the array order alone rather than guessing.
      for (const { seq, change } of orderBySequence(group.changes)) {
        const existing = files.get(change.path)
        if (change.deleted === true) {
          // A deletion is an EVENT. Recording its sequence is what lets a later
          // cross-channel write prove it recreated the path (see `merge`).
          if (existing === undefined) files.set(change.path, { diffs: [], deleted: true, deletedSeq: seq })
          else { existing.deleted = true; existing.deletedSeq = seq }
          continue
        }
        if (existing === undefined) {
          const diffs: ProducedFileDiff[] = []
          appendMutation(diffs, change.diffs, seq)
          files.set(change.path, { diffs })
        } else {
          appendMutation(existing.diffs, change.diffs, seq)
          // A later write recreates the path, so the pending deletion is stale.
          delete existing.deleted
          delete existing.deletedSeq
        }
      }
      return {
        turn,
        live: group.live,
        files: [...files.entries()].map(([path, own]) => ({
          path,
          diffs: own.diffs,
          ...(own.deleted === true ? { deleted: true as const } : {}),
          ...(own.deletedSeq !== undefined ? { deletedSeq: own.deletedSeq } : {}),
        })),
      }
    })
}

/**
 * Snapshot-identity cache: the sidebar badge runs this derivation on every
 * tab-bar render, so the result is memoized per immutable snapshot reference
 * (the session publishes a fresh reference only when content changes).
 */
const cache = new WeakMap<ConversationSnapshot, TurnFileChanges[]>()

/** Derive per-turn produced-file changes for one session snapshot. */
export function deriveSessionChanges(snapshot: ConversationSnapshot | null): TurnFileChanges[] {
  if (snapshot === null) return []
  const hit = cache.get(snapshot)
  if (hit !== undefined) return hit
  const derived = derive(snapshot)
  cache.set(snapshot, derived)
  return derived
}

/**
 * One Code Mode (`run_code`) root visible in the snapshot, with the turn it
 * settles into. The snapshot now carries settled `subCalls` with their own
 * call heads and result metadata, so those are the primary source; this root
 * list only feeds the Host recorder fallback for roots whose nested facts did
 * not survive into the snapshot.
 */
export interface SessionRoot {
  readonly turn: number
  readonly live: boolean
  readonly rootCallId: string
  /**
   * The root node's event sequence, or undefined when the snapshot omitted it.
   * A recorded mutation is a nested dispatch of this root, so this is the
   * sequence its changes are ordered by — it is what lets a `run_code` edit be
   * merged into the right position among the turn's model-direct edits. When it
   * is unknown the merge keeps array order rather than guessing.
   */
  readonly seq: number | undefined
  /**
   * How many nested dispatches of this root have SETTLED so far.
   *
   * The Host recorder keeps appending mutations under the SAME `rootCallId`
   * while a long `run_code` runs, so a call-id-only dependency would never
   * re-arm the client's `recorded` fetch: the tab would show only the mutations
   * that landed before its first fetch. A nested dispatch settles exactly when
   * the recorder sees it, so this count grows with the recorded data and gives
   * the fetch a dependency that tracks it.
   */
  readonly progress: number
}

/** Every `run_code` tool-result node whose nested changes are not in the snapshot. */
export function deriveSessionRoots(snapshot: ConversationSnapshot): SessionRoot[] {
  const attribute = turnAttribution(snapshot)
  const roots: SessionRoot[] = []
  const view = normalizeSnapshot(snapshot)
  for (const node of (view?.nodes ?? []) as readonly ToolResultNode[]) {
    if (node.kind !== 'tool-result' || node.isError) continue
    if (node.subCalls.length === 0) continue
    const nested: BlockChange[] = []
    let settled = 0
    for (const child of node.subCalls) {
      if ((child as ToolResultNode).kind !== 'tool-result') continue
      settled += 1
      collectChanges(child, nested)
    }
    if (nested.some(change => change.diffs.length > 0)) continue
    const { turn, live } = attribute(node.seq)
    const seq = typeof node.seq === 'number' ? node.seq : undefined
    roots.push({ turn, live, rootCallId: node.callId, seq, progress: settled })
  }
  return roots
}

/**
 * Merge Host-recorded Code Mode mutations into the snapshot-derived turns:
 * hunks rebuilt from the full before/after are inserted into the owning turn's
 * file groups at the position their EVENT SEQUENCE puts them (same-path entries
 * stay one row), so the tab's diff rendering, status inspection and undo all
 * work on programmatic edits exactly like model-direct ones.
 *
 * Ordering is by sequence rather than "snapshot first, recorded after": the two
 * sources are separate channels merged asynchronously, so appending recorded
 * mutations could invert them. A `run_code` insert at the top of a file followed
 * by a model-direct edit near its end must replay in that order — reversed, the
 * rear edit's line anchors describe text the front insert already shifted, and
 * BOTH undo and redo fail on a file that was perfectly reviewable.
 *
 * All inputs are immutable; the result is a fresh array only when a recorded
 * mutation matched a visible root.
 */
export function mergeRecordedTurns(
  turns: readonly TurnFileChanges[],
  roots: readonly SessionRoot[],
  recorded: readonly RecordedMutation[],
): readonly TurnFileChanges[] {
  if (recorded.length === 0 || roots.length === 0) return turns
  const rootTurns = new Map<string, { turn: number; live: boolean; seq: number | undefined }>()
  for (const root of roots) {
    rootTurns.set(root.rootCallId, { turn: root.turn, live: root.live, seq: root.seq })
  }
  const byRoot = new Map<string, RecordedMutation[]>()
  for (const mutation of recorded) {
    const list = byRoot.get(mutation.rootCallId)
    if (list === undefined) byRoot.set(mutation.rootCallId, [mutation])
    else list.push(mutation)
  }
  let matched = false
  for (const root of roots) {
    if (byRoot.has(root.rootCallId)) { matched = true; break }
  }
  if (!matched) return turns

  // Recorded settlements per (turn, path), each carrying its root's sequence so
  // it can be interleaved with the snapshot-derived ones.
  const pending = new Map<number, Map<string, { seq: number | undefined; diffs: readonly ProducedFileDiff[] }[]>>()
  for (const [rootCallId, mutations] of byRoot) {
    const owner = rootTurns.get(rootCallId)
    if (owner === undefined) continue
    let paths = pending.get(owner.turn)
    if (paths === undefined) { paths = new Map(); pending.set(owner.turn, paths) }
    for (const mutation of mutations) {
      const diffs = diffsFromBeforeAfter(mutation.path, mutation.before, mutation.after)
      if (diffs.length === 0) continue
      const list = paths.get(mutation.path)
      if (list === undefined) paths.set(mutation.path, [{ seq: owner.seq, diffs }])
      else list.push({ seq: owner.seq, diffs })
    }
  }

  const merge = (
    existing: FileAccumulator | undefined,
    extra: readonly { seq: number | undefined; diffs: readonly ProducedFileDiff[] }[],
  ): FileAccumulator => {
    // Recover the snapshot-derived settlements, add the recorded ones, and
    // re-flatten in event order. Stamps are reassigned by the flatten, so a
    // reordered list still groups by coordinate space correctly.
    const settlements = [
      ...settlementsOf(existing?.diffs ?? []),
      ...extra.map(entry => ({ seq: entry.seq, diffs: entry.diffs })),
    ]
    const diffs = flattenSettlements(settlements)
    // A recorded (Code Mode) mutation SETTLES the path: whether it deleted or
    // wrote, it happened after the snapshot's own settlement for this root, so
    // its sequence decides the final state. Inheriting `existing.deleted`
    // unconditionally kept a recreated file marked deleted, hiding its diff and
    // its undo/reapply controls even though the later write brought it back.
    // When the path only ever had a snapshot deletion and no recorded write,
    // the flag still stands.
    const lastRecordedSeq = extra.reduce<number | undefined>(
      (highest, entry) => (entry.seq === undefined ? highest : Math.max(highest ?? entry.seq, entry.seq)),
      undefined,
    )
    const recreated = diffs.length > 0
      && lastRecordedSeq !== undefined
      && (existing?.deletedSeq === undefined || lastRecordedSeq > existing.deletedSeq)
    if (recreated || existing?.deleted !== true) {
      return { diffs }
    }
    return {
      diffs,
      deleted: true,
      ...(existing.deletedSeq !== undefined ? { deletedSeq: existing.deletedSeq } : {}),
    }
  }

  const out: TurnFileChanges[] = []
  for (const turn of turns) {
    const paths = pending.get(turn.turn)
    const files = new Map<string, FileAccumulator>()
    for (const file of turn.files) {
      files.set(file.path, {
        diffs: [...file.diffs],
        ...(file.deleted === true ? { deleted: true as const } : {}),
        ...(file.deletedSeq !== undefined ? { deletedSeq: file.deletedSeq } : {}),
      })
    }
    if (paths !== undefined) {
      for (const [path, extra] of paths) files.set(path, merge(files.get(path), extra))
    }
    out.push({
      turn: turn.turn,
      live: turn.live,
      files: [...files.entries()].map(([path, own]) => ({
        path,
        diffs: own.diffs,
        ...(own.deleted === true ? { deleted: true as const } : {}),
        ...(own.deletedSeq !== undefined ? { deletedSeq: own.deletedSeq } : {}),
      })),
    })
  }
  // A root whose turn the snapshot did not report still produces a group.
  for (const [turn, paths] of pending) {
    if (turns.some(entry => entry.turn === turn)) continue
    const owner = roots.find(root => root.turn === turn)
    out.push({
      turn,
      live: owner?.live ?? true,
      files: [...paths.entries()].map(([path, extra]) => ({
        path,
        ...merge(undefined, extra),
      })),
    })
  }
  return out.sort((a, b) => a.turn - b.turn)
}

/** Count distinct changed paths across every turn (the sidebar badge count). */
export function countChangedFiles(turns: readonly TurnFileChanges[]): number {
  const paths = new Set<string>()
  for (const turn of turns) {
    for (const file of turn.files) paths.add(file.path)
  }
  return paths.size
}

/**
 * Turns that stay in the review tab's MAIN list: the newest
 * {@link ARCHIVE_KEEP_TURNS} turns plus every live (still-running) turn.
 * Older completed turns auto-archive to the tab's bottom section (issue #5:
 * long sessions accumulate dozens of diff groups and weigh the page down).
 */
export const ARCHIVE_KEEP_TURNS = 5

/** Archived turns render this many groups per loaded page once the section opens. */
export const ARCHIVE_PAGE_TURNS = 10

/**
 * Debug/demo override for the keep threshold: `?frtArchiveKeep=N` in the app
 * URL forces N (0 archives every completed turn) so the archive UI can be
 * exercised on sessions with few change-bearing turns. Null when absent.
 */
function archiveKeepOverride(): number | null {
  try {
    const param = new URLSearchParams(window.location.search).get('frtArchiveKeep')
    if (param === null) return null
    const value = Number(param)
    if (Number.isInteger(value) && value >= 0) return value
  } catch {
    // Non-browser context (tests): no override.
  }
  return null
}

/** Split turns into the main list and the auto-archived tail (both newest-first). */
export function splitArchivedTurns(
  turns: readonly TurnFileChanges[],
  keep = ARCHIVE_KEEP_TURNS,
): { main: readonly TurnFileChanges[]; archived: readonly TurnFileChanges[] } {
  const effective = archiveKeepOverride() ?? keep
  const descending = [...turns].sort((left, right) => right.turn - left.turn)
  const kept = new Set(descending.slice(0, effective).map(turn => turn.turn))
  const main: TurnFileChanges[] = []
  const archived: TurnFileChanges[] = []
  for (const turn of descending) {
    // A live turn never archives, however old its number is.
    if (turn.live || kept.has(turn.turn)) main.push(turn)
    else archived.push(turn)
  }
  return { main, archived }
}

/** Trailing path segment, the part that identifies the file at a glance. */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** POSIX root, drive-letter, or UNC absolute-path test (separator-agnostic). */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/** Resolve a (possibly relative) tool path against the session cwd. */
export function resolveSessionPath(cwd: string | undefined, path: string): string {
  if (isAbsolutePath(path)) return path
  const base = cwd ?? ''
  if (base === '') return path
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${path}`
}
