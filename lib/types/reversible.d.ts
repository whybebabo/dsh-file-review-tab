/**
 * The reversibility rule shared by the Host undo service and both review
 * surfaces.
 *
 * A recorded hunk is reversible only when BOTH sides are known and placeable:
 * `oldText === null` means the prior content is not reconstructable (a `write`
 * overwrite, a `str_replace_editor insert`, an `edit` with an empty
 * `old_string`, or a file creation), and an empty side without a line anchor
 * cannot be located in the file. The Host REPLAYS these hunks to undo/redo, so
 * a hunk that fails this test must never reach it — and a surface must not put
 * such a file into a toggle batch, or a mixed turn reports a partial failure
 * for files the service was always going to refuse.
 *
 * One module for all three call sites is what keeps them from drifting: the
 * service decides what it will apply, the sidebar tab decides which rows and
 * turn batches are reversible, and the chat card decides whether its Undo is
 * enabled.
 */
import type { ProducedFileDiff } from './change-types.ts';
/**
 * Whether one hunk carries both sides completely enough to replay exactly.
 * @param diff - the hunk under test.
 * @param path - the file the hunk claims to belong to.
 * @returns true when the hunk can be undone/redone by exact replacement.
 */
export declare function hunkReversible(diff: ProducedFileDiff, path: string): boolean;
/**
 * Whether a file's whole change set is reversible: non-empty and every hunk
 * passes {@link hunkReversible}.
 * @param path - the path every hunk must name.
 * @param diffs - the file's hunks, in settlement order.
 * @returns true when the Host can replay the complete change.
 */
export declare function changeReversible(path: string, diffs: readonly ProducedFileDiff[]): boolean;
//# sourceMappingURL=reversible.d.ts.map