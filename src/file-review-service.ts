/** Host-side, workspace-contained undo / redo service for produced text diffs. */

import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { hunksForApply, mutationGroups, orderBySequence } from './mutation-order.ts'
import { locateAnchors } from './anchor-locate.ts'
import { changeReversible } from './reversible.ts'
import type {
  AnchorRequest, AnchorResult, FileReviewAction, FileReviewChange, FileReviewFileResult,
  FileReviewRequest, FileReviewResult, RecordedAnchor, RecordedMutation,
  RecordedRequest, RecordedResult,
} from './change-types.ts'

type InspectState = Exclude<FileReviewFileResult['state'], 'error'>

interface InspectedFile {
  readonly state: InspectState
  readonly text?: string | undefined
  readonly nextText?: string | undefined
  readonly reason?: string | undefined
}

interface ResolvedFile {
  readonly filename: string
  readonly mode: number
  readonly bytes: Uint8Array
  /** Raw disk text (line endings as stored). */
  readonly text: string
  /** Whether the file uses CRLF line endings on disk. */
  readonly crlf: boolean
  /** Disk text normalized to the backend diff basis (LF), used for hunk math. */
  readonly lfText: string
}

/**
 * The mutation tools' recorded hunks (both diff cards and Code Mode
 * before/after values) ride the filesystem backend's LF-normalized basis,
 * while files on disk may use CRLF. All hunk matching therefore runs on the
 * normalized text; the write path restores the file's own line-ending style.
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function restoreNewlines(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\n/g, '\r\n') : text
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

async function resolveFile(cwd: string, requestedPath: string): Promise<ResolvedFile> {
  const root = await realpath(cwd)
  const candidate = resolve(root, requestedPath)
  if (!inside(root, candidate)) throw new Error('path is outside the session workspace')
  const linkStat = await lstat(candidate)
  if (linkStat.isSymbolicLink()) throw new Error('symbolic links are not supported')
  if (!linkStat.isFile()) throw new Error('path is not a regular file')
  const filename = await realpath(candidate)
  if (!inside(root, filename)) throw new Error('resolved path is outside the session workspace')
  const bytes = await readFile(filename)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('file is not valid UTF-8 text')
  const crlf = text.includes('\r')
  return { filename, mode: linkStat.mode & 0o777, bytes, text, crlf, lfText: normalizeNewlines(text) }
}

function offsetAtLine(text: string, line: number): number | null {
  if (!Number.isInteger(line) || line < 1) return null
  if (line === 1) return 0
  let offset = 0
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', offset)
    if (next === -1) return null
    offset = next + 1
  }
  return offset
}

function replaceHunk(
  text: string,
  source: string,
  replacement: string,
  line: number | undefined,
): string | null {
  let offset: number
  if (line !== undefined) {
    const located = offsetAtLine(text, line)
    if (located === null || text.slice(located, located + source.length) !== source) return null
    offset = located
  } else {
    if (source === '') return null
    offset = text.indexOf(source)
    if (offset === -1 || text.indexOf(source, offset + 1) !== -1) return null
  }
  return text.slice(0, offset) + replacement + text.slice(offset + source.length)
}

/** Apply a complete file's hunk sequence in memory, or report a strict mismatch. */
export function transformFile(
  text: string,
  file: FileReviewChange,
  action: FileReviewAction,
): string | null {
  if (!changeReversible(file.path, file.diffs)) {
    return null
  }
  // Hunks from different settlements are anchored in different texts, so the
  // group order follows settlement order backward for undo and forward for
  // redo; inside one settlement every hunk shares one coordinate space and must
  // run back-to-front, or a hunk that changes the line count shifts the anchors
  // of the hunks still waiting behind it (which made multi-hunk redo fail).
  //
  // The groups are ordered by their recorded event `seq` first: the two
  // producers of these hunks (conversation snapshot, Host recorder) are merged
  // asynchronously, so the incoming array order is a merge artifact and can
  // invert a `run_code` edit and a model-direct edit to the same file. When the
  // sequences are not all present the incoming order stands.
  const groups = orderBySequence(mutationGroups(file.diffs).map(group => ({
    seq: group[0]?.seq,
    diffs: group,
  }))).map(settlement => settlement.diffs)
  const ordered = action === 'undo' ? [...groups].reverse() : groups
  let next = text
  for (const group of ordered) {
    for (const diff of hunksForApply(group, action)) {
      const source = action === 'undo' ? diff.newText : diff.oldText
      const replacement = action === 'undo' ? diff.oldText : diff.newText
      if (source === null || replacement === null) return null
      const changed = replaceHunk(
        next,
        source,
        replacement,
        action === 'undo' ? diff.newStart : diff.oldStart,
      )
      if (changed === null) return null
      next = changed
    }
  }
  return next
}

