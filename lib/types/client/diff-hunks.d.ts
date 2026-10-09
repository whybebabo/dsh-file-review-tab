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
import type { ProducedFileDiff } from '../change-types.ts';
/** How one drawn line relates to the two sides of the comparison. */
export type DiffLineKind = 'context' | 'del' | 'add';
/** One line of a comparison, already numbered against both sides. */
export interface DiffLine {
    readonly kind: DiffLineKind;
    readonly oldNumber: number | null;
    readonly newNumber: number | null;
    readonly text: string;
}
/** Added and removed line totals. */
export interface DiffStats {
    readonly added: number;
    readonly removed: number;
}
/** Optional native note shown above a comparison. */
export type DiffNote = 'created' | 'deleted' | 'unchanged' | undefined;
/**
 * One comparison in the shape dsh's own FileDiff renders: a header coordinate
 * pair plus `+`/`-`/` ` prefixed lines.
 */
export interface NativeDiffHunk {
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly lines: readonly string[];
}
/** Whether a comparison touches only one side, which forces the unified view. */
export declare function isOneSided(hunks: readonly NativeDiffHunk[]): boolean;
/** Pair one recorded before/after snapshot into numbered lines. */
export declare function pairLines(diff: ProducedFileDiff): DiffLine[];
/** Count added and removed lines using the viewer's exact line-diff algorithm. */
export declare function summarizeDiffs(diffs: readonly ProducedFileDiff[]): DiffStats;
/**
 * Derive the comparison note from the recorded change rather than hunk count alone.
 *
 * The creation note comes from the explicit `created` flag, never from
 * `oldText === null`. Null old text means the prior content is unavailable, and
 * that is also what `mutation-call.ts` synthesizes when a result carries no
 * `meta.diffs` for a `write` overwrite, a `str_replace_editor insert` or an
 * `edit` with an empty `old_string` — all edits to files that already existed.
 * Inferring creation from null labeled those "created in this turn".
 */
export declare function diffNote(diffs: readonly ProducedFileDiff[], hunks: readonly NativeDiffHunk[], deleted?: boolean): DiffNote;
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
export declare function missingMessage(deleted: boolean, deletedHint: string, missing: string): string;
/**
 * Convert recorded comparisons into dsh's served hunk shape.
 * @param diffs - the recorded before/after snapshots for one file.
 * @param contextLines - unchanged lines kept on each side of a change.
 * @returns the hunks to render, in order.
 */
export declare function toNativeHunks(diffs: readonly ProducedFileDiff[], contextLines?: number): NativeDiffHunk[];
/** Serialize recorded hunks as one plain-text unified diff. */
export declare function nativeDiffText(hunks: readonly NativeDiffHunk[]): string;
//# sourceMappingURL=diff-hunks.d.ts.map