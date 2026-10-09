/**
 * Shared file-mutation facts for dsh 0.1.5.
 *
 * The Conversation Definition contract no longer hands matches a pre-rendered
 * wire view, so both the chat turn-tail row and the sidebar tab derive a
 * mutation from the same two sources the dsh 0.1.5 tooling uses:
 *
 * - `tool/call` arguments identify the mutated path and the intended hunks
 *   (`write` / `edit` / `str_replace_editor`), or the terminal command whose
 *   literal rm-family arguments name deleted paths (`bash` / `pwsh`);
 * - `tool/result` `meta.diffs` carries the applied contextual hunks that
 *   dsh-tool-fs attaches on settlement (no line numbers in 0.1.5).
 *
 * Unknown tools and malformed arguments yield null, keeping the vocabulary
 * conservative: a call only produces review data when its shape is known.
 */
import type { ProducedFileDiff } from '../change-types.ts'
import { deletedPathsFromCommand } from './deleted-paths.ts'

/** One mutation call's parsed intent, captured at `tool/call` time. */
export interface CallIntent {
  /** The single path the call mutates; null for a deletion-only terminal call. */
  readonly path: string | null
  /** Call-argument-derived hunks, used when the result carries no meta diff. */
  readonly diffs: readonly ProducedFileDiff[]
  /** Literal paths a terminal call deletes. */
  readonly deletions: readonly string[]
}

/** Parse one tool call's raw JSON arguments defensively. */
function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** A non-blank string path, or null. */
function pathValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * The call-argument-derived mutation intent for one write/edit/str_replace_editor
 * or terminal call. Unknown tools and malformed arguments return null.
 */
export function callIntent(name: string, argsRaw: unknown): CallIntent | null {
  const args = parseArgs(argsRaw)
  if (args === null) return null

  const deletions = (name === 'bash' || name === 'pwsh') && typeof args.command === 'string'
    ? deletedPathsFromCommand(args.command)
    : []

  if (name === 'str_replace_editor') {
    const path = pathValue(args.path)
    if (path === null) return null
    if (args.command === 'create') {
      const fileText = args.file_text
      if (fileText !== undefined && typeof fileText !== 'string') return null
      // The command name is itself provenance: `create` is the one call shape
      // whose semantics guarantee the file did not exist before. Every other
      // branch below writes into a file that may already exist, so it leaves
      // `created` unset rather than guessing from a null old side.
      return { path, diffs: [{ path, oldText: null, newText: fileText ?? '', created: true }], deletions }
    }
    if (args.command === 'str_replace') {
      const oldStr = args.old_str
      const newStr = args.new_str
      if (oldStr !== undefined && typeof oldStr !== 'string') return null
      if (newStr !== undefined && typeof newStr !== 'string') return null
      return { path, diffs: [{ path, oldText: oldStr ?? null, newText: newStr ?? '' }], deletions }
    }
    if (args.command === 'insert') {
      const newStr = args.new_str
      if (typeof newStr !== 'string') return null
      return { path, diffs: [{ path, oldText: null, newText: newStr }], deletions }
    }
    return deletions.length === 0 ? null : { path: null, diffs: [], deletions }
  }

  const path = pathValue(args.file_path)
  if (name === 'write') {
    const content = args.content
    if (path === null || typeof content !== 'string') return null
    return { path, diffs: [{ path, oldText: null, newText: content }], deletions }
  }
  if (name === 'edit') {
    const oldString = args.old_string
    const newString = args.new_string
    if (path === null || typeof oldString !== 'string' || typeof newString !== 'string') return null
    return {
      path,
      diffs: [{ path, oldText: oldString === '' ? null : oldString, newText: newString }],
      deletions,
    }
  }
  return deletions.length === 0 ? null : { path: null, diffs: [], deletions }
}

/** Validate the tool-private result metadata's contextual diff hunks. */
export function appliedDiffs(meta: unknown): readonly ProducedFileDiff[] | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const diffs = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: ProducedFileDiff[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null || Array.isArray(hunk)) return null
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string'
      || (oldText !== null && typeof oldText !== 'string')
      || typeof newText !== 'string') return null
    // The engine's own diff schema documents `oldText` as "The original content
    // (None for new files)", so a null HERE is authoritative: this is the one
    // place where null may be decoded as a creation. The synthesized hunks
    // below must not, because their null means "prior content unknown".
    out.push({ path, oldText, newText, ...(oldText === null ? { created: true as const } : {}) })
  }
  return out
}
