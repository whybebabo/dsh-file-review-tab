/**
 * Client cache and hook for the Host's per-mutation hunk coordinates.
 *
 * The comparison surfaces read the conversation snapshot, and its hunks are the
 * engine's context fragments — text only, no line numbers. Numbering those from
 * 1 puts a change at the end of a long file on "line 1". The Host recorded each
 * mutation's real coordinates at settlement (see the node half's hunk-anchors
 * module); this module fetches them once per session and hands them to the
 * renderer.
 *
 * Deliberately a cache rather than view state: a call's coordinates never change
 * once recorded, so the sidebar tab, a chat hover preview and every remount reuse
 * the same answer. Only the FIRST lookup of a call id costs a round trip, and a
 * call the recorder never saw stays marked as asked — a session whose mutations
 * happened outside the tool pipeline must not turn every render into a request.
 */
import type { AnchorCall, RecordedAnchor } from '../change-types.ts';
import type { ProducedFileDiff } from '../change-types.ts';
import type { HunkAnchorLookup } from './diff-hunks.ts';
/**
 * Group one file's hunks into the calls that produced them.
 *
 * Fragments of a call are consecutive and keep the engine's hunk order, so this
 * both names the calls to ask about and supplies the text the Host needs to place
 * a hunk whose coordinates were never recorded. Hunks without a call id (the
 * recorded Code Mode path, which already carries coordinates) are skipped.
 * @param diffs - the file's hunks, in settlement order.
 * @returns one entry per call, in first-seen order.
 */
export declare function anchorCalls(diffs: readonly ProducedFileDiff[]): AnchorCall[];
/**
 * Coordinates remembered for one session, as the lookup the renderer takes.
 * @param sessionId - the session whose anchors are wanted.
 * @returns the cached map (empty before any lookup completes).
 */
export declare function cachedHunkAnchors(sessionId: string): HunkAnchorLookup;
/** Merge a Host answer into the cache and return the new lookup. */
export declare function rememberHunkAnchors(sessionId: string, entries: readonly RecordedAnchor[]): HunkAnchorLookup;
/**
 * Drop a session's cache. Called when a session is disposed: a later session can
 * reuse neither the id nor the call ids.
 * @param sessionId - the session leaving.
 */
export declare function forgetHunkAnchors(sessionId: string): void;
/**
 * Claim the ids that still need a lookup, marking them as asked.
 *
 * Claiming before the request is what stops two surfaces painting the same hunk
 * in one commit from fetching it twice. An id marked this way is never asked
 * again unless {@link releaseCallIds} returns it: a call the recorder never saw
 * answers successfully with no coordinates, and that must not become a request
 * per render.
 * @param sessionId - session key for the shared cache.
 * @param callIds - the calls the painted hunks came from.
 * @returns the ids to ask about now; empty when nothing new is wanted.
 */
export declare function claimCallIds(sessionId: string, callIds: readonly string[]): string[];
/**
 * Un-claim ids whose lookup failed.
 *
 * A thrown lookup is NOT the Host saying "this call has no coordinates" — it is
 * the Host not answering (an unmounted Remote, a transport error). Releasing the
 * ids is what lets a later attempt (new hunks, a now-visible tab, a remount) ask
 * again instead of leaving those hunks permanently unanchored.
 * @param sessionId - session key for the shared cache.
 * @param callIds - the ids whose request failed.
 */
export declare function releaseCallIds(sessionId: string, callIds: readonly string[]): void;
/**
 * Coordinates for the calls a set of painted hunks came from, fetched on demand.
 *
 * Call it unconditionally from the component that draws the hunks; the request
 * lives in an effect, so a surface that never paints a diff never asks the Host.
 * @param sessionId - session key for the shared cache.
 * @param callIds - the calls the painted hunks came from, in any order.
 * @param load - Host lookup; undefined while the Remote is unavailable.
 * @param enabled - false pauses the lookup (a hidden tab, a closed preview).
 * @returns the lookup `toNativeHunks` takes.
 */
export declare function useHunkAnchors(sessionId: string, callIds: readonly string[], load: ((ids: readonly string[]) => Promise<readonly RecordedAnchor[]>) | undefined, enabled?: boolean): HunkAnchorLookup;
//# sourceMappingURL=hunk-anchors.d.ts.map