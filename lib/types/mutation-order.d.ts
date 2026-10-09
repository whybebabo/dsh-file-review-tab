/**
 * Mutation grouping: the coordinate space each recorded hunk is anchored in.
 *
 * One file is often mutated several times in a single turn (`edit`, then
 * `write`, then a Code Mode dispatch), and the review surfaces concatenate every
 * mutation's hunks into ONE list per path. Those hunks do NOT share a coordinate
 * space: mutation 1's `oldStart` is a line number in the text as it existed
 * before mutation 1, mutation 2's is a line number in the text mutation 1 left
 * behind, and so on. Replaying them as one flat list therefore applies hunks
 * against coordinates that no longer exist.
 *
 * A group is the set of hunks one settlement produced (one tool result's
 * `meta.diffs`, or one Code Mode `before`/`after` pair). Two rules follow:
 *
 * - settlements replay in settlement order going forward (redo) and in reverse
 *   order going back (undo), because each one is anchored in the text the
 *   previous one produced;
 * - inside ONE settlement the hunks are anchored in the same text, so a hunk
 *   that changes the line count shifts every anchor still waiting behind it —
 *   they must be applied back-to-front.
 *
 * `mutation` is optional so a payload produced before this field existed
 * degrades to a single group, which for the overwhelmingly common
 * one-mutation payload is exactly the correct answer.
 */
import type { ProducedFileDiff } from './change-types.ts';
/**
 * Append one settlement's hunks, stamping them with the coordinate space they
 * were recorded in and the event sequence that orders them.
 *
 * The stamp is the accumulator's current length, which is strictly increasing
 * per path, so two settlements can never share one — that uniqueness is what
 * lets {@link mutationGroups} split a path's hunks back into settlements.
 *
 * `seq` is the ordering key: the conversation node's sequence for a
 * snapshot-derived settlement, or the owning `run_code` root's sequence for a
 * Host-recorded one. It is recorded separately from `mutation` because the two
 * answer different questions — a chain of nested dispatches produces several
 * distinct settlements that all share one node sequence.
 *
 * @param target - The path's accumulated hunks, mutated in place.
 * @param diffs - One settlement's hunks, all anchored in the same text.
 * @param seq - Event sequence that orders this settlement, when known.
 */
export declare function appendMutation(target: ProducedFileDiff[], diffs: readonly ProducedFileDiff[], seq?: number | undefined): void;
/**
 * Order settlements by their recorded event sequence, so undo/redo walk the
 * file's history in the order it actually happened.
 *
 * This is what keeps a `run_code` mutation and a model-direct edit to the same
 * file from being applied out of order: the two arrive through different
 * channels (the conversation snapshot vs. the Host recorder) and are merged
 * asynchronously, so the array order is a merge artifact rather than history.
 *
 * Only when EVERY entry carries a sequence is the order provable. A partially
 * stamped list keeps its incoming order, which is the conservative choice —
 * guessing at the position of an unstamped settlement could silently corrupt a
 * file. The sort is stable, so entries sharing one sequence (a single
 * `run_code` root's nested dispatch chain) keep their dispatch order.
 *
 * @param entries - Settlements or events carrying an optional `seq`.
 * @returns A new array in ascending event order, or the same order when unprovable.
 */
export declare function orderBySequence<T extends {
    readonly seq: number | undefined;
}>(entries: readonly T[]): T[];
/** One settlement recovered from a path's accumulated hunks. */
export interface Settlement {
    readonly seq: number | undefined;
    readonly diffs: readonly ProducedFileDiff[];
}
/**
 * Recover the settlements one path's flat hunk list was built from.
 * @param diffs - One path's accumulated hunks.
 * @returns One entry per coordinate space, in the order they were appended.
 */
export declare function settlementsOf(diffs: readonly ProducedFileDiff[]): Settlement[];
/**
 * Re-stamp a settlement list back into one flat hunk list, in event order.
 *
 * Stamps are reassigned rather than preserved because they encode POSITION
 * (`mutation` is the append offset), and reordering invalidates the old values;
 * leaving them stale would make {@link mutationGroups} split the same
 * coordinate space into several groups.
 *
 * @param settlements - Settlements, in any order.
 * @returns The flat hunk list, ordered by `seq` with fresh stamps.
 */
export declare function flattenSettlements(settlements: readonly Settlement[]): ProducedFileDiff[];
/**
 * Split one path's hunks into contiguous same-coordinate groups, in settlement
 * order. Hunks that carry no `mutation` form a single group.
 * @param diffs - One path's accumulated hunks, in settlement order.
 * @returns The groups, in settlement order.
 */
export declare function mutationGroups(diffs: readonly ProducedFileDiff[]): readonly (readonly ProducedFileDiff[])[];
/**
 * The order one settlement's hunks must be applied in: back-to-front by the
 * anchor of the direction being applied, because a hunk that changes the line
 * count would otherwise shift the anchors of the hunks behind it. This is what
 * makes a multi-hunk redo land on the coordinates the hunks recorded instead of
 * the ones left over after the first hunk moved them.
 *
 * Hunks without a line anchor are content-matched and so coordinate-free; they
 * sort after the anchored ones, where they cannot invalidate a pending anchor.
 * @param group - One settlement's hunks.
 * @param action - Direction being applied.
 * @returns The hunks in application order (descending anchor).
 */
export declare function hunksForApply(group: readonly ProducedFileDiff[], action: 'undo' | 'redo'): readonly ProducedFileDiff[];
//# sourceMappingURL=mutation-order.d.ts.map