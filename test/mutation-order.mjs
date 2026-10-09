/**
 * Verify the mutation-coordinate model that makes multi-hunk undo/redo correct.
 *
 * One file mutated several times in a turn accumulates hunks from several
 * settlements, and each settlement's line numbers describe the text the
 * PREVIOUS settlement left behind. Replaying that flat list against one text
 * applies hunks at coordinates that do not exist, which silently corrupted files
 * (undo wrote wrong content while reporting success) and made redo fail outright.
 *
 * `hunksForApply` must therefore run one settlement's hunks back-to-front, and
 * `mutationGroups` must keep settlements separate in both directions. On top of
 * that, settlements from different CHANNELS (the conversation snapshot and the
 * Host recorder) must be ordered by their event `seq`, because the two are
 * merged asynchronously and their array order is a merge artifact.
 *
 * Runs standalone:  node test/mutation-order.mjs
 */
import {
  appendMutation, flattenSettlements, hunksForApply, mutationGroups,
  orderBySequence, settlementsOf,
} from '../src/mutation-order.ts'

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${name}\n        ${error?.message ?? error}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

const hunk = (path, oldStart, newStart, oldText, newText) =>
  ({ path, oldText, newText, oldStart, newStart })

check('appendMutation stamps one settlement with one shared coordinate space', () => {
  const target = []
  appendMutation(target, [hunk('a.ts', 1, 1, 'x', 'y'), hunk('a.ts', 9, 9, 'p', 'q')])
  assert(target.length === 2, `expected 2 hunks, got ${target.length}`)
  assert(target[0].mutation === target[1].mutation, 'hunks of one settlement disagree on their stamp')
})

check('a second settlement gets a different stamp', () => {
  const target = []
  appendMutation(target, [hunk('a.ts', 1, 1, 'x', 'y')])
  appendMutation(target, [hunk('a.ts', 1, 1, 'x', 'y')])
  assert(target[0].mutation !== target[1].mutation, 'two settlements share a coordinate space')
})

check('appendMutation copies, so a caller\'s array is never aliased', () => {
  const original = hunk('a.ts', 1, 1, 'x', 'y')
  const target = []
  appendMutation(target, [original])
  assert(original.mutation === undefined, 'appendMutation mutated the caller\'s hunk in place')
})

check('unstamped hunks form a single group (old payloads stay one space)', () => {
  const groups = mutationGroups([hunk('a.ts', 1, 1, 'x', 'y'), hunk('a.ts', 5, 5, 'p', 'q')])
  assert(groups.length === 1, `expected 1 group, got ${groups.length}`)
})

check('stamped settlements split into their own groups, in order', () => {
  const target = []
  appendMutation(target, [hunk('a.ts', 1, 1, 'x', 'y')])
  appendMutation(target, [hunk('a.ts', 1, 1, 'y', 'z'), hunk('a.ts', 4, 4, 'p', 'q')])
  appendMutation(target, [hunk('a.ts', 2, 2, 'z', 'w')])
  const groups = mutationGroups(target)
  assert(groups.length === 3, `expected 3 groups, got ${groups.length}`)
  assert(groups.map(g => g.length).join(',') === '1,2,1', `unexpected group sizes ${groups.map(g => g.length).join(',')}`)
})

check('an unstamped hunk never merges into a stamped group', () => {
  const target = []
  appendMutation(target, [hunk('a.ts', 1, 1, 'x', 'y')])
  target.push(hunk('a.ts', 9, 9, 'p', 'q'))
  const groups = mutationGroups(target)
  assert(groups.length === 2, `expected 2 groups, got ${groups.length}`)
})

check('hunksForApply runs one settlement back-to-front for BOTH directions', () => {
  const group = [hunk('a.ts', 1, 1, 'x', 'y'), hunk('a.ts', 12, 14, 'p', 'q')]
  const redo = hunksForApply(group, 'redo').map(h => h.oldStart)
  const undo = hunksForApply(group, 'undo').map(h => h.newStart)
  assert(redo.join(',') === '12,1', `redo order was ${redo.join(',')}, expected descending anchors`)
  assert(undo.join(',') === '14,1', `undo order was ${undo.join(',')}, expected descending anchors`)
})

check('hunksForApply does not mutate the group it was given', () => {
  const group = [hunk('a.ts', 1, 1, 'x', 'y'), hunk('a.ts', 12, 12, 'p', 'q')]
  hunksForApply(group, 'redo')
  assert(group[0].oldStart === 1 && group[1].oldStart === 12, 'the input group was reordered in place')
})

