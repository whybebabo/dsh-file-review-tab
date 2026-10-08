// ProducedFiles: the review card a finished turn ends with.
//
// APPEARANCE: this card reproduces dsh's built-in ui-deliverables
// `ChangedFiles` card value-for-value — same 60px header, 40px file-type tile,
// 13px title, +N/−N counts that swap to a preview hint on hover, code-font
// rows, and the "全部 N 个文件" fold — by rendering the SAME UI primitives the
// built-in card uses (FileTypeIcon, HoverCard, the chevron icons) and mirroring
// its CSS. `@deepseek-ai/dsh-client-ui-primitives` is a platform seed word of
// the Web module system, so this bundle may `require` it at runtime; that is
// what makes an exact match possible rather than an approximation.
//
// WHY IT IS NOT THE BUILT-IN CARD: the built-in header is one solid <button>
// with no slot inside it, so no plugin can inject a control into its top-right
// corner. Rendering the card here — in this plugin's own turnTail list entry —
// is what buys the two extra buttons the built-in card cannot host.
//
// Paths and hunks come from mutation-tool results, never from the closing prose.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FileTypeIcon,
  HoverCard,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconListPenOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  FileReviewAction, FileReviewRequest, FileReviewResult,
} from '../change-types.ts'
import { basename, selectProducedFiles, type ProducedFileReview } from './turn-deliverables.ts'
import type { NS } from './chat-locales.ts'
import { diffNote, summarizeDiffs, toNativeHunks, type DiffStats } from './diff-hunks.ts'
import { NativeDiff } from './NativeDiff.tsx'
import { subscribeFileReviewInvalidation } from './deep-link.ts'
import css from './ProducedCard.module.css'
import toastCss from './ProducedFiles.module.css'

/** Rows shown before the fold; the built-in card uses the same summary height. */
const COLLAPSED_ROWS = 4
const SUCCESS_NOTICE_DURATION = 2000
const ERROR_NOTICE_DURATION = 5000
const GROUPED = new Intl.NumberFormat('en-US')

interface NoticeFile {
  readonly path: string
}

interface ToggleNotice {
  readonly seq: number
  readonly tone: 'success' | 'error'
  readonly title: string
  readonly description?: string | undefined
  readonly files: readonly NoticeFile[]
}

/**
 * Turn-tail owner currency plus the opener and locale supplied by the slot.
 *
 * dsh 0.2.0's `conversation.chat.turnTail` is a `list` slot, so there is no
 * chain selector to receive a pre-matched value on: the component runs the
 * claim test itself ({@link selectProducedFiles}) and renders nothing when the
 * closing turn produced no files.
 */
export type ProducedFilesProps = TurnTailOwnerProps & {
  /** Session workspace root, used to resolve the hover preview's path label. */
  projectRoot?: string | undefined
  /** Session key used to synchronize undo/redo state with the sidebar tab. */
  reviewSessionId?: string | undefined
  inspectChanges?: (request: FileReviewRequest) => Promise<FileReviewResult>
  applyChanges?: (request: FileReviewRequest) => Promise<FileReviewResult>
  /**
   * Open the plugin's sidebar tab with the given paths pre-expanded
   * (the 审查 button passes every produced path; a file row passes its own).
   * The owning turn number rides along so the tab expands only this turn's
   * rows — a path that recurs in other turns stays collapsed there.
   */
  openInSidebarTab?: (paths: readonly string[], turn?: number) => void
} & PropsLocale<typeof NS>

const unavailableChanges = async (request: FileReviewRequest): Promise<FileReviewResult> => ({
  files: request.files.map(file => ({
    path: file.path,
    state: 'unsupported',
    changed: false,
    reason: 'Host file toggle is unavailable',
  })),
})

/**
 * Resolve a tool path against the session root for the hover preview label,
 * the way the built-in card labels its preview. An already-absolute path is
 * shown verbatim, and the join separator follows the root so a POSIX workspace
 * does not get a Windows path.
 * @param root - session workspace root, when known.
 * @param path - tool-reported path (absolute or workspace-relative).
 * @returns the display path.
 */
