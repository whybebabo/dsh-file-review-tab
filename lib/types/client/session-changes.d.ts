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
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ProducedFileDiff, RecordedMutation } from '../change-types.ts';
/** One changed file inside one turn, hunks appended in settlement order. */
export interface SessionFileChange {
    readonly path: string;
    readonly diffs: readonly ProducedFileDiff[];
    /** Terminal commands deleted this path in this turn (display-only). */
    readonly deleted?: true;
    /**
     * Event sequence the pending deletion happened at. A deletion is an event, so
     * a cross-channel write with a LATER sequence proves the path was recreated
     * and clears the flag. Absent when the snapshot omitted the sequence, in which
     * case the deletion is kept (the conservative reading).
     */
    readonly deletedSeq?: number | undefined;
}
/** One turn's produced files, in first-seen order. */
export interface TurnFileChanges {
    readonly turn: number;
    /** Whether the owning turn is still running (its change set may grow). */
    readonly live: boolean;
    readonly files: readonly SessionFileChange[];
}
/** Derive per-turn produced-file changes for one session snapshot. */
export declare function deriveSessionChanges(snapshot: ConversationSnapshot | null): TurnFileChanges[];
/**
 * One Code Mode (`run_code`) root visible in the snapshot, with the turn it
 * settles into. The snapshot now carries settled `subCalls` with their own
 * call heads and result metadata, so those are the primary source; this root
 * list only feeds the Host recorder fallback for roots whose nested facts did
 * not survive into the snapshot.
 */
export interface SessionRoot {
    readonly turn: number;
    readonly live: boolean;
    readonly rootCallId: string;
    /**
     * The root node's event sequence, or undefined when the snapshot omitted it.
     * A recorded mutation is a nested dispatch of this root, so this is the
     * sequence its changes are ordered by — it is what lets a `run_code` edit be
     * merged into the right position among the turn's model-direct edits. When it
     * is unknown the merge keeps array order rather than guessing.
     */
    readonly seq: number | undefined;
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
    readonly progress: number;
}
/** Every `run_code` tool-result node whose nested changes are not in the snapshot. */
export declare function deriveSessionRoots(snapshot: ConversationSnapshot): SessionRoot[];
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
export declare function mergeRecordedTurns(turns: readonly TurnFileChanges[], roots: readonly SessionRoot[], recorded: readonly RecordedMutation[]): readonly TurnFileChanges[];
/** Count distinct changed paths across every turn (the sidebar badge count). */
export declare function countChangedFiles(turns: readonly TurnFileChanges[]): number;
/**
 * Turns that stay in the review tab's MAIN list: the newest
 * {@link ARCHIVE_KEEP_TURNS} turns plus every live (still-running) turn.
 * Older completed turns auto-archive to the tab's bottom section (issue #5:
 * long sessions accumulate dozens of diff groups and weigh the page down).
 */
export declare const ARCHIVE_KEEP_TURNS = 5;
/** Archived turns render this many groups per loaded page once the section opens. */
export declare const ARCHIVE_PAGE_TURNS = 10;
/** Split turns into the main list and the auto-archived tail (both newest-first). */
export declare function splitArchivedTurns(turns: readonly TurnFileChanges[], keep?: number): {
    main: readonly TurnFileChanges[];
    archived: readonly TurnFileChanges[];
};
/** Trailing path segment, the part that identifies the file at a glance. */
export declare function basename(path: string): string;
/** Resolve a (possibly relative) tool path against the session cwd. */
export declare function resolveSessionPath(cwd: string | undefined, path: string): string;
//# sourceMappingURL=session-changes.d.ts.map