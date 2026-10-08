// FileReviewTab: the better-sidebar tab body.
//
// The header bar is a copy of dsh's own review tab (ReviewTab.module.css): a
// 38px row holding the file selector, the selected file's +/- counts, and the
// split and wrap controls. The selector covers the LATEST turn's changed files,
// so the header answers "what did the turn just finished change?" the way the
// built-in tab answers it for its own turn.
//
// Below the bar the tab keeps its own session-level body: every turn this
// session changed, each with inline red/green diffs. Undo/reapply and
// open-in-editor live there, per turn group and per file row, so those
// capabilities are preserved without putting non-native controls in the chrome.
//
// Diffs render through NativeDiff, a faithful port of dsh's FileDiff, so a diff
// here looks like a diff anywhere else in the app. All derivation rides the
// client runtime's finalized conversation snapshot.

import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  IconChevronDownOutlineRegular,
  IconCompareSplitOutlineRegular,
  IconNowrapFillRegular,
  IconRefreshOutlineRegular,
  IconWrapFillRegular,
  Menu,
  PathLabel,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  FileReviewAction, FileReviewFileState, FileReviewRequest, FileReviewResult,
  RecordedMutation, RecordedRequest, RecordedResult,
} from '../change-types.ts'
import {
  ARCHIVE_PAGE_TURNS, basename, deriveSessionChanges, deriveSessionRoots,
  mergeRecordedTurns, resolveSessionPath, splitArchivedTurns,
  type SessionFileChange, type TurnFileChanges,
} from './session-changes.ts'
import { diffNote, missingMessage, summarizeDiffs, toNativeHunks, type DiffStats } from './diff-hunks.ts'
import { NativeDiff, type NativeDiffLabels } from './NativeDiff.tsx'
import { t } from './locales.ts'
import {
  currentFileReviewSeed,
  publishFileReviewInvalidation,
  subscribeFileReviewInvalidation,
  subscribeFileReviewSeed,
  type FileReviewSeed,
} from './deep-link.ts'
import css from './FileReviewTab.module.css'

const SUCCESS_NOTICE_DURATION = 3000
const ERROR_NOTICE_DURATION = 8000
/** Grouped counts, matching the built-in card's own number formatting. */
const GROUPED = new Intl.NumberFormat('en-US')

/** Tab component props (a narrowing of better-sidebar's TabComponentProps). */
export interface FileReviewTabProps {
  readonly ctx: Context
  readonly sessionId: string
  readonly cwd: string | undefined
  /** Active tab + open panel; live status inspection pauses while false. */
  readonly visible: boolean
  /**
   * The sidebar tab handle. `meta.expandPaths` (string[]) is the deep link
   * the chat turn-tail row writes via updateTab/openTab: a fresh meta
   * reference replays as "expand those files' diffs and scroll to the first".
   */
  readonly tab: { readonly meta?: unknown }
}

interface FileReviewRemote {
  status(request: FileReviewRequest): Promise<RemoteResult<FileReviewResult>>
  apply(request: FileReviewRequest): Promise<RemoteResult<FileReviewResult>>
  recorded(request: RecordedRequest): Promise<RemoteResult<RecordedResult>>
}

/** Observable Conversation snapshot source (dsh 0.1.5 UiConversation binding). */
interface ConversationSource {
  getSnapshot(): ConversationSnapshot
  subscribe(listener: () => void): () => void
}

/** The slice of `ctx.uiConversation` this tab needs. */
interface UiConversationFace {
  binding(id: SessionId): { readonly snapshot: ConversationSource }
}

interface Notice {
  readonly seq: number
  readonly tone: 'success' | 'error'
  readonly text: string
}

/** One flattened (turn, file) change unit used for status requests. */
interface FlatChange {
  readonly turn: number
  readonly path: string
  readonly diffs: SessionFileChange['diffs']
  /** Deleted paths stay listed but never reach the Host inspector. */
  readonly deleted?: true
}

/** State map key for one (turn, file) change group. */
function stateKey(turn: number, path: string): string {
  return `${turn}|${path}`
}

/** Deep-link scroll target: the turn group for whole-turn links, else the row. */
interface PendingScroll {
  /** File-row stateKey: the precise target and the section fallback. */
  readonly rowKey: string
  /** Turn number whose group tops the viewport for multi-file links. */
  readonly turn: number | null
}

