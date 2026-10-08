/**
 * The comparison surface: a faithful port of dsh's own FileDiff renderer.
 *
 * The sidebar review tab and the chat hover preview both draw this, so both look
 * like the built-in comparison rather than a look-alike. Structure, class usage
 * and the `data-diff-*` / `data-review-*` attributes match the native component
 * (read out of the running app's asar) so the host's own styles, the chat card's
 * preview rules, and anything else keying off those attributes keep working.
 *
 * Syntax highlighting rides the shared `useCodeHighlighter` from the primitives
 * package — the same one the built-in diff uses — so grammars are loaded once for
 * the whole app instead of per plugin.
 */

import { useMemo, useRef } from 'react'
import type { UIEvent } from 'react'
import {
  languageForPath, useCodeHighlighter,
  type HighlightSpan,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { isOneSided, type NativeDiffHunk } from './diff-hunks.ts'
import css from './NativeDiff.module.css'

/** Maximum rendered lines per comparison, as native caps it. */
const MAX_RENDERED_LINES = 5000

/** One rendered line, numbered against both sides. */
interface DiffRow {
  readonly kind: 'context' | 'del' | 'add'
  readonly old: number | undefined
  readonly new: number | undefined
  readonly text: string
}

/** One side of a paired row in the side-by-side view. */
interface SplitCell {
  readonly no: number
  readonly text: string
  readonly kind: 'context' | 'del' | 'add'
}

interface SplitRow {
  readonly left?: SplitCell
  readonly right?: SplitCell
}

/** Localized copy the comparison needs. */
export interface NativeDiffLabels {
  readonly created: string
  readonly deleted: string
  readonly unchanged: string
  readonly truncated: (count: string) => string
  /** Shown while the comparison is still being resolved. */
  readonly loading: string
  /** Shown when the two sides can no longer be reconstructed. */
  readonly missing: string
}

export interface NativeDiffProps {
  readonly hunks: readonly NativeDiffHunk[]
  /** Source path, used to pick the syntax grammar. */
  readonly path: string
  /** Side-by-side when true (and the change is two-sided). */
  readonly split: boolean
  /** Wrap long lines instead of scrolling them. */
  readonly wrap: boolean
  /**
   * Why the two sides differ in shape rather than content, when they do:
   * 'created' and 'deleted' are native's own notes.
   */
  readonly note?: 'created' | 'deleted' | 'unchanged' | undefined
  /**
   * Force one of native's non-content states instead of drawing hunks:
   * 'loading' while the change is still being read, 'missing' when it is gone.
   */
  readonly status?: 'loading' | 'missing' | undefined
  readonly labels: NativeDiffLabels
}

/** Number a hunk's lines: context counts on both sides, deletions old, additions new. */
function hunkRows(hunk: NativeDiffHunk): DiffRow[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map((line) => {
    const text = line.slice(1)
    switch (line[0]) {
      case '+': {
        const row: DiffRow = { kind: 'add', old: undefined, new: newNo, text }
        newNo += 1
        return row
      }
      case '-': {
        const row: DiffRow = { kind: 'del', old: oldNo, new: undefined, text }
        oldNo += 1
        return row
      }
      default: {
        const row: DiffRow = { kind: 'context', old: oldNo, new: newNo, text }
        oldNo += 1
        newNo += 1
        return row
      }
    }
  })
}

/**
 * Pair a hunk's lines for the side-by-side view: each run of deletions aligns
 * with the run of additions that follows it, row by row.
 */
function splitRows(hunk: NativeDiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: SplitCell[] = []
  let adds: SplitCell[] = []
  const flush = (): void => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      const left = dels[at]
      const right = adds[at]
      rows.push({
        ...(left === undefined ? {} : { left }),
        ...(right === undefined ? {} : { right }),
      })
    }
    dels = []
    adds = []
  }
  for (const row of hunkRows(hunk)) {
    if (row.kind === 'del') {
      dels.push({ no: row.old ?? 0, text: row.text, kind: 'del' })
    } else if (row.kind === 'add') {
      adds.push({ no: row.new ?? 0, text: row.text, kind: 'add' })
    } else {
      flush()
      rows.push({
        left: { no: row.old ?? 0, text: row.text, kind: 'context' },
        right: { no: row.new ?? 0, text: row.text, kind: 'context' },
      })
    }
  }
  flush()
  return rows
}

/** The kind a paired row carries: a deletion or addition on either side, else context. */
function splitRowKind(row: SplitRow): 'del' | 'add' | 'context' {
  if (row.left?.kind === 'del') return 'del'
  if (row.right?.kind === 'add') return 'add'
  return 'context'
}

/** Native's hunk coordinate banner. */
function hunkHeader(hunk: NativeDiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
}

