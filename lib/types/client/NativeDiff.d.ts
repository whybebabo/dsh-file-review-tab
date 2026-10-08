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
import { type NativeDiffHunk } from './diff-hunks.ts';
/** Localized copy the comparison needs. */
export interface NativeDiffLabels {
    readonly created: string;
    readonly deleted: string;
    readonly unchanged: string;
    readonly truncated: (count: string) => string;
    /** Shown while the comparison is still being resolved. */
    readonly loading: string;
    /** Shown when the two sides can no longer be reconstructed. */
    readonly missing: string;
}
export interface NativeDiffProps {
    readonly hunks: readonly NativeDiffHunk[];
    /** Source path, used to pick the syntax grammar. */
    readonly path: string;
    /** Side-by-side when true (and the change is two-sided). */
    readonly split: boolean;
    /** Wrap long lines instead of scrolling them. */
    readonly wrap: boolean;
    /**
     * Why the two sides differ in shape rather than content, when they do:
     * 'created' and 'deleted' are native's own notes.
     */
    readonly note?: 'created' | 'deleted' | 'unchanged' | undefined;
    /**
     * Force one of native's non-content states instead of drawing hunks:
     * 'loading' while the change is still being read, 'missing' when it is gone.
     */
    readonly status?: 'loading' | 'missing' | undefined;
    readonly labels: NativeDiffLabels;
}
/**
 * Render one file comparison.
 * @param props - hunks, view mode, labels and the optional note.
 * @returns The comparison body, in the layout the mode selects.
 */
export declare function NativeDiff({ hunks, path, split, wrap, note, status, labels, }: NativeDiffProps): import("react").JSX.Element;
//# sourceMappingURL=NativeDiff.d.ts.map