/** A change group is reversible only with complete contextual hunks. */
function isReversible(file: SessionFileChange): boolean {
  return file.diffs.length > 0 && file.diffs.every(diff =>
    diff.path === file.path
    && diff.oldText !== null
    && diff.oldText !== diff.newText
    && (diff.oldText !== '' || diff.oldStart !== undefined)
    && (diff.newText !== '' || diff.newStart !== undefined))
}

function addStats(left: DiffStats, right: DiffStats): DiffStats {
  return { added: left.added + right.added, removed: left.removed + right.removed }
}

/** The +/- pair, in the built-in card's own wording and colors. */
function Counts({ stats }: { readonly stats: DiffStats }) {
  return (
    <>
      <span className={css.added}>+{GROUPED.format(stats.added)}</span>
      <span className={css.deleted}>-{GROUPED.format(stats.removed)}</span>
    </>
  )
}

function Stats({ stats }: { readonly stats: DiffStats }) {
  return (
    <span className={css.stats} aria-label={t('stats', {
      added: String(stats.added), removed: String(stats.removed),
    })}>
      <span className={css.added}>+{stats.added}</span>
      <span className={css.removed}>-{stats.removed}</span>
    </span>
  )
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={css.buttonIcon}>
      <path d="M8 5 4 9l4 4M4 9h7a5 5 0 0 1 5 5v1" />
    </svg>
  )
}

function RedoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={css.buttonIcon}>
      <path d="m12 5 4 4-4 4M16 9H9a5 5 0 0 0-5 5v1" />
    </svg>
  )
}

function Chevron({ open }: { readonly open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={`${css.chevron} ${open ? css.chevronOpen : ''}`}
    >
      <path d="m7 5 5 5-5 5" />
    </svg>
  )
}

/** Per-(turn,file) host-inspected state badge; nothing renders for 'applied'. */
function StateBadge({ state }: { readonly state: FileReviewFileState | undefined }) {
  if (state === undefined || state === 'applied') return null
  const label = state === 'undone'
    ? t('stateUndone')
    : state === 'conflict'
      ? t('stateConflict')
      : state === 'unsupported'
        ? t('stateUnsupported')
        : t('stateError')
  const tone = state === 'undone'
    ? css.badgeUndone
    : state === 'unsupported'
      ? css.badgeMuted
      : css.badgeError
  return <span className={`${css.stateBadge} ${tone}`}>{label}</span>
}

/** Mounts the heavy diff renderer only when the row nears the viewport. */
function LazyDiff({ children }: { children: ReactNode }) {
  const holderRef = useRef<HTMLDivElement | null>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (inView) return
    const element = holderRef.current
    if (element === null) return
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setInView(true)
        observer.disconnect()
      }
    }, { rootMargin: '200px 0px' })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [inView])
  return <div ref={holderRef}>{inView ? children : <div style={{ minHeight: '96px' }} />}</div>
}

