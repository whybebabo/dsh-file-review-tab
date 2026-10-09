/**
 * Turn-scoped produced-file definition and readers.
 *
 * dsh 0.1.5 moved the Chat turn-tail slot and its owner currency into
 * `@deepseek-ai/dsh-client-ui-chat`, and the Conversation Definition contract
 * no longer hands each match a pre-rendered wire view. The mutation facts are
 * therefore derived the same way dsh 0.1.5's own ui-deliverables does it: from
 * the `tool/call` arguments, plus the tool-private `meta.diffs` attached to a
 * `tool/result` (dsh-tool-fs publishes the result-time contextual diff there).
 * The Definition still publishes a richer `deliverables` Turn value than the
 * built-in row — the hunks ride along so the turn-tail card can show +M −K and
 * offer undo/redo through this plugin's Host service.
 *
 * Client-only and model-free: the vocabulary is the mutation tools' own call
 * arguments and result metadata, never the closing prose.
 */
import type {
  ConversationLocationData, ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ProducedFileDiff, ProducedFileReview } from '../change-types.ts'
import { appliedDiffs, callIntent } from './mutation-call.ts'
import { appendMutation } from '../mutation-order.ts'
export type { ProducedFileDiff, ProducedFileReview } from '../change-types.ts'

interface ProducedPath {
  readonly seq: number
  readonly path: string
  readonly diffs: readonly ProducedFileDiff[]
  /** Terminal commands deleted this path in the same Turn (display-only). */
  readonly deleted?: true
}

/** Immutable produced-file facts published against one Turn. */
export interface DeliverablesTurnData {
  readonly produced: readonly ProducedPath[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Successful mutation paths (and their hunks) accumulated in this Turn. */
    deliverables: DeliverablesTurnData
  }
}

interface DeliverablesState extends DeliverablesTurnData {
  readonly turn: number
  readonly calls: ReadonlyMap<string, ReturnType<typeof callIntent>>
}

/** Result payload structurally narrowed for the fields this Definition reads. */
function toolResultFields(event: unknown): { readonly callId: string; readonly isError: boolean; readonly meta: unknown } | null {
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const record = data as { message?: unknown; meta?: unknown }
  const message = record.message
  if (typeof message !== 'object' || message === null) return null
  const source = (message as { source?: unknown }).source
  const callId = typeof source === 'object' && source !== null
    ? (source as { callId?: unknown }).callId
    : undefined
  const content = (message as { content?: unknown }).content
  const first = Array.isArray(content)
    ? (content[0] as { isError?: unknown } | undefined)
    : undefined
  return typeof callId === 'string'
    ? { callId, isError: first?.isError === true, meta: record.meta }
    : null
}

/**
 * Files and review hunks available at one closing Assistant boundary.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced files in first-seen order with same-path hunks appended in settlement order.
 */
