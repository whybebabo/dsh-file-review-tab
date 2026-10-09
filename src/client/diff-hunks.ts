/**
 * Line pairing and hunk building shared by every comparison this plugin draws.
 *
 * The sidebar review tab and the chat hover preview both render dsh's own native
 * FileDiff markup, so pairing, numbering, hunk trimming and counting live here
 * once. Counts come from the same pairing the viewer draws with, which is what
 * keeps a "+N" badge from ever disagreeing with the lines on screen.
 *
 * Recorded changes arrive as full before/after snapshots, while dsh's own diff
 * service delivers pre-trimmed hunks. {@link toNativeHunks} bridges the two by
 * trimming context the same way, so a one-line edit in a long file renders as one
 * small hunk instead of the whole file.
 */

import { diffArrays } from 'diff'
import type { ProducedFileDiff } from '../change-types.ts'
import { diffContentLines } from './diff-text.ts'

/** How one drawn line relates to the two sides of the comparison. */
export type DiffLineKind = 'context' | 'del' | 'add'

/** One line of a comparison, already numbered against both sides. */
export interface DiffLine {
  readonly kind: DiffLineKind
  readonly oldNumber: number | null
  readonly newNumber: number | null
  readonly text: string
}

/** Added and removed line totals. */
export interface DiffStats {
  readonly added: number
  readonly removed: number
}

/** Optional native note shown above a comparison. */
export type DiffNote = 'created' | 'deleted' | 'unchanged' | undefined

/**
 * One comparison in the shape dsh's own FileDiff renders: a header coordinate
 * pair plus `+`/`-`/` ` prefixed lines.
 */
export interface NativeDiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

/** Whether a comparison touches only one side, which forces the unified view. */
export function isOneSided(hunks: readonly NativeDiffHunk[]): boolean {
  const adds = hunks.some(hunk => hunk.lines.some(line => line.startsWith('+')))
  const dels = hunks.some(hunk => hunk.lines.some(line => line.startsWith('-')))
  return adds !== dels
}

/** Pair one recorded before/after snapshot into numbered lines. */
export function pairLines(diff: ProducedFileDiff): DiffLine[] {
  const oldLines = diff.oldText === null ? [] : diffContentLines(diff.oldText)
  const newLines = diffContentLines(diff.newText)
  const changes = diffArrays(oldLines, newLines)
  const lines: DiffLine[] = []
  let oldNumber = diff.oldStart ?? 1
  let newNumber = diff.newStart ?? 1

  for (const change of changes) {
    if (change.removed) {
      for (const text of change.value) {
        lines.push({ kind: 'del', oldNumber, newNumber: null, text })
        oldNumber += 1
      }
    } else if (change.added) {
      for (const text of change.value) {
        lines.push({ kind: 'add', oldNumber: null, newNumber, text })
        newNumber += 1
      }
    } else {
      for (const text of change.value) {
        lines.push({ kind: 'context', oldNumber, newNumber, text })
        oldNumber += 1
        newNumber += 1
      }
    }
  }
  return lines
}

/** Count added and removed lines using the viewer's exact line-diff algorithm. */
export function summarizeDiffs(diffs: readonly ProducedFileDiff[]): DiffStats {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const line of pairLines(diff)) {
      if (line.kind === 'add') added += 1
      else if (line.kind === 'del') removed += 1
    }
  }
  return { added, removed }
}

/**
 * Derive the comparison note from the recorded change rather than hunk count alone.
 *
 * The creation note comes from the explicit `created` flag, never from
 * `oldText === null`. Null old text means the prior content is unavailable, and
 * that is also what `mutation-call.ts` synthesizes when a result carries no
 * `meta.diffs` for a `write` overwrite, a `str_replace_editor insert` or an
 * `edit` with an empty `old_string` — all edits to files that already existed.
 * Inferring creation from null labeled those "created in this turn".
 *
 * Creation is a FILE-level fact, so ANY authoritative creation record for the
 * path carries it. `diffs` holds one file's hunks in settlement order, and a
 * file created and then edited in the same turn keeps its creation hunk
 * alongside the later ordinary ones; requiring `every` hunk to be flagged lost
 * the note precisely there. Only the explicitly flagged hunks count, so a
 * file whose prior content is merely unknown stays unlabeled.
 */