check('a single-hunk settlement is unaffected by ordering', () => {
  const group = [hunk('a.ts', 3, 3, 'x', 'y')]
  assert(hunksForApply(group, 'redo').length === 1, 'a one-hunk group changed size')
  assert(hunksForApply(group, 'undo')[0].oldStart === 3, 'a one-hunk group was reordered')
})

check('anchorless hunks sort last, where they cannot invalidate an anchor', () => {
  const anchored = hunk('a.ts', 5, 5, 'x', 'y')
  const loose = { path: 'a.ts', oldText: 'q', newText: 'r' }
  const ordered = hunksForApply([loose, anchored], 'redo')
  assert(ordered[0] === anchored, 'an anchorless hunk was applied before an anchored one')
})

// --- event-sequence ordering (the cross-channel merge) ---------------------
// A `run_code` edit and a model-direct edit to the same file arrive through
// different channels merged asynchronously, so array order can invert them.

check('appendMutation records the event sequence it was given', () => {
  const target = []
  appendMutation(target, [hunk('a.ts', 1, 1, 'x', 'y')], 7)
  assert(target[0].seq === 7, `seq was ${target[0].seq}`)
})

check('appendMutation omits seq when the caller has none', () => {
  const target = []
  appendMutation(target, [hunk('a.ts', 1, 1, 'x', 'y')])
  assert(!('seq' in target[0]), 'an unknown sequence was invented')
})

check('orderBySequence sorts settlements into event order', () => {
  const ordered = orderBySequence([{ seq: 9 }, { seq: 2 }, { seq: 5 }])
  assert(ordered.map(e => e.seq).join(',') === '2,5,9', `got ${ordered.map(e => e.seq).join(',')}`)
})

check('orderBySequence is conservative when a sequence is missing', () => {
  // Guessing at an unstamped settlement's position could corrupt a file, so the
  // incoming order has to stand.
  const ordered = orderBySequence([{ seq: 9 }, { seq: undefined }, { seq: 2 }])
  assert(ordered.map(e => e.seq).join(',') === '9,,2', `got ${ordered.map(e => e.seq).join(',')}`)
})

check('orderBySequence is stable for one root\'s nested dispatch chain', () => {
  // Several settlements of one `run_code` root share its seq; their dispatch
  // order must survive.
  const chain = [{ seq: 4, id: 'a' }, { seq: 4, id: 'b' }, { seq: 4, id: 'c' }]
  const ordered = orderBySequence(chain)
  assert(ordered.map(e => e.id).join('') === 'abc', `got ${ordered.map(e => e.id).join('')}`)
})

check('settlementsOf recovers one entry per coordinate space', () => {
  const target = []
  appendMutation(target, [hunk('a.ts', 1, 1, 'x', 'y')], 1)
  appendMutation(target, [hunk('a.ts', 1, 1, 'y', 'z'), hunk('a.ts', 4, 4, 'p', 'q')], 2)
  const settlements = settlementsOf(target)
  assert(settlements.length === 2, `expected 2 settlements, got ${settlements.length}`)
  assert(settlements.map(s => s.seq).join(',') === '1,2', `got seqs ${settlements.map(s => s.seq).join(',')}`)
})

check('flattenSettlements reorders a cross-channel merge by seq', () => {
  // The recorded (Host) settlement was appended AFTER the snapshot one, but its
  // seq says it happened FIRST.
  const snapshot = []
  appendMutation(snapshot, [hunk('a.ts', 5, 5, 'later', 'L')], 2)
  const recorded = [{ seq: 1, diffs: [hunk('a.ts', 1, 1, 'earlier', 'E')] }]
  const flat = flattenSettlements([...settlementsOf(snapshot), ...recorded])
  assert(flat[0].seq === 1 && flat[1].seq === 2, `order was ${flat.map(d => d.seq).join(',')}`)
  assert(flat[0].oldText === 'earlier', 'the earlier settlement did not come first')
})

check('flattenSettlements re-stamps so grouping still works after reordering', () => {
  // Stamps encode append position, so reordering must reassign them; stale
  // stamps would make mutationGroups split one coordinate space in two.
  const snapshot = []
  appendMutation(snapshot, [hunk('a.ts', 5, 5, 'later', 'L')], 2)
  const flat = flattenSettlements([...settlementsOf(snapshot), { seq: 1, diffs: [hunk('a.ts', 1, 1, 'earlier', 'E')] }])
  const groups = mutationGroups(flat)
  assert(groups.length === 2, `expected 2 groups after reordering, got ${groups.length}`)
  assert(groups[0].length === 1 && groups[1].length === 1, 'a settlement was split or merged')
})

console.log(failures === 0 ? '\nALL MUTATION ORDER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