export function reviewsForClosing(
  data: Readonly<DeliverablesTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly ProducedFileReview[] {
  if (data === undefined) return []
  const reviews: Array<{ path: string; diffs: ProducedFileDiff[]; deleted?: true }> = []
  const byPath = new Map<string, { path: string; diffs: ProducedFileDiff[]; deleted?: true }>()
  for (const produced of data.produced) {
    if (produced.seq > seq) continue
    const review = byPath.get(produced.path)
    if (review === undefined) {
      const diffs: ProducedFileDiff[] = []
      appendMutation(diffs, produced.diffs, produced.seq)
      const created = {
        path: produced.path,
        diffs,
        ...(produced.deleted === true ? { deleted: true as const } : {}),
      }
      byPath.set(produced.path, created)
      reviews.push(created)
    } else {
      appendMutation(review.diffs, produced.diffs, produced.seq)
      // Last state wins: a deletion marks the entry, a later write (the file
      // was recreated in the same turn) clears it again.
      if (produced.deleted === true) review.deleted = true
      else delete review.deleted
    }
  }
  return reviews
}

/**
 * Files produced by one Turn data value.
 *
 * A mutation is recognized by its tool call intent, not by a result view: a
 * write/edit/str_replace_editor call mutates one path, and a successful
 * terminal call's literal rm-family arguments name deleted paths. Reads
 * contribute nothing (looking at a file does not produce it); failed calls
 * contribute nothing. Paths keep first-seen order and appear once.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced paths in first-seen order; empty when the turn wrote nothing.
 */
export function producedForClosing(
  data: Readonly<DeliverablesTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly string[] {
  if (data === undefined) return []
  const paths: string[] = []
  const seen = new Set<string>()
  const lastDeleted = new Map<string, boolean>()
  for (const produced of data.produced) {
    if (produced.seq > seq) continue
    lastDeleted.set(produced.path, produced.deleted === true)
    if (seen.has(produced.path)) continue
    seen.add(produced.path)
    paths.push(produced.path)
  }
  // Deleted paths carry no openable file; they stay out of the mention
  // vocabulary even when an earlier write in the same turn recorded them.
  return paths.filter(path => lastDeleted.get(path) !== true)
}

/**
 * Claim the turn-tail chain only when its closing turn produced files.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns Produced-file reviews as the component's match, or null to decline before mount.
 */
export function selectProducedFiles(owner: TurnTailOwnerProps): readonly ProducedFileReview[] | null {
  const reviews = reviewsForClosing(owner.turn.data.get('deliverables'), owner.seq)
  return reviews.length === 0 ? null : reviews
}

/** Whether an event entered the surface at its own log position (append copy). */
function isAppendSurfaceEvent(event: unknown): boolean {
  const record = event as { type?: unknown; surfaceOp?: unknown }
  if (record.type !== 'system/message'
    && record.type !== 'user/message'
    && record.type !== 'assistant/message'
    && record.type !== 'tool/result') return false
  return record.surfaceOp === 'append'
}

/** Turn-local successful mutation accumulator; it publishes no view Node. */
export const deliverablesDefinition: ConversationNodeDefinition<DeliverablesState> = {
  kind: 'deliverables',
  match: (event) => {
    const record = event as { type?: unknown; data?: { turn?: unknown } }
    if (record.type === 'turn/start') return { id: String(record.data?.turn), role: 'start' }
    if (record.type === 'tool/call') return { id: String(record.data?.turn), role: 'update' }
    if (record.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(record.data?.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    const record = match.event as { type?: unknown; data?: { turn?: unknown } }
    if (record.type !== 'turn/start') throw new Error('deliverables start requires turn/start')
    return { turn: Number(record.data?.turn), calls: new Map(), produced: [] }
  },
  update: (context, match: ConversationMatch) => {
    const record = match.event as { type?: unknown; data?: unknown; seq?: unknown }
    if (record.type === 'tool/call') {
      const data = record.data as { callId?: unknown; name?: unknown; arguments?: unknown }
      if (typeof data.callId !== 'string' || typeof data.name !== 'string') return context.state
      const calls = new Map(context.state.calls)
      calls.set(data.callId, callIntent(data.name, data.arguments))
      return { ...context.state, calls }
    }
    if (record.type !== 'tool/result') return context.state
    const result = toolResultFields(match.event)
    if (result === null || result.isError) return context.state
    const intent = context.state.calls.get(result.callId)
    if (intent === undefined || intent === null) return context.state

    const applied = appliedDiffs(result.meta)
    const seq = typeof record.seq === 'number' ? record.seq : Number.POSITIVE_INFINITY
    const additions: ProducedPath[] = []
    if (intent.path !== null) {
      const own = applied === null
        ? intent.diffs
        : applied.filter(diff => diff.path === intent.path)
      additions.push({
        seq,
        path: intent.path,
        diffs: own.length > 0 ? own : intent.diffs,
      })
    }
    for (const path of intent.deletions) {
      additions.push({ seq, path, diffs: [], deleted: true })
    }
    return additions.length === 0
      ? context.state
      : { ...context.state, produced: [...context.state.produced, ...additions] }
  },
  buildLocationData: (context, scope): ConversationLocationData | null => {
    if (scope !== 'turn' || context.state === undefined) return null
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'deliverables',
      value: { produced: context.state.produced },
    }
  },
}

/**
 * Trailing path segment, the part that identifies the file at a glance.
 * @param path - Slash- or backslash-separated path.
 * @returns The final segment, or the whole string when separator-free.
 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * File-mention vocabulary over one turn's produced paths, for the closing
 * message's prose: an inline-code token opens the file it names. A token
 * resolves by exact path, or by being exactly the basename of exactly one
 * produced path — a basename two paths share stays inert rather than
 * guessing, so a mention link can never open the wrong file or 404.
 * @param paths - The turn's produced paths (tool order, already deduped).
 * @param openFile - The chat view's file opener.
 * @param label - Localizes the accessible open-label for a resolved path.
 * @returns The resolver MarkdownText consumes; the full path rides `title`,
 * the same disambiguator the row's chips carry.
 */
export function producedFileMentions(
  paths: readonly string[],
  openFile: (path: string) => void,
  label: (path: string) => string,
): MarkdownFileMentions {
  return {
    resolve(value) {
      const path = paths.includes(value) ? value : onlyPathWithBasename(paths, value)
      if (path === undefined) return undefined
      return { open: () => { openFile(path) }, label: label(path), title: path }
    },
  }
}

/** The single produced path whose basename is exactly `value`, else undefined. */
function onlyPathWithBasename(paths: readonly string[], value: string): string | undefined {
  const matches = paths.filter(path => basename(path) === value)
  return matches.length === 1 ? matches[0] : undefined
}