export function diffNote(
  diffs: readonly ProducedFileDiff[],
  hunks: readonly NativeDiffHunk[],
  deleted = false,
): DiffNote {
  if (deleted) return 'deleted'
  if (diffs.some(diff => diff.created === true)) return 'created'
  return hunks.length === 0 ? 'unchanged' : undefined
}

/**
 * The message a comparison with nothing to draw shows. A file removed by a
 * command has no content left, which is a different fact from a change whose
 * two sides could not be reconstructed — so it keeps its own explanation
 * instead of the generic one.
 * @param deleted - whether the change removed the file.
 * @param deletedHint - copy for a command-deleted file.
 * @param missing - copy for a change that cannot be reconstructed.
 * @returns the copy to show.
 */
export function missingMessage(deleted: boolean, deletedHint: string, missing: string): string {
  return deleted ? deletedHint : missing
}

/** The half-open line range one hunk keeps, after context trimming. */
interface Range {
  readonly start: number
  readonly end: number
}

/**
 * Keep each run of changed lines plus `contextLines` of surrounding context,
 * merging ranges whose context would overlap.
 * @param lines - the paired lines of one comparison.
 * @param contextLines - unchanged lines to keep on each side of a change.
 * @returns the ranges to render, in order.
 */
function contextRanges(lines: readonly DiffLine[], contextLines: number): Range[] {
  const ranges: Range[] = []
  let cursor = 0
  while (cursor < lines.length) {
    if (lines[cursor]?.kind === 'context') { cursor += 1; continue }
    // One block is a maximal run of changed lines.
    const blockStart = cursor
    while (cursor < lines.length && lines[cursor]?.kind !== 'context') cursor += 1
    const range: Range = {
      start: Math.max(0, blockStart - contextLines),
      end: Math.min(lines.length, cursor + contextLines),
    }
    const previous = ranges[ranges.length - 1]
    // Overlapping or touching ranges render as one hunk, as native's do.
    if (previous !== undefined && range.start <= previous.end) {
      ranges[ranges.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) }
    } else {
      ranges.push(range)
    }
  }
  return ranges
}

/** The line number a range starts at, or the number after the last consumed one. */
function startOf(
  lines: readonly DiffLine[],
  range: Range,
  side: 'oldNumber' | 'newNumber',
  fallback: number,
): number {
  for (let index = range.start; index < range.end; index += 1) {
    const value = lines[index]?.[side]
    if (value !== null && value !== undefined) return value
  }
  for (let index = range.start - 1; index >= 0; index -= 1) {
    const value = lines[index]?.[side]
    if (value !== null && value !== undefined) return value + 1
  }
  return fallback
}

/** Convert one paired comparison into the hunks dsh's FileDiff renders. */
function comparisonToHunks(diff: ProducedFileDiff, contextLines: number): NativeDiffHunk[] {
  const lines = pairLines(diff)
  return contextRanges(lines, contextLines).map((range) => {
    const kept = lines.slice(range.start, range.end)
    return {
      oldStart: startOf(lines, range, 'oldNumber', diff.oldStart ?? 1),
      oldLines: kept.filter(line => line.oldNumber !== null).length,
      newStart: startOf(lines, range, 'newNumber', diff.newStart ?? 1),
      newLines: kept.filter(line => line.newNumber !== null).length,
      // Native derives line text by dropping the leading sign character.
      lines: kept.map((line) => {
        const sign = line.kind === 'del' ? '-' : line.kind === 'add' ? '+' : ' '
        return `${sign}${line.text}`
      }),
    }
  })
}

/**
 * Convert recorded comparisons into dsh's served hunk shape.
 * @param diffs - the recorded before/after snapshots for one file.
 * @param contextLines - unchanged lines kept on each side of a change.
 * @returns the hunks to render, in order.
 */
export function toNativeHunks(
  diffs: readonly ProducedFileDiff[],
  contextLines = 3,
): NativeDiffHunk[] {
  return diffs.flatMap(diff => comparisonToHunks(diff, contextLines))
}

/** Serialize recorded hunks as one plain-text unified diff. */
export function nativeDiffText(hunks: readonly NativeDiffHunk[]): string {
  const output: string[] = []
  for (const hunk of hunks) {
    output.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    output.push(...hunk.lines)
  }
  return output.join('\n')
}
