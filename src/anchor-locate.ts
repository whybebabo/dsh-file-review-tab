/**
 * Place a mutation's fragments in the file as it stands, for hunks whose
 * coordinates were never recorded.
 *
 * The recorder captures coordinates at settlement (see `hunk-anchors.ts`), which
 * covers every edit made while the plugin was loaded. A session reviewed after
 * the plugin was installed — or after a Host restart — carries hunks recorded
 * earlier, and those must not stay stuck at a per-hunk count of 1.
 *
 * The fragments themselves are enough: each carries up to three context lines on
 * both sides, so its new side is a run of literal lines that either appears in
 * the file exactly once or is ambiguous. Only a UNIQUE match is accepted. A
 * repeated block (a blank run, a copy-pasted table row) places nothing at all,
 * because a wrong line number is worse than the hunk-local count it replaces.
 *
 * Coordinates therefore describe the file as it is NOW. When the file was edited
 * again above the hunk, that is exactly what a reviewer wants to jump to — and it
 * is why these coordinates are a fallback: the recorded ones describe the
 * settlement itself and cannot drift with later edits.
 */

import type { HunkAnchor } from './change-types.ts'

/** Split file text into lines the way the diff basis does (a trailing LF is not a line). */
function contentLines(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/**
 * The only line index where `block` matches `lines`, or null when the block is
 * absent or ambiguous.
 * @param lines - the file's lines.
 * @param block - the fragment's new side, as lines.
 * @returns the 0-based index of the single match.
 */
function uniqueBlockAt(lines: readonly string[], block: readonly string[]): number | null {
  if (block.length === 0) return null
  const last = lines.length - block.length
  let found: number | null = null
  for (let at = 0; at <= last; at += 1) {
    let matches = true
    for (let offset = 0; offset < block.length; offset += 1) {
      if (lines[at + offset] !== block[offset]) { matches = false; break }
    }
    if (!matches) continue
    // A second hit makes the whole fragment unusable: nothing in the payload
    // says which of them the change landed on.
    if (found !== null) return null
    found = at
  }
  return found
}

/**
 * Coordinates for one call's fragments, or null when any of them is unplaceable.
 *
 * All fragments of a call must resolve: they came from one patch, so a partial
 * answer would number part of a file and leave the rest to a per-hunk count.
 * @param fileText - the file's current text (LF basis).
 * @param hunks - the call's fragments, in engine order.
 * @returns one anchor per fragment, in the same order.
 */
export function locateAnchors(
  fileText: string,
  hunks: readonly { readonly oldText: string | null; readonly newText: string }[],
): HunkAnchor[] | null {
  const lines = contentLines(fileText)
  const anchors: HunkAnchor[] = []
  // Net lines this call's earlier hunks ADDED: the old side of a later hunk sits
  // that many lines above where the new side does.
  let addedByEarlierHunks = 0
  for (const hunk of hunks) {
    const block = hunk.newText === '' ? [] : hunk.newText.replace(/\r\n?/g, '\n').split('\n')
    const at = uniqueBlockAt(lines, block)
    // A pure deletion's new side is empty, so it carries no lines to find. Its
    // position is not recoverable from the payload alone.
    if (at === null) return null
    const newStart = at + 1
    anchors.push({
      oldStart: Math.max(0, newStart - addedByEarlierHunks),
      newStart,
    })
    const oldSide = hunk.oldText === null ? [] : hunk.oldText.replace(/\r\n?/g, '\n').split('\n')
    addedByEarlierHunks += block.length - oldSide.length
  }
  return anchors
}