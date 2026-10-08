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