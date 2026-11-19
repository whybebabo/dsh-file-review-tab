/**
 * Absolute hunk coordinates for one settled file mutation.
 *
 * The review surfaces can only ever draw what the conversation snapshot carries,
 * and that is the engine's `meta.diffs`: one context-trimmed fragment pair per
 * applied hunk, with no line numbers in it ({@link FileDiff} is `path` +
 * `oldText` + `newText`). Numbering those fragments from 1 — the only reading
 * the payload allows on its own — invents a per-hunk counter and puts a change
 * near the end of a file on "line 1".
 *
 * At settlement, though, the tool has already handed back the mutation's full
 * before/after text, so this module recomputes the very same patch the engine
 * used (`structuredPatch` over the two sides, {@link ANCHOR_CONTEXT} context
 * lines — dsh-tool-fs's `computeHunkDiffs` is exactly this call) and keeps only
 * each hunk's starting coordinates. The fragment list therefore lines up with
 * the engine's one-for-one, while the payload stays a couple of integers per
 * hunk instead of a second copy of the file.
 */
import type { HunkAnchor } from './change-types.ts';
/**
 * Context lines around each change. dsh-tool-fs's `DIFF_CONTEXT` — the value the
 * engine's own hunk fragments were trimmed with, which is what makes the anchor
 * list and the `meta.diffs` fragment list the same length.
 */
export declare const ANCHOR_CONTEXT = 3;
/**
 * Hunk coordinates for one mutation, in the engine's hunk order.
 * @param before - file text before the mutation, or null when it did not exist.
 * @param after - file text after the mutation.
 * @returns one anchor per applied hunk; empty when the texts do not differ.
 */
export declare function hunkAnchors(before: string | null, after: string): HunkAnchor[];
//# sourceMappingURL=hunk-anchors.d.ts.map