/**
 * Chat → sidebar deep-link channel.
 *
 * The chat turn-tail row knows which paths (and which turn) the user wants to
 * inspect, but better-sidebar's native right Sidebar mints its own tab ids and
 * does not refresh an already-open tab's `meta` (dsh-better-sidebar #632 /
 * 0.19.1 adapter behaviour). Passing a `path` seed is also unsafe there: the
 * native surface routes path-bearing opens to the file editor, so the review
 * tab would never mount.
 *
 * The channel therefore carries the seed inside this plugin: the chat row
 * publishes it and then opens the tab by type; the tab body subscribes and
 * replays whatever arrived, whether it mounted just now or was already open.
 * Sessions are keyed separately, and each publish gets a monotonic nonce so a
 * replay can never be mistaken for a fresh link.
 */
/** One chat-issued review target inside a session. */
export interface FileReviewSeed {
    readonly paths: readonly string[];
    /** Turn anchor: expand only this turn's rows for the given paths. */
    readonly turn?: number;
    /** Monotonic publish id; a new value means a new link to replay. */
    readonly nonce: number;
}
/** A row a deep link resolved to, keyed the way the tab keys its state. */
export interface DeepLinkRow {
    readonly turn: number;
    readonly path: string;
}
/** Everything one replay must do, computed without touching component state. */
export interface DeepLinkPlan {
    /** Rows to expand, as `turn|path` state keys. */
    readonly expanded: readonly string[];
    /** The row to scroll to (the first match), or null when nothing matched. */
    readonly first: DeepLinkRow | null;
    /**
     * Archive section to reveal: a link into an auto-archived turn must render
     * that turn before its row can be scrolled to. Null when the target is
     * already in the main list.
     */
    readonly archive: {
        readonly pages: number;
    } | null;
}
/**
 * Resolve a deep link against EVERY change the tab can render, including turns
 * still hidden behind a closed archive section.
 *
 * The target is deliberately resolved against the full change set rather than
 * the currently mounted rows. A link into an archived turn is replayed in the
 * same commit that opens the archive, so at that moment its rows are not
 * mounted yet; resolving against the mounted set made the match fail, the
 * pending scroll get cleared, and the link land nowhere with no retry.
 *
 * @param turns - Every turn, ascending (the source of truth for all rows).
 * @param archivedTurns - The auto-archived subset, newest first.
 * @param paths - Paths the link targets.
 * @param targetTurn - Turn anchor, or undefined for a path-only (legacy) link.
 * @returns The expand set, the scroll target, and the archive reveal to apply.
 */
export declare function planDeepLink(turns: readonly {
    readonly turn: number;
    readonly live: boolean;
    readonly files: readonly {
        readonly path: string;
    }[];
}[], archivedTurns: readonly {
    readonly turn: number;
}[], paths: readonly string[], targetTurn: number | undefined): DeepLinkPlan;
type SeedListener = (sessionId: string, seed: FileReviewSeed) => void;
type InvalidationListener = (sessionId: string) => void;
/** Publish a deep link for one session and return the stored seed. */
export declare function publishFileReviewSeed(sessionId: string, paths: readonly string[], turn?: number): FileReviewSeed;
/** The most recent seed for a session, if the tab has not consumed it yet. */
export declare function currentFileReviewSeed(sessionId: string): FileReviewSeed | undefined;
/** Observe every publish; the caller filters by session. */
export declare function subscribeFileReviewSeed(listener: SeedListener): () => void;
/** Notify every mounted review surface that one session's disk state changed. */
export declare function publishFileReviewInvalidation(sessionId: string): void;
/** Observe disk-state invalidations issued by this plugin's review surfaces. */
export declare function subscribeFileReviewInvalidation(listener: InvalidationListener): () => void;
export {};
//# sourceMappingURL=deep-link.d.ts.map