function displayPath(root: string | undefined, path: string): string {
  if (root === undefined || path === '') return path
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return path
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${path}`
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={toastCss.closeIcon}>
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </svg>
  )
}

function SuccessIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={toastCss.noticeIconSvg}>
      <path d="m5 10 3.25 3.25L15 6.5" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={toastCss.noticeIconSvg}>
      <circle cx="10" cy="10" r="6.5" />
      <path d="m7.5 7.5 5 5m0-5-5 5" />
    </svg>
  )
}

function ResultToast({
  notice, closeLabel, dismissLabel, fileListLabel, fileOpenLabel, openFile, onDone,
}: {
  readonly notice: ToggleNotice
  readonly closeLabel: string
  readonly dismissLabel: string
  readonly fileListLabel: string
  readonly fileOpenLabel: (path: string) => string
  readonly openFile: (path: string) => void
  readonly onDone: () => void
}) {
  useEffect(() => {
    const duration = notice.tone === 'success'
      ? SUCCESS_NOTICE_DURATION
      : ERROR_NOTICE_DURATION
    const timer = window.setTimeout(onDone, duration)
    return () => { window.clearTimeout(timer) }
  }, [notice.tone, onDone])
  return (
    <div
      className={`${toastCss.toast} ${notice.tone === 'success' ? toastCss.toastSuccess : toastCss.toastError}`}
      role="alert"
    >
      <div className={toastCss.toastHeader}>
        <span className={toastCss.noticeIcon}>
          {notice.tone === 'success' ? <SuccessIcon /> : <ErrorIcon />}
        </span>
        <div className={toastCss.toastCopy}>
          <strong className={toastCss.toastTitle}>{notice.title}</strong>
          {notice.description !== undefined && (
            <span className={toastCss.toastDescription}>{notice.description}</span>
          )}
        </div>
        <button
          type="button"
          className={toastCss.toastCloseButton}
          aria-label={closeLabel}
          onClick={onDone}
        >
          <CloseIcon />
        </button>
      </div>
      {notice.files.length > 0 && (
        <div className={toastCss.noticeFiles}>
          <span className={toastCss.noticeFileListLabel}>{fileListLabel}</span>
          <ul className={toastCss.noticeFileList}>
            {notice.files.map(file => (
              <li key={file.path}>
                <button
                  type="button"
                  className={toastCss.noticeFileButton}
                  aria-label={fileOpenLabel(file.path)}
                  onClick={() => { openFile(file.path) }}
                >
                  <span className={toastCss.noticeFilePath}>{basename(file.path)}</span>
                  <span className={toastCss.noticeFileArrow} aria-hidden="true">↗</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notice.tone === 'error' && (
        <button type="button" className={toastCss.noticeDismissButton} onClick={onDone}>
          {dismissLabel}
        </button>
      )}
    </div>
  )
}

function addStats(left: DiffStats, right: DiffStats): DiffStats {
  return { added: left.added + right.added, removed: left.removed + right.removed }
}

/** Added and deleted counts in the card's colors; native renders the same pair. */
function Counts({ stats, label }: { readonly stats: DiffStats; readonly label: string }) {
  return (
    <span className={css.statCounts} aria-label={label}>
      <span className={css.added}>+{GROUPED.format(stats.added)}</span>
      <span className={css.deleted}>-{GROUPED.format(stats.removed)}</span>
    </span>
  )
}

/** The hover preview: path label plus the same comparison the sidebar shows. */
function ChangedFilePreview({
  display, reviews, t,
}: {
  readonly display: string
  readonly reviews: readonly ProducedFileReview[]
  readonly t: ProducedFilesProps['t']
}) {
  const diffs = reviews.flatMap(review => review.diffs)
  const hunks = toNativeHunks(diffs, 2)
  const note = diffNote(diffs, hunks, reviews.every(review => review.deleted === true))
  return (
    <div className={css.preview} data-changes-hover-preview="">
      <div className={css.previewHeader}>
        <span className={css.previewPath} data-changes-preview-path="">{display}</span>
      </div>
      <div className={css.previewBody}>
        <NativeDiff
          hunks={hunks}
          path={display}
          split={false}
          wrap={false}
          note={note}
          labels={{
            created: t('diff.created'),
            deleted: t('diff.deleted'),
            unchanged: t('diff.unchanged'),
            truncated: count => t('diff.truncated', { count }),
            loading: t('diff.loading'),
            missing: t('diff.missing'),
          }}
        />
      </div>
    </div>
  )
}

/**
 * Turn-tail list entry: claim the turn, then render the card.
 *
 * The claim test lives here rather than in a chain selector because
 * `conversation.chat.turnTail` is an additive `list` in dsh 0.2.0. Splitting
 * the test from the card keeps the card's hook order unconditional: the
 * wrapper holds no hooks, so early-returning null for an unsettled turn can
 * never change how many hooks the card below it calls.
 * @param props - turn-tail owner currency plus the plugin's injected face.
 * @returns the produced-files card, or null when this turn produced no files.
 */
export function ProducedFiles(props: ProducedFilesProps) {
  const reviews = selectProducedFiles(props)
  if (reviews === null) return null
  return <ProducedFilesCard {...props} reviews={reviews} />
}

/**
 * The card itself: the native ChangedFiles layout plus the two action buttons
 * in the header's top-right corner.
 */
function ProducedFilesCard({
  reviews, openFile, turn: turnLocation, projectRoot, reviewSessionId,
  inspectChanges = unavailableChanges, applyChanges = unavailableChanges,
  openInSidebarTab, t,
}: ProducedFilesProps & { readonly reviews: readonly ProducedFileReview[] }) {
  // The owning turn number (TurnLocation.turn) rides every deep link so the
  // sidebar tab expands this turn's rows only.
  const turnNumber = turnLocation.turn
  const [expanded, setExpanded] = useState(false)
  const [toggleAction, setToggleAction] = useState<FileReviewAction>('undo')
  const [statusPending, setStatusPending] = useState(true)
  const [togglePending, setTogglePending] = useState(false)
  const [statusVersion, setStatusVersion] = useState(0)
  const [toast, setToast] = useState<ToggleNotice | null>(null)
  const toastSeqRef = useRef(0)
  const cardRef = useRef<HTMLDivElement>(null)

  const reviewsWithStats = useMemo(() => reviews.map(review => ({
    review,
    stats: summarizeDiffs(review.diffs),
  })), [reviews])
  const totalStats = useMemo(
    () => reviewsWithStats.reduce<DiffStats>(
      (total, item) => addStats(total, item.stats),
      { added: 0, removed: 0 },
    ),
    [reviewsWithStats],
  )
  // Deleted paths carry no hunks and cannot be inspected or toggled; they are
  // display vocabulary on the rows only.
  const toggleFiles = useMemo(() => reviews
    .filter(review => review.deleted !== true)
    .map(review => ({ path: review.path, diffs: review.diffs })), [reviews])
  const reversiblePaths = useMemo(() => new Set(reviews.filter(review =>
    review.diffs.length > 0 && review.diffs.every(diff =>
      diff.path === review.path
      && diff.oldText !== null
      && diff.oldText !== diff.newText
      && (diff.oldText !== '' || diff.oldStart !== undefined)
      && (diff.newText !== '' || diff.newStart !== undefined))).map(review => review.path)), [reviews])
  const hasReversibleFiles = reversiblePaths.size > 0
  // Native folds at COLLAPSED_ROWS with "All N files"; a single file is
  // header-only, exactly like the built-in card.
  const singleFile = reviewsWithStats.length === 1 ? reviewsWithStats[0] : undefined
  const foldable = reviewsWithStats.length > COLLAPSED_ROWS
  const rows = foldable && !expanded ? reviewsWithStats.slice(0, COLLAPSED_ROWS) : reviewsWithStats
  const allPaths = useMemo(() => reviews.map(review => review.path), [reviews])
  const allDeleted = reviews.every(review => review.deleted === true)

  useEffect(() => {
    if (reviewSessionId === undefined) return
    return subscribeFileReviewInvalidation((ownerSessionId) => {
      if (ownerSessionId === reviewSessionId) setStatusVersion(value => value + 1)
    })
  }, [reviewSessionId])

  const openReview = useCallback((paths: readonly string[]) => {
    openInSidebarTab?.(paths, turnNumber)
  }, [openInSidebarTab, turnNumber])

  const showToast = useCallback((notice: Omit<ToggleNotice, 'seq'>) => {
    toastSeqRef.current += 1
    setToast({ seq: toastSeqRef.current, ...notice })
  }, [])

  const phaseForResult = useCallback((
    result: FileReviewResult,
    currentAction: FileReviewAction,
  ): FileReviewAction => {
    if (reversiblePaths.size === 0) return 'undo'
    const byPath = new Map(result.files.map(file => [file.path, file]))
    const target = currentAction === 'undo' ? 'undone' : 'applied'
    return [...reversiblePaths].every(path => byPath.get(path)?.state === target)
      ? (currentAction === 'undo' ? 'redo' : 'undo')
      : currentAction
  }, [reversiblePaths])

  useEffect(() => {
    let active = true
    setStatusPending(true)
    void inspectChanges({ action: 'undo', files: toggleFiles }).then((result) => {
      if (!active) return
      const allUndone = reversiblePaths.size > 0
        && [...reversiblePaths].every(path =>
          result.files.find(file => file.path === path)?.state === 'undone')
      setToggleAction(allUndone ? 'redo' : 'undo')
    }).catch(() => {
      // The action remains usable after a transient inspection failure; execution
      // performs the same Host-side checks again.
    }).finally(() => {
      if (active) setStatusPending(false)
    })
    return () => { active = false }
  }, [inspectChanges, reversiblePaths, statusVersion, toggleFiles])

  const runToggle = useCallback(() => {
    if (statusPending || togglePending || !hasReversibleFiles) return
    const action = toggleAction
    setTogglePending(true)
    void applyChanges({ action, files: toggleFiles }).then((result) => {
      setToggleAction(phaseForResult(result, action))
      const targetState = action === 'undo' ? 'undone' : 'applied'
      const byPath = new Map(result.files.map(file => [file.path, file]))
      const failures: NoticeFile[] = toggleFiles.flatMap((file) => {
        const outcome = byPath.get(file.path)
        if (outcome?.state === targetState) return []
        return [{ path: file.path }]
      })
      if (failures.length === 0) {
        showToast({
          tone: 'success',
          title: t(action === 'undo' ? 'produced.undoSuccess' : 'produced.redoSuccess'),
          files: [],
        })
        return
      }
      showToast({
        tone: 'error',
        title: t(action === 'undo' ? 'produced.undoPartial' : 'produced.redoPartial'),
        description: t(action === 'undo'
          ? 'produced.undoPartialDescription'
          : 'produced.redoPartialDescription'),
        files: failures,
      })
    }).catch((error: unknown) => {
      showToast({
        tone: 'error',
        title: t(action === 'undo' ? 'produced.undoError' : 'produced.redoError'),
        description: error instanceof Error ? error.message : String(error),
        files: [],
      })
    }).finally(() => { setTogglePending(false) })
  }, [
    applyChanges, hasReversibleFiles, phaseForResult, showToast, t,
    statusPending, toggleAction, toggleFiles, togglePending,
  ])

  const undoLabel = toggleAction === 'undo' ? t('produced.undo') : t('produced.redo')
  const undoPendingLabel = toggleAction === 'undo' ? t('produced.undoing') : t('produced.redoing')

  // Native header: tile + titles in one click target that opens the review.
  const headerMain = (
    <button
      type="button"
      className={css.headerMain}
      aria-label={singleFile === undefined
        ? t('produced.openReview')
        : t('produced.viewDiff', { name: singleFile.review.path })}
      title={singleFile?.review.path}
      onClick={() => { openReview(singleFile === undefined ? allPaths : [singleFile.review.path]) }}
    >
      <span className={css.tile}>
        {/* Native shows a generic code glyph for a mixed list and the real
            file-type glyph when the card represents one file. */}
        {singleFile === undefined
          ? <FileTypeIcon kind="code" size={20} />
          : <FileTypeIcon path={singleFile.review.path} size={20} />}
      </span>
      <span className={css.titles}>
        <span className={css.title}>
          {allDeleted
            ? t(singleFile === undefined ? 'produced.deletedAll' : 'produced.deletedOne', {
              count: String(reviewsWithStats.length),
            })
            : singleFile === undefined
              ? t('produced.edited', { count: String(reviewsWithStats.length) })
              : t('produced.editedOne', { name: basename(singleFile.review.path) })}
        </span>
        <span className={css.stat}>
          {allDeleted
            ? <span className={css.deletedBadge}>{t('produced.deleted')}</span>
            : (
              <Counts
                stats={singleFile?.stats ?? totalStats}
                label={t('review.stats', {
                  added: String((singleFile?.stats ?? totalStats).added),
                  removed: String((singleFile?.stats ?? totalStats).removed),
                })}
              />
            )}
          <span className={css.previewHint}>{t('produced.previewHint')}</span>
        </span>
      </span>
    </button>
  )

  return (
    <>
      <div
        ref={cardRef}
        className={css.card}
        data-changed-files=""
        data-single={singleFile !== undefined ? 'true' : undefined}
        data-file-review-tab=""
      >
        <div className={css.header}>
          {singleFile === undefined
            ? headerMain
            : (
              <HoverCard
                variant="preview"
                widthAnchorRef={cardRef}
                openDelayMs={500}
                anchor={headerMain}
                content={(
                  <ChangedFilePreview
                    display={displayPath(projectRoot, singleFile.review.path)}
                    reviews={[singleFile.review]}
                    t={t}
                  />
                )}
              />
            )}
          <div className={css.actions}>
            <button
              type="button"
              className={css.actionButton}
              disabled={statusPending || togglePending || !hasReversibleFiles}
              title={!hasReversibleFiles ? t('produced.toggleUnavailable') : undefined}
              aria-label={undoLabel}
              onClick={runToggle}
            >
              <IconRefreshOutlineRegular className={css.actionIcon} />
              {togglePending ? undoPendingLabel : undoLabel}
            </button>
            <button
              type="button"
              className={css.actionButton}
              aria-label={t('review.title')}
              onClick={() => { openReview(allPaths) }}
            >
              <IconListPenOutlineRegular className={css.actionIcon} />
              {t('review.title')}
            </button>
          </div>
        </div>

        {singleFile === undefined && (
          <ul className={css.list}>
            {rows.map(({ review, stats }) => (
              <li key={review.path}>
                <HoverCard
                  variant="preview"
                  widthAnchorRef={cardRef}
                  openDelayMs={500}
                  content={(
                    <ChangedFilePreview
                      display={displayPath(projectRoot, review.path)}
                      reviews={[review]}
                      t={t}
                    />
                  )}
                  anchor={(
                    <button
                      type="button"
                      className={css.row}
                      title={review.path}
                      aria-label={t('produced.viewDiff', { name: review.path })}
                      onClick={() => { openReview([review.path]) }}
                    >
                      <span className={css.path}>{review.path}</span>
                      <span className={css.counts}>
                        {review.deleted === true
                          ? <span className={css.deletedBadge}>{t('produced.deleted')}</span>
                          : (
                            <Counts
                              stats={stats}
                              label={t('review.stats', {
                                added: String(stats.added), removed: String(stats.removed),
                              })}
                            />
                          )}
                      </span>
                    </button>
                  )}
                />
              </li>
            ))}
          </ul>
        )}

        {foldable && (
          <button
            type="button"
            className={css.toggle}
            aria-expanded={expanded}
            aria-label={expanded
              ? t('produced.collapseAria')
              : t('produced.expandAria', { count: String(reviewsWithStats.length) })}
            onClick={() => { setExpanded(value => !value) }}
          >
            <span>
              {expanded
                ? t('produced.collapse')
                : t('produced.all', { count: String(reviewsWithStats.length) })}
            </span>
            {expanded ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
          </button>
        )}
      </div>

      {toast !== null && (
        <ResultToast
          key={toast.seq}
          notice={toast}
          closeLabel={t('produced.noticeClose')}
          dismissLabel={t('produced.noticeDismiss')}
          fileListLabel={t('produced.skippedFiles', { count: String(toast.files.length) })}
          fileOpenLabel={path => t('produced.open', { name: basename(path) })}
          openFile={openFile}
          onDone={() => { setToast(current => current?.seq === toast.seq ? null : current) }}
        />
      )}
    </>
  )
}