/** Highlight one side of a hunk into per-line spans, keyed by line number. */
function highlightedSide(
  rows: readonly DiffRow[],
  side: 'old' | 'new',
  highlighter: (code: string) => HighlightSpan[][] | undefined,
): Map<number, readonly HighlightSpan[]> | undefined {
  const source = rows
    .map(row => ({ no: row[side], text: row.text }))
    .filter((line): line is { no: number; text: string } => line.no !== undefined)
  if (source.length === 0) return new Map()
  const highlighted = highlighter(source.map(line => line.text).join('\n'))
  if (highlighted === undefined) return undefined
  return new Map(source.map((line, index) => [line.no, highlighted[index] ?? []]))
}

interface HunkHighlights {
  readonly old: Map<number, readonly HighlightSpan[]> | undefined
  readonly new: Map<number, readonly HighlightSpan[]> | undefined
}

/** Highlight both sides of every kept hunk. */
function hunkHighlights(
  hunks: readonly NativeDiffHunk[],
  highlighter: (code: string) => HighlightSpan[][] | undefined,
): HunkHighlights[] {
  return hunks.map((hunk) => {
    const rows = hunkRows(hunk)
    return { old: highlightedSide(rows, 'old', highlighter), new: highlightedSide(rows, 'new', highlighter) }
  })
}

/** Trim hunks to the native line budget, shortening the last one if needed. */
function renderedHunks(hunks: readonly NativeDiffHunk[]): {
  readonly hunks: readonly NativeDiffHunk[]
  readonly truncated: boolean
} {
  let budget = MAX_RENDERED_LINES
  const kept: NativeDiffHunk[] = []
  for (const hunk of hunks) {
    if (budget === 0) return { hunks: kept, truncated: true }
    kept.push(hunk.lines.length <= budget
      ? hunk
      : { ...hunk, lines: hunk.lines.slice(0, budget) })
    budget -= Math.min(budget, hunk.lines.length)
  }
  return { hunks: kept, truncated: hunks.some((hunk, at) => kept[at] !== hunk) }
}

/** One line's text, as highlighted spans when a grammar supplied them. */
function DiffText({ text, spans }: {
  readonly text: string
  readonly spans: readonly HighlightSpan[] | undefined
}) {
  return (
    <span className={css.text} data-diff-code={spans === undefined ? undefined : ''}>
      {spans === undefined
        ? text
        : spans.map((span, index) => (
          <span key={index} style={span.style}>{span.text}</span>
        ))}
    </span>
  )
}

/**
 * The side-by-side view without wrapping: two columns that clip their long lines
 * and scroll together on both axes, so both sides show the same rows and columns
 * of text and every line stays one fixed-height row.
 *
 * The sync tracks each axis's last applied offset and skips a value it already
 * holds. Writing `peer.scrollLeft` fires the peer's own scroll event, so without
 * that guard the two columns ping-pong updates; native suppresses elastic
 * overscroll on the columns for the same reason.
 */
