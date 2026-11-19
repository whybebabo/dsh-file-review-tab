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
import type { HunkAnchor } from './change-types.ts';
/**
 * Coordinates for one call's fragments, or null when any of them is unplaceable.
 *
 * All fragments of a call must resolve: they came from one patch, so a partial
 * answer would number part of a file and leave the rest to a per-hunk count.
 * @param fileText - the file's current text (LF basis).
 * @param hunks - the call's fragments, in engine order.
 * @returns one anchor per fragment, in the same order.
 */
export declare function locateAnchors(fileText: string, hunks: readonly {
    readonly oldText: string | null;
    readonly newText: string;
}[]): HunkAnchor[] | null;
//# sourceMappingURL=anchor-locate.d.ts.map