function hunkSidePresent(text: string, file: FileReviewChange, side: 'old' | 'new'): boolean {
  for (const diff of file.diffs) {
    const source = side === 'old' ? diff.oldText : diff.newText
    if (source === null) continue
    const line = side === 'old' ? diff.oldStart : diff.newStart
    if (line !== undefined) {
      const located = offsetAtLine(text, line)
      if (located === null || text.slice(located, located + source.length) !== source) return false
    } else if (text.indexOf(source) === -1) {
      return false
    }
  }
  return true
}

function inspectText(text: string, file: FileReviewChange): InspectedFile {
  if (!changeReversible(file.path, file.diffs)) {
    return { state: 'unsupported', reason: 'change has no complete reversible diff' }
  }
  const undone = transformFile(text, file, 'undo')
  const redone = transformFile(text, file, 'redo')
  if (undone !== null && redone !== null) {
    // Both directions textually succeed. This is the classic pure-append
    // shape: the before hunks are a lead-in prefix of the after hunks, so
    // they are contained in the after state too. Decide by what the CURRENT
    // text actually contains: the after hunks are present => applied (undo
    // strips them); otherwise the change is undone and only before hunks
    // remain.
    return hunkSidePresent(text, file, 'new')
      ? { state: 'applied', text, nextText: undone }
      : { state: 'undone', text, nextText: redone }
  }
  if (undone !== null) return { state: 'applied', text, nextText: undone }
  if (redone !== null) return { state: 'undone', text, nextText: redone }
  return { state: 'conflict', reason: 'current content does not match the recorded change' }
}