/** The sidebar tab body: per-turn change groups with inline diffs and undo. */
export function FileReviewTab({ ctx, sessionId, cwd, visible, tab }: FileReviewTabProps) {
  const sessions = (ctx as unknown as { readonly sessions: ISessions }).sessions
  const [states, setStates] = useState<ReadonlyMap<string, FileReviewFileState>>(() => new Map())
  const [statusPending, setStatusPending] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState<Notice | null>(null)
  const [split, setSplit] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [statusVersion, setStatusVersion] = useState(0)
  const noticeSeqRef = useRef(0)
  const noticeTimerRef = useRef<number | null>(null)

  useEffect(() => subscribeFileReviewInvalidation((ownerSessionId) => {
    if (ownerSessionId === sessionId) setStatusVersion(value => value + 1)
  }), [sessionId])

  useEffect(() => {
    if (!visible) return
    const refresh = () => { setStatusVersion(value => value + 1) }
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh) }
  }, [visible])

  // Live Conversation projection for THIS session. dsh 0.1.5 moved the
  // projection off SessionFace (whose getSnapshot now returns the session
  // lifecycle snapshot) onto the uiConversation binding's `snapshot` source.
  const uiConversation = (ctx as unknown as { get(name: string): unknown })
    .get('uiConversation') as UiConversationFace | undefined
  let conversationSource: ConversationSource | undefined
  try {
    conversationSource = uiConversation?.binding(sessionId as SessionId).snapshot
  } catch {
    // The session may not have a binding yet (fresh/archived); the tab shows
    // its empty state and re-derives once a snapshot is available.
    conversationSource = undefined
  }
  const subscribe = useCallback(
    (listener: () => void) => conversationSource?.subscribe(listener) ?? (() => {}),
    [conversationSource],
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    () => conversationSource?.getSnapshot() ?? null,
  )

  // Code Mode (run_code) roots and their Host-recorded mutations: nested
  // dispatches carry no reuseable views, so each root's file changes are
  // fetched async and merged into the snapshot-derived turns below. The
  // fetch re-arms on the root set (a new run_code turn) or a manual refresh.
  const roots = useMemo(
    () => (snapshot === null ? [] : deriveSessionRoots(snapshot)),
    [snapshot],
  )
  const rootsKey = useMemo(
    () => roots.map(root => root.rootCallId).join('|'),
    [roots],
  )
  const [recorded, setRecorded] = useState<readonly RecordedMutation[]>(() => [])
  useEffect(() => {
    if (!visible || roots.length === 0) return
    let active = true
    const timer = window.setTimeout(() => {
      const scope = sessions.scope(sessionId as SessionId)
      const remote = scope?.get('remote.fileReview') as FileReviewRemote | undefined
      if (scope === undefined || remote === undefined) { active = false; return }
      remote.recorded({ rootCallIds: roots.map(root => root.rootCallId) })
        .then((result) => {
          if (!result.ok || !active) return
          setRecorded(result.value.mutations)
        })
        .catch(() => {
          // Transient fetch failure: keep the previous record; the next
          // snapshot, focus or review action retries.
        })
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rootsKey, statusVersion, sessions, sessionId])

  const turns = useMemo(
    () => mergeRecordedTurns(deriveSessionChanges(snapshot), roots, recorded),
    [snapshot, roots, recorded],
  )
  // Auto-archive: only the newest turns stay in the main list; older completed
  // turns collapse into the tab's bottom section, which renders nothing until
  // opened and then only ARCHIVE_PAGE_TURNS groups per loaded page — long
  // sessions no longer mount dozens of diff groups.
  const { main: mainTurns, archived: archivedTurns } = useMemo(
    () => splitArchivedTurns(turns),
    [turns],
  )
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archivePages, setArchivePages] = useState(1)
  // Archive UI state persists per session, so reopening a long session
  // doesn't re-mount everything the user already collapsed away.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`dsh-file-review-tab:archive:${sessionId}`)
      const parsed = raw === null ? undefined : JSON.parse(raw) as { open?: unknown; pages?: unknown }
      setArchiveOpen(parsed?.open === true)
      setArchivePages(
        typeof parsed?.pages === 'number' && Number.isInteger(parsed.pages) && parsed.pages >= 1
          ? parsed.pages
          : 1,
      )
    } catch {
      setArchiveOpen(false)
      setArchivePages(1)
    }
  }, [sessionId])
  useEffect(() => {
    try {
      window.localStorage.setItem(
        `dsh-file-review-tab:archive:${sessionId}`,
        JSON.stringify({ open: archiveOpen, pages: archivePages }),
      )
    } catch {
      // Storage unavailable (private mode &c.): archive state stays in-memory.
    }
  }, [sessionId, archiveOpen, archivePages])
  // Collapsed ⇒ nothing from the archive mounts; open ⇒ the loaded pages only.
  const archivedVisible = useMemo(
    () => (archiveOpen
      ? archivedTurns.slice(0, archivePages * ARCHIVE_PAGE_TURNS)
      : []),
    [archiveOpen, archivePages, archivedTurns],
  )
  const archivedRemaining = archivedTurns.length - archivedVisible.length
  const renderedTurns = useMemo(
    () => [...mainTurns, ...archivedVisible],
    [mainTurns, archivedVisible],
  )
  const flat = useMemo<FlatChange[]>(
    () => renderedTurns.flatMap(turn => turn.files.map(file => ({
      turn: turn.turn, path: file.path, diffs: file.diffs,
      ...(file.deleted === true ? { deleted: true as const } : {}),
    }))),
    [renderedTurns],
  )
  // Deleted entries have nothing to inspect or toggle on the Host side.
  const inspectable = useMemo(
    () => flat.filter(item => item.deleted !== true),
    [flat],
  )
  // Stable content key: the inspect effect re-fires only when the change SET
  // changes, not on every token-flush snapshot identity bump.
  const flatKey = useMemo(
    () => flat.map(item => `${item.turn}|${item.path}|${item.diffs.length}`).join(';'),
    [flat],
  )
  const flatRef = useRef(flat)
  flatRef.current = flat
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const archivedTurnsRef = useRef(archivedTurns)
  archivedTurnsRef.current = archivedTurns

  // Deep-link plumbing: file-row elements by stateKey and turn-group sections
  // by turn number for scrolling, the last replayed meta reference, and a
  // pending scroll target.
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const turnRefs = useRef(new Map<number, HTMLElement>())
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const lastSeedNonceRef = useRef<number | undefined>(undefined)
  const pendingScrollRef = useRef<PendingScroll | null>(null)

  // The header selector covers the LATEST turn's changed files only. Native's
  // review tab is per-turn, and a session-wide list made the header answer a
  // question the body answers better: every turn is listed below with its own
  // diffs and toggles. `turns` is ascending, so its last entry is the newest
  // change-bearing turn, and a path edited again in a later turn appears here at
  // that latest revision.
  const sessionFiles = useMemo<readonly FlatChange[]>(() => {
    const latest = turns.length === 0 ? undefined : turns[turns.length - 1]
    if (latest === undefined) return []
    return latest.files.map(file => ({
      turn: latest.turn,
      path: file.path,
      diffs: file.diffs,
      ...(file.deleted === true ? { deleted: true as const } : {}),
    }))
  }, [turns])
  // The list is replaced wholesale when a new turn lands, so a carried-over
  // index would silently select an unrelated file (index 3 of the previous turn
  // is not index 3 of this one). Restart at the newest turn's first file, which
  // is what the built-in per-turn tab shows when it switches turns.
  const latestTurnNumber = turns.length === 0 ? null : turns[turns.length - 1]!.turn
  useEffect(() => {
    setSelectedIndex(0)
    setMenuOpen(false)
  }, [latestTurnNumber])
  const selected = sessionFiles[Math.min(selectedIndex, Math.max(0, sessionFiles.length - 1))]
  const selectedStats = useMemo(
    () => (selected === undefined ? { added: 0, removed: 0 } : summarizeDiffs(selected.diffs)),
    [selected],
  )

  // Sidebar-tab deep link: the chat row's 审查 button (and per-file chips)
  // publish a session-scoped seed through this plugin's own channel, then
  // open/focus this tab by type. better-sidebar 0.19.1 cannot refresh an
  // already-open native tab's `meta` (and a `path` seed would be routed to the
  // file editor), so the seed channel is the only reliable delivery path.
  // Replaying merges into the user's own expanded set, never replacing it, and
  // queues a scroll that lands the link's target at the top of the tab body.
  const replayLink = useCallback((paths: readonly string[], targetTurn: number | undefined) => {
    if (paths.length === 0) return
    // A link into an auto-archived turn must first make that turn render:
    // open the archive section and page to the owning group. The rows then
    // mount, flatKey re-arms, and the pending scroll below lands on them.
    const ownerTurn = targetTurn !== undefined
      ? turnsRef.current.find(turn => turn.turn === targetTurn)
      : turnsRef.current.find(turn => turn.files.some(file => paths.includes(file.path)))
    if (ownerTurn !== undefined && ownerTurn.live !== true) {
      const archivedIndex = archivedTurnsRef.current.findIndex(turn => turn.turn === ownerTurn.turn)
      if (archivedIndex !== -1) {
        setArchiveOpen(true)
        setArchivePages((current) =>
          Math.max(current, Math.ceil((archivedIndex + 1) / ARCHIVE_PAGE_TURNS)))
      }
    }
    // With a turn anchor only THAT turn's rows expand — a path that recurs in
    // other turns stays collapsed there; without one, every occurrence expands
    // (legacy meta shape).
    const matches = (item: FlatChange): boolean =>
      paths.includes(item.path) && (targetTurn === undefined || item.turn === targetTurn)
    setExpanded((current) => {
      const next = new Set(current)
      for (const item of flatRef.current) {
        if (matches(item)) next.add(stateKey(item.turn, item.path))
      }
      return next
    })
    const first = flatRef.current.find(item => matches(item))
    // Multi-path links (the 审查 button) target the turn group so the whole
    // review leads the viewport; single-path links (a file chip) target that
    // file's row. An unmatched link leaves nothing pending.
    pendingScrollRef.current = first === undefined ? null : {
      rowKey: stateKey(first.turn, first.path),
      turn: paths.length > 1 ? first.turn : null,
    }
  }, [])

  useEffect(() => {
    const replay = (seed: FileReviewSeed): void => {
      if (lastSeedNonceRef.current === seed.nonce) return
      lastSeedNonceRef.current = seed.nonce
      replayLink(seed.paths, seed.turn)
    }
    const pending = currentFileReviewSeed(sessionId)
    if (pending !== undefined) replay(pending)
    return subscribeFileReviewSeed((ownerSessionId, seed) => {
      if (ownerSessionId === sessionId) replay(seed)
    })
  }, [sessionId, replayLink])

  // Legacy meta fallback (better-sidebar versions that still deliver
  // `expandPaths` through tab.meta); harmless when no meta is ever written.
  useEffect(() => {
    const meta = tab.meta
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return
    const raw = (meta as { expandPaths?: unknown }).expandPaths
    if (!Array.isArray(raw)) return
    const paths = raw.filter((value): value is string => typeof value === 'string')
    const turnNo = (meta as { turn?: unknown }).turn
    const targetTurn = typeof turnNo === 'number' && Number.isInteger(turnNo) ? turnNo : undefined
    replayLink(paths, targetTurn)
  }, [tab.meta, replayLink])

  // Scroll the deep-linked target to the TOP of the tab body — aligning to
  // the center left long reviews straddling the viewport, reading like a
  // miss. Whole-turn links resolve to the turn group (its header first);
  // single-file links to that file's row, which is also the fallback when
  // the section is not mounted. The target stays pending while its element
  // cannot be found (the session snapshot may still be streaming in), so
  // `flatKey` re-arms the scroll once the rows mount, and `visible` defers
  // it while the panel is still opening. The delayed second call covers the
  // diff bodies mounting one layout pass after the expansion commit.
  //
  // The scroll is computed and dispatched on the tab's OWN body only:
  // element.scrollIntoView({ block: 'start' }) scrolls EVERY scrollable
  // ancestor by specification, and in the sidebar panel that drags outer
  // containers along — the panel's tab-strip header rides above the body
  // inside one of them and gets scrolled out of view.
  useEffect(() => {
    if (!visible) return
    const pending = pendingScrollRef.current
    if (pending === null) return
    const element = (pending.turn !== null ? turnRefs.current.get(pending.turn) : undefined)
      ?? rowRefs.current.get(pending.rowKey)
    if (element === undefined) return
    pendingScrollRef.current = null
    const scroll = () => {
      const container = bodyRef.current
      if (container === null) return
      const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top
      container.scrollTo({ top: container.scrollTop + delta - 8, behavior: 'smooth' })
    }
    scroll()
    const timer = window.setTimeout(scroll, 150)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, expanded, tab.meta, flatKey])

  const showNotice = useCallback((tone: Notice['tone'], text: string) => {
    noticeSeqRef.current += 1
    const seq = noticeSeqRef.current
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(
      () => { setNotice(current => current?.seq === seq ? null : current) },
      tone === 'success' ? SUCCESS_NOTICE_DURATION : ERROR_NOTICE_DURATION,
    )
    setNotice({ seq, tone, text })
  }, [])

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
  }, [])

  // The Remote invocation path mirrors dsh-file-review: session scopes are
  // minted by the client runtime and cannot statically inject namespaces
  // contributed later, so the namespace rides ctx.get on the session scope.
  const invoke = useCallback(async (
    method: 'status' | 'apply',
    request: FileReviewRequest,
  ): Promise<FileReviewResult> => {
    const scope = sessions.scope(sessionId as SessionId)
    if (scope === undefined) throw new Error(t('sessionUnavailable'))
    const remote = scope.get('remote.fileReview') as FileReviewRemote | undefined
    if (remote === undefined) throw new Error(t('remoteUnavailable'))
    const result = await remote[method](request)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }, [sessions, sessionId])

  // Host-side state inspection: which recorded changes are still applied,
  // already undone, or in conflict. Paused while the tab is not visible.
  useEffect(() => {
    if (!visible || flat.length === 0) return
    let active = true
    setStatusPending(true)
    // Debounce trailing-edge: streaming turns keep bumping flatKey per hunk;
    // only one host round-trip survives a 300ms quiet window.
    const timer = window.setTimeout(() => {
      const request: FileReviewRequest = {
        action: 'undo',
        files: inspectable.map(item => ({ path: item.path, diffs: item.diffs })),
      }
      invoke('status', request).then((result) => {
        if (!active) return
        setStates(() => {
          const next = new Map<string, FileReviewFileState>()
          inspectable.forEach((item, index) => {
            const file = result.files[index]
            if (file !== undefined) next.set(stateKey(item.turn, item.path), file.state)
          })
          return next
        })
      }).catch(() => {
        // Transient inspection failure: the buttons stay usable — apply runs
        // the same Host-side checks again before touching disk.
      }).finally(() => {
        if (active) setStatusPending(false)
      })
    }, 300)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, flatKey, statusVersion, invoke])

  const mergeResultStates = useCallback((
    items: readonly FlatChange[],
    result: FileReviewResult,
  ) => {
    setStates((current) => {
      const next = new Map(current)
      items.forEach((item, index) => {
        const file = result.files[index]
        if (file !== undefined) next.set(stateKey(item.turn, item.path), file.state)
      })
      return next
    })
  }, [])

  /** Toggle one change set (a whole turn, or one file) undo ↔ redo. */
  const runToggle = useCallback((
    key: string,
    items: readonly FlatChange[],
    action: FileReviewAction,
  ) => {
    if (busyKey !== null || items.length === 0) return
    setBusyKey(key)
    invoke('apply', {
      action,
      files: items.map(item => ({ path: item.path, diffs: item.diffs })),
    }).then((result) => {
      mergeResultStates(items, result)
      publishFileReviewInvalidation(sessionId)
      const target = action === 'undo' ? 'undone' : 'applied'
      const failures = result.files.filter(file => file.state !== target)
      if (failures.length === 0) {
        showNotice('success', t(action === 'undo' ? 'undoSuccess' : 'redoSuccess'))
      } else {
        showNotice('error', t(action === 'undo' ? 'undoPartial' : 'redoPartial'))
      }
    }).catch((error: unknown) => {
      showNotice('error', `${t('toggleError')}: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { setBusyKey(null) })
  }, [busyKey, invoke, mergeResultStates, sessionId, showNotice])

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const openInEditor = useCallback((path: string) => {
    const absolute = resolveSessionPath(cwd, path)
    const sidebar = (ctx as unknown as {
      betterSidebar?: { openFile(scope: { sessionId: string; cwd?: string }, path: string, title?: string): void }
    }).betterSidebar
    sidebar?.openFile({ sessionId, ...(cwd !== undefined ? { cwd } : {}) }, absolute, basename(absolute))
  }, [ctx, cwd, sessionId])

  /** Selecting a file from the header expands its row and scrolls to it. */
  const selectFile = useCallback((index: number) => {
    const entry = sessionFiles[index]
    setSelectedIndex(index)
    setMenuOpen(false)
    if (entry === undefined) return
    const key = stateKey(entry.turn, entry.path)
    setExpanded(current => new Set([...current, key]))
    pendingScrollRef.current = { rowKey: key, turn: null }
  }, [sessionFiles])

  const renderTurn = (turn: TurnFileChanges) => {
    const turnStats = turn.files.reduce<DiffStats>(
      (total, file) => addStats(total, summarizeDiffs(file.diffs)),
      { added: 0, removed: 0 },
    )
    const reversible = turn.files.filter(isReversible)
    const allUndone = reversible.length > 0
      && reversible.every(file => states.get(stateKey(turn.turn, file.path)) === 'undone')
    const turnAction: FileReviewAction = allUndone ? 'redo' : 'undo'
    const turnKey = `turn:${turn.turn}`
    const turnBusy = busyKey === turnKey
    return (
      <section
        key={turn.turn}
        ref={(element) => {
          if (element === null) turnRefs.current.delete(turn.turn)
          else turnRefs.current.set(turn.turn, element)
        }}
        className={css.turnGroup}
      >
        <header className={css.turnHeader}>
          <span className={css.turnTitle}>{t('turn', { n: turn.turn })}</span>
          {turn.live && <span className={css.liveBadge}>{t('turnLive')}</span>}
          <span className={css.turnCount}>
            {turn.files.length === 1 ? t('filesOne') : t('files', { count: turn.files.length })}
          </span>
          <Stats stats={turnStats} />
          <button
            type="button"
            className={css.actionButton}
            disabled={statusPending || busyKey !== null || reversible.length === 0}
            title={reversible.length === 0 ? t('toggleUnavailable') : undefined}
            onClick={() => {
              runToggle(turnKey, turn.files.filter(file => file.deleted !== true).map(file => ({
                turn: turn.turn, path: file.path, diffs: file.diffs,
              })), turnAction)
            }}
          >
            {turnAction === 'undo' ? <UndoIcon /> : <RedoIcon />}
            {turnBusy
              ? t(turnAction === 'undo' ? 'undoing' : 'redoing')
              : t(turnAction === 'undo' ? 'undoTurn' : 'redoTurn')}
          </button>
        </header>
        <ul className={css.fileList}>
          {turn.files.map(file => renderFile(turn, file))}
        </ul>
      </section>
    )
  }

  /** Render one changed file row plus its inline diff when expanded. */
  const renderFile = (turn: TurnFileChanges, file: SessionFileChange) => {
    const key = stateKey(turn.turn, file.path)
    const isOpen = expanded.has(key)
    const state = states.get(key)
    const reversible = isReversible(file)
    const fileAction: FileReviewAction = state === 'undone' ? 'redo' : 'undo'
    const fileBusy = busyKey === key
    const stats = summarizeDiffs(file.diffs)
    // Built once and shared with the render; the renderer itself decides
    // whether a one-sided change can use the side-by-side layout.
    const hunks = isOpen ? toNativeHunks(file.diffs, 3) : []
    return (
      <li
        key={file.path}
        className={css.fileItem}
        ref={(element) => {
          if (element === null) rowRefs.current.delete(key)
          else rowRefs.current.set(key, element)
        }}
      >
        <div
          className={css.fileRow}
          role="button"
          tabIndex={0}
          title={file.path}
          aria-expanded={isOpen}
          onClick={() => { toggleExpanded(key) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleExpanded(key)
            }
          }}
        >
          <Chevron open={isOpen} />
          <span className={css.fileName}>{basename(file.path)}</span>
          {file.deleted === true
            ? <span className={css.deletedBadge}>{t('deleted')}</span>
            : <Stats stats={stats} />}
          {file.deleted !== true && <StateBadge state={state} />}
          {file.deleted !== true && (
            <button
              type="button"
              className={`${css.smallButton} ${css.editorButton}`}
              onClick={(event) => {
                event.stopPropagation()
                openInEditor(file.path)
              }}
            >
              {t('openInEditor')}
            </button>
          )}
          <button
            type="button"
            className={css.smallButton}
            disabled={statusPending || busyKey !== null || !reversible}
            title={file.deleted === true
              ? t('deletedHint')
              : (!reversible ? t('toggleUnavailable') : undefined)}
            onClick={(event) => {
              event.stopPropagation()
              runToggle(key, [{ turn: turn.turn, path: file.path, diffs: file.diffs }], fileAction)
            }}
          >
            {fileBusy
              ? t(fileAction === 'undo' ? 'undoing' : 'redoing')
              : t(fileAction === 'undo' ? 'undo' : 'redo')}
          </button>
        </div>
        {isOpen && (
          <div className={css.diffWrap}>
            <LazyDiff>
              {file.deleted === true || file.diffs.length === 0
                // Both of this plugin's "no comparison" cases map onto native's
                // own missing state, drawn by the comparison itself. A
                // terminal-deleted file keeps its own explanation: the content
                // was never missing, it is gone, and the row's tooltip already
                // says so — the body must not contradict it.
                ? (
                  <NativeDiff
                    hunks={[]}
                    path={file.path}
                    split={split}
                    wrap={wrap}
                    status="missing"
                    labels={{
                      ...diffLabels,
                      missing: missingMessage(file.deleted === true, t('deletedHint'), diffLabels.missing),
                    }}
                  />
                )
                : (
                  <NativeDiff
                    hunks={hunks}
                    path={file.path}
                    split={split}
                    wrap={wrap}
                    note={diffNote(file.diffs, hunks)}
                    labels={diffLabels}
                  />
                )}
            </LazyDiff>
          </div>
        )}
      </li>
    )
  }

  // One stable label set for every comparison this tab draws.
  const diffLabels: NativeDiffLabels = {
    created: t('diffCreated'),
    deleted: t('diffDeleted'),
    unchanged: t('diffUnchanged'),
    truncated: count => t('diffTruncated', { count }),
    loading: t('diffLoading'),
    missing: t('diffMissing'),
  }

  return (
    <div className={css.root} data-changes-review="" data-file-review-tab="">
      <div className={css.header}>
        {selected === undefined
          ? <span className={css.selectorLabel}>{t('tabTitle')}</span>
          : (
            <Menu
              className={css.selector}
              open={menuOpen}
              autoFocus
              portal
              align="start"
              dense
              onClose={() => { setMenuOpen(false) }}
              anchor={(
                <button
                  type="button"
                  className={css.selectorButton}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={t('selectFile')}
                  title={selected.path}
                  data-review-file={selected.path}
                  onClick={() => { setMenuOpen(value => !value) }}
                >
                  <PathLabel path={selected.path} />
                  <IconChevronDownOutlineRegular size={12} />
                </button>
              )}
              items={sessionFiles.map((entry, at) => ({
                id: String(at),
                label: (
                  <span className={css.item}>
                    <span className={css.itemPath}>{entry.path}</span>
                    <span className={css.itemCounts}>
                      {entry.deleted === true
                        ? <span className={css.label}>{t('deleted')}</span>
                        : <Counts stats={summarizeDiffs(entry.diffs)} />}
                    </span>
                  </span>
                ),
              }))}
              selectedId={String(selectedIndex)}
              onSelect={(id) => { selectFile(Number(id)) }}
            />
          )}
        {selected !== undefined && (
          <span className={css.counts}>
            {selected.deleted === true
              ? <span className={css.label}>{t('deleted')}</span>
              : <Counts stats={selectedStats} />}
          </span>
        )}
        <span className={css.tools}>
          <Tooltip label={t(split ? 'unified' : 'split')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-pressed={split}
              aria-label={t('splitAria')}
              data-review-tool="split"
              onClick={() => { setSplit(value => !value) }}
            >
              <IconCompareSplitOutlineRegular className={css.compareIcon} />
            </button>
          </Tooltip>
          <Tooltip label={t(wrap ? 'nowrap' : 'wrap')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-pressed={wrap}
              aria-label={t('wrapAria')}
              data-review-tool="wrap"
              onClick={() => { setWrap(value => !value) }}
            >
              {wrap ? <IconNowrapFillRegular /> : <IconWrapFillRegular />}
            </button>
          </Tooltip>
          {/* Re-check every row's Host-side state on demand. Automatic
              invalidation covers the common paths (this tab's own toggles, the
              chat card, window focus), but a file changed outside the app while
              this tab stayed focused has no event to ride — this is the
              explicit escape hatch, and it reports progress while it runs. */}
          <Tooltip label={t('refresh')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-label={t('refreshAria')}
              data-review-tool="refresh"
              data-pending={statusPending ? '' : undefined}
              disabled={statusPending || flat.length === 0}
              onClick={() => { setStatusVersion(value => value + 1) }}
            >
              <IconRefreshOutlineRegular />
            </button>
          </Tooltip>
        </span>
      </div>
      {notice !== null && (
        <div
          className={`${css.notice} ${notice.tone === 'success' ? css.noticeSuccess : css.noticeError}`}
          role="alert"
        >
          {notice.text}
        </div>
      )}
      <div className={css.body} ref={bodyRef}>
        {turns.length === 0
          ? <div className={css.empty}>{t('empty')}</div>
          : (
            <>
              {mainTurns.map(renderTurn)}
              {archivedTurns.length > 0 && (
                <div className={css.archiveSection}>
                  <button
                    type="button"
                    className={css.archiveHeader}
                    aria-expanded={archiveOpen}
                    aria-label={archiveOpen ? t('archivedCollapse') : t('archivedExpand')}
                    onClick={() => { setArchiveOpen(current => !current) }}
                  >
                    <Chevron open={archiveOpen} />
                    <span className={css.archiveTitle}>
                      {t('archived', { n: String(archivedTurns.length) })}
                    </span>
                  </button>
                  {/* Collapsed ⇒ zero archived groups mount; open ⇒ only the
                      loaded pages render, each diff row still lazy. */}
                  {archiveOpen && (
                    <>
                      {archivedVisible.map(renderTurn)}
                      {archivedRemaining > 0 && (
                        <button
                          type="button"
                          className={css.archiveLoadMore}
                          onClick={() => { setArchivePages(current => current + 1) }}
                        >
                          {t('loadMore', { n: String(archivedRemaining) })}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
      </div>
    </div>
  )
}
