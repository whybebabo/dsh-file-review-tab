/** Shared wire vocabulary for inspecting and toggling one turn's text changes. */

/** One validated contextual diff hunk attached to a produced file. */
export interface ProducedFileDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
  readonly oldStart?: number | undefined
  readonly newStart?: number | undefined
  /**
   * The engine reported that this hunk's old side did not exist, so the file was
   * created in this turn.
   *
   * This is deliberately SEPARATE from `oldText === null`, which cannot carry
   * the fact on its own: `null` also means "the prior content is not
   * reconstructable", and `mutation-call.ts` synthesizes exactly that for a
   * `write` overwrite, a `str_replace_editor insert` and an `edit` whose
   * `old_string` is empty — all of which are edits to files that already
   * existed. Only the two authoritative sources set this flag: the engine's
   * `meta.diffs` (whose schema documents null as "None for new files") and the
   * Host recorder's `before === null`.
   */
  readonly created?: true
  /**
   * Coordinate space this hunk's `oldStart`/`newStart` are expressed in.
   *
   * One path mutated several times in one turn accumulates hunks from several
   * settlements, and each settlement's line numbers refer to the text the
   * PREVIOUS settlement left behind — they are not interchangeable. Hunks
   * sharing this stamp are anchored in the same text and must be applied
   * back-to-front within it; groups apply in settlement order forward and in
   * reverse order backward (see `mutation-order.ts`).
   *
   * Optional: absent means "all of this path's hunks share one coordinate
   * space", the correct reading for the single-settlement payloads that
   * predate the field.
   */
  readonly mutation?: number | undefined
  /**
   * Event sequence this settlement happened at, used to order settlements.
   *
   * A file's history can be split across two channels — the conversation
   * snapshot (model-direct `edit`/`write`) and the Host recorder (nested
   * `run_code` dispatches) — which the tab merges asynchronously. Array order is
   * therefore a merge artifact, not history; this sequence is what restores the
   * real order. For a snapshot settlement it is the tool-result node's `seq`,
   * and for a recorded one the owning `run_code` root's `seq`.
   *
   * Optional: when absent the order is not provable and the array order stands.
   */
  readonly seq?: number | undefined
}

/** One produced file and the applied hunks available for review. */
export interface ProducedFileReview {
  readonly path: string
  readonly diffs: readonly ProducedFileDiff[]
  /**
   * The turn's terminal commands deleted this path (dsh has no delete-file
   * tool, so deletions arrive as parsed rm-family arguments). Deleted entries
   * carry no hunks, no undo, and no openable file — review-display vocabulary
   * only.
   */
  readonly deleted?: true
}

/** Direction requested by the produced-files toggle. */
export type FileReviewAction = 'undo' | 'redo'

/** One turn-scoped file supplied to the Host toggle service. */
export interface FileReviewChange {
  readonly path: string
  readonly diffs: readonly ProducedFileDiff[]
}

/** Host request for status inspection or one toggle direction. */
export interface FileReviewRequest {
  readonly action: FileReviewAction
  readonly files: readonly FileReviewChange[]
}

/** Current relationship between a file and the recorded turn change. */
export type FileReviewFileState = 'applied' | 'undone' | 'conflict' | 'unsupported' | 'error'

/** Per-file result; a request never hides skipped or failed files. */
export interface FileReviewFileResult {
  readonly path: string
  readonly state: FileReviewFileState
  readonly changed: boolean
  readonly reason?: string | undefined
}

/** Complete result returned by both Host endpoints. */
export interface FileReviewResult {
  readonly files: readonly FileReviewFileResult[]
}

/**
 * One mutation a Code Mode `run_code` program dispatched to a file-editing
 * tool, captured host-side with the FULL before/after content. The wire views
 * (diff cards) only ride model-direct tool/call frames; nested dispatches
 * carry neither a view nor hunks, so review of programmatic edits must
 * reconstruct the diff from these two snapshots instead.
 */
export interface RecordedMutation {
  /** The `run_code` call that owns this dispatch (its `callId`). */
  readonly rootCallId: string
  /** The dispatched tool name (`edit`, `write`, …). */
  readonly name: string
  /** Display path the tool reported; resolved against the session cwd. */
  readonly path: string
  /** Full file content before the mutation; `null` when the file was created. */
  readonly before: string | null
  /** Full file content after the mutation. */
  readonly after: string
}

/** Host request for the recorded Code Mode mutations of one session. */
export interface RecordedRequest {
  /** Root (`run_code`) call-ids whose recorded mutations are wanted. */
  readonly rootCallIds: readonly string[]
}

/** Host response: every requested root's mutations, in dispatch order. */
export interface RecordedResult {
  readonly mutations: readonly RecordedMutation[]
}