async function inspectOne(cwd: string, file: FileReviewChange): Promise<FileReviewFileResult> {
  if (!changeReversible(file.path, file.diffs)) {
    return {
      path: file.path,
      state: 'unsupported',
      changed: false,
      reason: 'change has no complete reversible diff',
    }
  }
  try {
    const resolved = await resolveFile(cwd, file.path)
    const inspected = inspectText(resolved.lfText, file)
    return { path: file.path, state: inspected.state, changed: false, reason: inspected.reason }
  } catch (error) {
    return {
      path: file.path,
      state: 'error',
      changed: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

async function applyOne(
  cwd: string,
  file: FileReviewChange,
  action: FileReviewAction,
): Promise<FileReviewFileResult> {
  if (!changeReversible(file.path, file.diffs)) {
    return {
      path: file.path,
      state: 'unsupported',
      changed: false,
      reason: 'change has no complete reversible diff',
    }
  }
  try {
    const resolved = await resolveFile(cwd, file.path)
    const inspected = inspectText(resolved.lfText, file)
    const sourceState = action === 'undo' ? 'applied' : 'undone'
    const targetState = action === 'undo' ? 'undone' : 'applied'
    if (inspected.state === targetState) {
      return { path: file.path, state: targetState, changed: false }
    }
    if (inspected.state !== sourceState || inspected.nextText === undefined) {
      return { path: file.path, state: inspected.state, changed: false, reason: inspected.reason }
    }

    // Re-read immediately before commit. This is the closest available CAS fence for
    // external editors that do not participate in the package's writer lock.
    const current = await readFile(resolved.filename)
    if (!Buffer.from(resolved.bytes).equals(current)) {
      return {
        path: file.path,
        state: 'conflict',
        changed: false,
        reason: 'file changed while the operation was being prepared',
      }
    }
    await writeFileAtomic(
      resolved.filename,
      restoreNewlines(inspected.nextText, resolved.crlf),
      { mode: resolved.mode },
    )
    return { path: file.path, state: targetState, changed: true }
  } catch (error) {
    return {
      path: file.path,
      state: 'error',
      changed: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function sessionCwd(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (cwd === undefined || cwd.trim() === '') throw new Error('session has no workspace directory')
  return cwd
}

/** Per-agent cap on recorded Code Mode mutations (oldest evicted first). */
const RECORDED_PER_AGENT_CAP = 4000

/**
 * Per-agent cap on recorded hunk-coordinate sets (oldest evicted first).
 *
 * Kept separate from the Code Mode record log — and larger — because an anchor
 * set is tiny (two integers per hunk, never file content) and every mutation has
 * one, not just the programmatic ones.
 */
const ANCHORS_PER_AGENT_CAP = 8000

function agentKey(agent: Agent): string {
  return String(agent.id)
}

/** Host service published as the `fileReview` Remote namespace. */
export class FileReviewService extends TypertRemoteService {
  /** Per-agent record of Code Mode (`run_code`) file mutations, dispatch order. */
  private readonly recordLog = new Map<string, RecordedMutation[]>()

  /**
   * Per-agent map of call id to the hunk coordinates that call applied.
   *
   * Keyed by call id alone: a mutation call writes one path, so the id already
   * names the settlement the anchors belong to. Re-recording an id replaces its
   * entry (a replay never duplicates), and insertion order is what the cap
   * evicts by.
   */
  private readonly anchorLog = new Map<string, Map<string, RecordedAnchor>>()

  constructor(ctx: Context) {
    super(ctx, 'fileReview')
  }

  /** Append one nested (Code Mode) file mutation for the receiving agent. */
  recordMutation(agent: Agent, mutation: RecordedMutation): void {
    const key = agentKey(agent)
    const list = this.recordLog.get(key)
    if (list === undefined) {
      this.recordLog.set(key, [mutation])
      return
    }
    list.push(mutation)
    if (list.length > RECORDED_PER_AGENT_CAP) {
      list.splice(0, list.length - RECORDED_PER_AGENT_CAP)
    }
  }

  /**
   * Record one mutation's hunk coordinates, model-direct calls included.
   *
   * Called from `tools/post-execute` for every settled file mutation — that hook
   * is the last place the full before/after text exists, and therefore the only
   * place a hunk's absolute line numbers can still be recovered once the engine
   * has trimmed it down to context fragments.
   * @param agent - the agent that ran the mutation.
   * @param entry - the call id, path and per-hunk coordinates.
   */
  recordAnchors(agent: Agent, entry: RecordedAnchor): void {
    const key = agentKey(agent)
    let log = this.anchorLog.get(key)
    if (log === undefined) {
      log = new Map()
      this.anchorLog.set(key, log)
    }
    log.delete(entry.callId)
    log.set(entry.callId, entry)
    if (log.size > ANCHORS_PER_AGENT_CAP) {
      const oldest = log.keys().next()
      if (!oldest.done) log.delete(oldest.value)
    }
  }

  /**
   * Coordinates for the requested mutation calls.
   *
   * Two sources, in order. A call the recorder saw answers with the coordinates
   * captured at settlement — exact, and immune to later edits. A call it did not
   * (the plugin was installed or restarted after the change) is placed in the
   * file as it stands now, which is where the reviewer wants to look anyway, and
   * only when every one of its fragments matches exactly one place in the file.
   * A call that resolves neither way is simply absent: the client keeps that
   * hunk's fragment-relative count, so a missing entry can only cost the
   * improvement, never the diff itself.
   */
  async anchors(agent: Agent, request: AnchorRequest): Promise<AnchorResult> {
    if (request.calls.length === 0) return { anchors: [] }
    const log = this.anchorLog.get(agentKey(agent))
    const anchors: RecordedAnchor[] = []
    let cwd: string | null = null
    for (const call of request.calls) {
      const recorded = log?.get(call.callId)
      if (recorded !== undefined) {
        anchors.push(recorded)
        continue
      }
      if (call.path === '' || call.hunks.length === 0) continue
      try {
        cwd ??= sessionCwd(agent)
        const resolved = await resolveFile(cwd, call.path)
        const located = locateAnchors(resolved.lfText, call.hunks)
        if (located !== null) anchors.push({ callId: call.callId, path: call.path, anchors: located })
      } catch {
        // The file may be gone, outside the workspace, or not text: no
        // coordinates for this call, and the diff is unaffected.
      }
    }
    return { anchors }
  }

  /** Return the recorded mutations for the requested `run_code` roots. */
  async recorded(agent: Agent, request: RecordedRequest): Promise<RecordedResult> {
    const list = this.recordLog.get(agentKey(agent))
    if (list === undefined || request.rootCallIds.length === 0) return { mutations: [] }
    const wanted = new Set(request.rootCallIds)
    return { mutations: list.filter(mutation => wanted.has(mutation.rootCallId)) }
  }

  /** Inspect current disk state without changing files. */
  async status(agent: Agent, request: FileReviewRequest): Promise<FileReviewResult> {
    const cwd = sessionCwd(agent)
    const files = await Promise.all(request.files.map(file => inspectOne(cwd, file)))
    return { files }
  }

  /** Toggle every independently safe file while the receiving Agent is idle. */
  async apply(agent: Agent, request: FileReviewRequest): Promise<FileReviewResult> {
    const cwd = sessionCwd(agent)
    return agent.runMaintenance(async () => {
      const files: FileReviewFileResult[] = []
      for (const file of request.files) files.push(await applyOne(cwd, file, request.action))
      return { files }
    })
  }
}