function SplitColumns({ hunks, highlights }: {
  readonly hunks: readonly NativeDiffHunk[]
  readonly highlights: readonly HunkHighlights[]
}) {
  const paired = useMemo(
    () => hunks.map(hunk => ({ header: hunkHeader(hunk), rows: splitRows(hunk) })),
    [hunks],
  )
  const columns = useRef<Record<'left' | 'right', HTMLDivElement | null>>({
    left: null, right: null,
  })
  const offsets = useRef<Record<'left' | 'right', { scrollLeft: number; scrollTop: number }>>({
    left: { scrollLeft: 0, scrollTop: 0 },
    right: { scrollLeft: 0, scrollTop: 0 },
  })
  const follow = (side: 'left' | 'right') => (event: UIEvent<HTMLDivElement>) => {
    const peer = side === 'left' ? 'right' : 'left'
    const other = columns.current[peer]
    // Both refs are attached before a browser scroll event can run.
    if (other === null) return
    for (const axis of ['scrollLeft', 'scrollTop'] as const) {
      const value = event.currentTarget[axis]
      if (offsets.current[side][axis] === value) continue
      offsets.current[side][axis] = value
      other[axis] = value
      offsets.current[peer][axis] = other[axis]
    }
  }
  return (
    <div className={css.columns}>
      {(['left', 'right'] as const).map(side => (
        <div
          key={side}
          className={css.column}
          data-diff-side={side}
          ref={(element) => { columns.current[side] = element }}
          onScroll={follow(side)}
        >
          {paired.map((hunk, position) => (
            <section key={position} className={css.hunk}>
              <div className={css.hunkHeader} data-diff-hunk-header="">{hunk.header}</div>
              {hunk.rows.map((row, at) => {
                const cell = row[side]
                const spans = cell === undefined
                  ? undefined
                  : highlights[position]?.[side === 'left' ? 'old' : 'new']?.get(cell.no)
                return (
                  <div
                    key={at}
                    className={`${css.sideLine} ${cell === undefined ? css.empty : css[cell.kind]}`}
                    data-diff-line={splitRowKind(row)}
                  >
                    <span className={css.number}>{cell?.no ?? ''}</span>
                    <DiffText text={cell?.text ?? ''} spans={spans} />
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Render one file comparison.
 * @param props - hunks, view mode, labels and the optional note.
 * @returns The comparison body, in the layout the mode selects.
 */
export function NativeDiff({
  hunks, path, split, wrap, note, status, labels,
}: NativeDiffProps) {
  // Native's non-content states short-circuit before any hunk work, so a
  // comparison still loading (or gone) never highlights or pairs lines.
  if (status === 'loading') {
    return <p className={css.status} role="status">{labels.loading}</p>
  }
  if (status === 'missing') {
    return <p className={css.status}>{labels.missing}</p>
  }
  return <TextDiff
    hunks={hunks}
    path={path}
    split={split}
    wrap={wrap}
    note={note}
    labels={labels}
  />
}

/** The hunks of a comparison with their line numbers, unified or side by side. */
function TextDiff({
  hunks, path, split, wrap, note, labels,
}: NativeDiffProps) {
  const highlighter = useCodeHighlighter(languageForPath(path))
  const { hunks: kept, truncated } = useMemo(() => renderedHunks(hunks), [hunks])
  const highlights = useMemo(
    () => hunkHighlights(kept, highlighter),
    [kept, highlighter],
  )
  // Native suppresses the side-by-side layout for a one-sided change (a pure
  // creation or deletion, where there is nothing to pair) without changing the
  // requested mode, so this lives here rather than at the call sites.
  const effectiveSplit = split && !isOneSided(hunks)

  return (
    <div
      className={css.body}
      data-review-view={effectiveSplit ? 'split' : 'unified'}
      data-review-wrap={wrap ? true : undefined}
    >
      {note === 'created' && (
        <p className={css.note} data-diff-note={hunks.length === 0 ? 'empty' : 'metadata'}>
          {labels.created}
        </p>
      )}
      {note === 'deleted' && (
        <p className={css.note} data-diff-note={hunks.length === 0 ? 'empty' : 'metadata'}>
          {labels.deleted}
        </p>
      )}
      {note === 'unchanged' && (
        <p className={css.note} data-diff-note="empty">{labels.unchanged}</p>
      )}
      {truncated && (
        <p className={css.note} data-diff-truncated={true}>
          {labels.truncated(String(MAX_RENDERED_LINES))}
        </p>
      )}
      {effectiveSplit && !wrap
        ? (
          <SplitColumns hunks={kept} highlights={highlights} />
        )
        : kept.map((hunk, position) => {
          const highlighted = highlights[position]
          return (
            <section key={position} className={css.hunk}>
              <div className={css.hunkHeader} data-diff-hunk-header="">{hunkHeader(hunk)}</div>
              {effectiveSplit
                ? splitRows(hunk).map((row, at) => (
                  <div
                    key={at}
                    className={css.splitLine}
                    data-diff-line={splitRowKind(row)}
                  >
                    <span className={`${css.cell} ${row.left === undefined ? css.empty : css[row.left.kind]}`}>
                      <span className={css.number}>{row.left?.no ?? ''}</span>
                      <DiffText
                        text={row.left?.text ?? ''}
                        spans={row.left === undefined ? undefined : highlighted?.old?.get(row.left.no)}
                      />
                    </span>
                    <span className={`${css.cell} ${row.right === undefined ? css.empty : css[row.right.kind]}`}>
                      <span className={css.number}>{row.right?.no ?? ''}</span>
                      <DiffText
                        text={row.right?.text ?? ''}
                        spans={row.right === undefined ? undefined : highlighted?.new?.get(row.right.no)}
                      />
                    </span>
                  </div>
                ))
                : hunkRows(hunk).map((row, at) => (
                  <div key={at} className={`${css.line} ${css[row.kind]}`} data-diff-line={row.kind}>
                    <span className={css.number}>{row.old ?? ''}</span>
                    <span className={css.number}>{row.new ?? ''}</span>
                    <span className={css.sign}>
                      {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                    </span>
                    <DiffText
                      text={row.text}
                      spans={row.kind === 'add'
                        ? highlighted?.new?.get(row.new ?? -1)
                        : highlighted?.old?.get(row.old ?? -1)}
                    />
                  </div>
                ))}
            </section>
          )
        })}
    </div>
  )
}
