/**
 * Pacing for the client's `recorded` (Code Mode mutation) fetch.
 *
 * The fetch re-arms whenever a root's settled-dispatch count changes, and a busy
 * `run_code` can change it rapidly. Two ways to get that wrong, both of which
 * leave the tab showing only the mutations recorded before it first looked:
 *
 *  - Debouncing from each update (restarting the timer whenever one arrives)
 *    pushes the fetch out for as long as updates keep coming.
 *  - Anchoring on "the last fetch" alone starves the FIRST fetch: while updates
 *    keep arriving, no fetch has completed, so the anchor never exists and the
 *    window is re-armed forever.
 *
 * So the delay is always measured from a real instant — the last fetch, or the
 * moment the fetch was first armed when none has completed yet. An update can
 * then only ever schedule the next fetch for `anchor + interval`, and nothing an
 * update does can push it later.
 */
/** Minimum gap between two `recorded` fetches, in milliseconds. */
export declare const RECORDED_FETCH_INTERVAL = 200;
/**
 * Delay before the next `recorded` fetch.
 * @param anchor - Timestamp of the last completed fetch, or of the moment the
 * fetch was first armed when none has completed yet. Must never be a value that
 * an incoming update can reset, or the fetch starves.
 * @param now - Current timestamp.
 * @returns Milliseconds to wait; 0 once the interval has already elapsed.
 */
export declare function recordedFetchDelay(anchor: number, now: number): number;
//# sourceMappingURL=recorded-fetch.d.ts.map