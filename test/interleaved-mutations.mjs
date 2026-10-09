/**
 * Verify a turn's file history stays in EVENT order when its changes arrive
 * through both channels: the conversation snapshot (model-direct `edit`/`write`)
 * and the Host recorder (nested `run_code` dispatches).
 *
 * The two are merged asynchronously, so the merge used to append every recorded
 * mutation AFTER the snapshot-derived ones. That is not history: a `run_code`
 * insert at the top of a file followed by a model-direct edit near its end must
 * replay in THAT order. Reversed, the rear edit's line anchors describe text the
 * front insert already shifted, and review fails in BOTH directions — undo
 * reports a conflict and redo cannot rebuild the file, on a change set that was
 * perfectly reversible all along.
 *
 * `mergeRecordedTurns` therefore interleaves both sources by event `seq`, and
 * `transformFile` re-orders settlements by that same sequence before applying.
 *
 * Run after `pnpm build`:  node test/interleaved-mutations.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileReviewService } from '../lib/index.js'
import {
  deriveSessionChanges, deriveSessionRoots, mergeRecordedTurns,
} from '../src/client/session-changes.ts'
import { RECORDED_FETCH_INTERVAL, recordedFetchDelay } from '../src/client/recorded-fetch.ts'

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${name}\n        ${error?.message ?? error}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

const line = n => Array.from({ length: n }, (_, i) => `l${i + 1}`)
const before = line(12).join('\n') + '\n'
/** After the run_code front insert (two lines added at the top). */
const afterFrontInsert = 'X\nY\n' + line(12).join('\n') + '\n'
/** After the later model-direct edit that rewrites the LAST line. */
const afterRearEdit = 'X\nY\n' + line(11).join('\n') + '\nZZZ\n'

/**
 * A snapshot with two nodes, in event order:
 *   seq 1 — a `run_code` root whose nested facts did NOT survive into the
 *           snapshot, so the Host recorder is the authoritative source;
 *   seq 2 — a model-direct `edit` on the same file, carrying `meta.diffs`.
 */
const snapshotWith = () => ({
  nodes: [{
    kind: 'tool-result', seq: 1, isError: false, callId: 'call-A',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'edit(...)' }) },
    meta: {},
    subCalls: [{
      kind: 'tool-result', seq: 1, isError: false, subCalls: [], callId: 'call-A1',
      call: { name: 'unknown_tool', argsRaw: '{}' }, meta: {},
    }],
  }, {
    kind: 'tool-result', seq: 2, isError: false, subCalls: [], callId: 'call-B',
    call: {
      name: 'edit',
      argsRaw: JSON.stringify({
        file_path: 'x.ts',
        old_string: line(12).join('\n') + '\n',
        new_string: line(11).join('\n') + '\nZZZ\n',
      }),
    },
    meta: {
      diffs: [{
        path: 'x.ts', oldText: line(12).join('\n') + '\n', newText: line(11).join('\n') + '\nZZZ\n',
        oldStart: 1, newStart: 1,
      }],
    },
  }],
  turnEnds: new Map([[1, 2]]),
  partial: null,
  runningCalls: [],
})

const theFile = (turns) => turns.flatMap(turn => turn.files).find(file => file.path === 'x.ts')

const dir = await mkdtemp(join(tmpdir(), 'frt-interleave-'))
const agent = { id: 'interleave-agent', session: { header: { cwd: dir } }, runMaintenance: fn => fn() }
const service = new FileReviewService(new Context())
const write = text => writeFile(join(dir, 'x.ts'), text, 'utf8')
const read = () => readFile(join(dir, 'x.ts'), 'utf8')

await check('deriveSessionRoots carries the root event sequence', async () => {
  const roots = deriveSessionRoots(snapshotWith())
  assert(roots.length === 1, `expected 1 root, got ${roots.length}`)
  assert(roots[0].seq === 1, `root seq was ${roots[0].seq}`)
})

await check('mergeRecordedTurns interleaves the channels in event order', async () => {
  const snapshot = snapshotWith()
  const turns = deriveSessionChanges(snapshot)
  const roots = deriveSessionRoots(snapshot)
  const recorded = [{
    rootCallId: 'call-A', name: 'edit', path: 'x.ts',
    before, after: afterFrontInsert,
  }]
  const file = theFile(mergeRecordedTurns(turns, roots, recorded))
  const seqs = file.diffs.map(diff => diff.seq)
  assert(seqs.every(seq => seq !== undefined), `hunks lack a sequence: ${JSON.stringify(seqs)}`)
  // Ascending: the run_code insert (seq 1) precedes the model-direct edit (seq 2).
  assert(
    seqs.every((seq, index) => index === 0 || seq >= seqs[index - 1]),
    `merged hunks are out of event order: ${seqs.join(',')}`,
  )
  assert(seqs[0] === 1 && seqs[seqs.length - 1] === 2, `expected seq 1 then 2, got ${seqs.join(',')}`)
  // The head settlement must be the front insert, not the rear edit.
  assert(file.diffs[0].newText.startsWith('X'), 'the front insert did not come first in the merge')
})

await check('the interleaved history undoes AND redoes exactly', async () => {
  const snapshot = snapshotWith()
  const turns = deriveSessionChanges(snapshot)
  const roots = deriveSessionRoots(snapshot)
  const recorded = [{
    rootCallId: 'call-A', name: 'edit', path: 'x.ts',
    before, after: afterFrontInsert,
  }]
  const file = theFile(mergeRecordedTurns(turns, roots, recorded))

  await write(afterRearEdit)
  const undone = await service.apply(agent, { action: 'undo', files: [file] })
  assert(undone.files[0].state === 'undone', `undo said ${undone.files[0].state}: ${undone.files[0].reason ?? ''}`)
  assert(await read() === before, 'undo did not walk the interleaved history back to the original')

  const redone = await service.apply(agent, { action: 'redo', files: [file] })
  assert(redone.files[0].state === 'applied', `redo said ${redone.files[0].state}: ${redone.files[0].reason ?? ''}`)
  assert(await read() === afterRearEdit, 'redo did not rebuild the final content')

  const status = await service.status(agent, { files: [file] })
  assert(status.files[0].state === 'applied', `status reported ${status.files[0].state}`)
})

await check('the reverse event order still round-trips', async () => {
  // The mirror image: a model-direct edit FIRST, then a run_code insert. The
  // merge must not assume one channel always precedes the other.
  const snapshot = {
    nodes: [{
      kind: 'tool-result', seq: 1, isError: false, subCalls: [], callId: 'call-B',
      call: {
        name: 'edit',
        argsRaw: JSON.stringify({
          file_path: 'x.ts', old_string: line(12).join('\n') + '\n', new_string: afterFrontInsert,
        }),
      },
      meta: {
        diffs: [{
          path: 'x.ts', oldText: before, newText: afterFrontInsert, oldStart: 1, newStart: 1,
        }],
      },
    }, {
      kind: 'tool-result', seq: 2, isError: false, callId: 'call-A',
      call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'edit(...)' }) },
      meta: {},
      subCalls: [{
        kind: 'tool-result', seq: 2, isError: false, subCalls: [], callId: 'call-A1',
        call: { name: 'unknown_tool', argsRaw: '{}' }, meta: {},
      }],
    }],
    turnEnds: new Map([[1, 2]]),
    partial: null,
    runningCalls: [],
  }
  const turns = deriveSessionChanges(snapshot)
  const roots = deriveSessionRoots(snapshot)
  const recorded = [{
    rootCallId: 'call-A', name: 'edit', path: 'x.ts',
    before: afterFrontInsert, after: afterRearEdit,
  }]
  const file = theFile(mergeRecordedTurns(turns, roots, recorded))
  const seqs = file.diffs.map(diff => diff.seq)
  assert(
    seqs.every((seq, index) => index === 0 || seq >= seqs[index - 1]),
    `merged hunks are out of event order: ${seqs.join(',')}`,
  )

  await write(afterRearEdit)
  const undone = await service.apply(agent, { action: 'undo', files: [file] })
  assert(undone.files[0].state === 'undone', `undo said ${undone.files[0].state}: ${undone.files[0].reason ?? ''}`)
  assert(await read() === before, 'undo did not restore the original in the mirrored order')
  const redone = await service.apply(agent, { action: 'redo', files: [file] })
  assert(redone.files[0].state === 'applied', `redo said ${redone.files[0].state}`)
  assert(await read() === afterRearEdit, 'redo did not restore the final content in the mirrored order')
})

await check('a recorded-only turn still merges (no snapshot files)', async () => {
  // A Code Mode session whose nested changes never reached the snapshot: the
  // recorded channel is the only source, and the merge must still build the row.
  const snapshot = {
    nodes: [{
      kind: 'tool-result', seq: 1, isError: false, callId: 'call-A',
      call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'edit(...)' }) },
      meta: {},
      subCalls: [{
        kind: 'tool-result', seq: 1, isError: false, subCalls: [], callId: 'call-A1',
        call: { name: 'unknown_tool', argsRaw: '{}' }, meta: {},
      }],
    }],
    turnEnds: new Map([[1, 1]]),
    partial: null,
    runningCalls: [],
  }
  const turns = deriveSessionChanges(snapshot)
  assert(theFile(turns) === undefined, 'the fixture unexpectedly produced a snapshot-derived file')
  const merged = mergeRecordedTurns(turns, deriveSessionRoots(snapshot), [{
    rootCallId: 'call-A', name: 'edit', path: 'x.ts', before, after: afterFrontInsert,
  }])
  const file = theFile(merged)
  assert(file !== undefined, 'the recorded-only turn produced no row')
  assert(file.diffs.length > 0, 'the recorded-only row carries no hunks')
})

// --- deletion is a sequenced EVENT, not a lasting flag ---------------------
// A deletion and a recreation can arrive through different channels in one
// turn. Inheriting the deletion unconditionally kept a live file marked deleted,
// which hides its diff and its undo/reapply controls.

/** A model-direct `rm` node (a deletion settlement) at `seq`. */
const rmNode = (seq) => ({
  kind: 'tool-result', seq, isError: false, subCalls: [], callId: `call-rm-${seq}`,
  call: { name: 'bash', argsRaw: JSON.stringify({ command: 'rm x.ts' }) },
  meta: {},
})
/** A `run_code` root whose nested facts did not survive, at `seq`. */
const codeRoot = (seq) => ({
  kind: 'tool-result', seq, isError: false, callId: `call-A-${seq}`,
  call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'write(...)' }) },
  meta: {},
  subCalls: [{
    kind: 'tool-result', seq, isError: false, subCalls: [], callId: `call-A1-${seq}`,
    call: { name: 'unknown_tool', argsRaw: '{}' }, meta: {},
  }],
})
const turnOf = (nodes) => ({
  nodes, turnEnds: new Map([[1, 99]]), partial: null, runningCalls: [],
})
const recreated = 'NEW1\nNEW2\n' + line(4).join('\n') + '\n'

await check('a Code Mode write AFTER a deletion clears the deleted flag', async () => {
  const snapshot = turnOf([rmNode(1), codeRoot(2)])
  const merged = mergeRecordedTurns(
    deriveSessionChanges(snapshot),
    deriveSessionRoots(snapshot),
    [{ rootCallId: 'call-A-2', name: 'write', path: 'x.ts', before: null, after: recreated }],
  )
  const file = theFile(merged)
  assert(file !== undefined, 'the recreated path produced no row')
  assert(file.deleted !== true, 'a recreated file is still marked deleted; its diff stays hidden')
  assert(file.diffs.length > 0, 'the recreated file carries no hunks')
})

await check('a deletion AFTER a Code Mode write still marks the path deleted', async () => {
  // The reverse order must stay deleted: the path really is gone at the end.
  const snapshot = turnOf([codeRoot(1), rmNode(2)])
  const merged = mergeRecordedTurns(
    deriveSessionChanges(snapshot),
    deriveSessionRoots(snapshot),
    [{ rootCallId: 'call-A-1', name: 'write', path: 'x.ts', before: null, after: recreated }],
  )
  const file = theFile(merged)
  assert(file !== undefined, 'the deleted path produced no row')
  assert(file.deleted === true, 'a path deleted last is not marked deleted')
})

await check('a deletion with no recorded write keeps its flag', async () => {
  const snapshot = turnOf([rmNode(1)])
  const merged = mergeRecordedTurns(deriveSessionChanges(snapshot), [], [])
  const file = theFile(merged)
  assert(file !== undefined, 'the deletion produced no row')
  assert(file.deleted === true, 'a plain deletion lost its flag')
})

await check('an unknown sequence keeps the deletion (conservative)', async () => {
  // Without a sequence the order is unprovable, so the stored deletion stands
  // rather than being cleared on a guess.
  const snapshot = turnOf([rmNode(1), codeRoot(2)])
  const merged = mergeRecordedTurns(
    deriveSessionChanges(snapshot),
    [{ turn: 1, live: false, rootCallId: 'call-A-2', seq: undefined, progress: 1 }],
    [{ rootCallId: 'call-A-2', name: 'write', path: 'x.ts', before: null, after: recreated }],
  )
  const file = theFile(merged)
  assert(file !== undefined, 'the path produced no row')
  assert(file.deleted === true, 'an unprovable order silently cleared a real deletion')
})

await check('a recreated file is inspectable again', async () => {
  // The flag is what the UI filters on, so clearing it must restore the row to
  // the inspectable set (diff + undo/reapply), not merely flip a boolean.
  const snapshot = turnOf([rmNode(1), codeRoot(2)])
  const merged = mergeRecordedTurns(
    deriveSessionChanges(snapshot),
    deriveSessionRoots(snapshot),
    [{ rootCallId: 'call-A-2', name: 'write', path: 'x.ts', before: null, after: recreated }],
  )
  const inspectable = merged.flatMap(t => t.files).filter(f => f.deleted !== true)
  assert(inspectable.length === 1, `expected 1 inspectable file, got ${inspectable.length}`)
  assert(inspectable[0].path === 'x.ts', 'the recreated path is not the inspectable one')
})

// --- the recorded fetch re-arm signal -------------------------------------

await check('a root reports how many nested dispatches settled', async () => {
  // The client re-fetches `recorded` when this changes. With a call-id-only
  // signal a long-running root kept the same id, so later mutations stayed
  // invisible until a manual refresh.
  const rootWith = (n) => ({
    kind: 'tool-result', seq: 1, isError: false, callId: 'call-A',
    call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'x' }) },
    meta: {},
    subCalls: Array.from({ length: n }, (_, i) => ({
      kind: 'tool-result', seq: 1, isError: false, subCalls: [], callId: `call-A${i}`,
      call: { name: 'unknown_tool', argsRaw: '{}' }, meta: {},
    })),
  })
  const progressOf = (n) => {
    const snapshot = { nodes: [rootWith(n)], turnEnds: new Map([[1, 1]]), partial: null, runningCalls: [] }
    const roots = deriveSessionRoots(snapshot)
    assert(roots.length === 1, `expected 1 root, got ${roots.length}`)
    return roots[0].progress
  }
  assert(progressOf(1) === 1, `1 child reported ${progressOf(1)}`)
  assert(progressOf(3) === 3, `3 children reported ${progressOf(3)}`)
  // The key the effect depends on must therefore differ between the two.
  assert(
    `call-A:${progressOf(1)}` !== `call-A:${progressOf(3)}`,
    'the re-arm key does not change as a root records more dispatches',
  )
})

await check('the fetch delay is throttled from a FIXED anchor, not each update', async () => {
  // The guards that matter: an update arriving mid-window must NOT push the
  // fetch further out (or rapidly-settling dispatches defer it forever), and the
  // first fetch must not starve while updates keep arriving with no fetch ever
  // completing (the anchor is the arm instant until one does).
  const t0 = 1_000_000
  assert(recordedFetchDelay(t0, t0) === RECORDED_FETCH_INTERVAL, 'an immediate update was not held back')
  // 50ms later the fetch is still 150ms away — the SAME absolute target, so a
  // further update cannot extend it.
  assert(recordedFetchDelay(t0, t0 + 50) === RECORDED_FETCH_INTERVAL - 50, 'the window restarted instead of throttling')
  assert(recordedFetchDelay(t0, t0 + 150) === 50, 'the remaining wait is wrong')
  assert(recordedFetchDelay(t0, t0 + RECORDED_FETCH_INTERVAL) === 0, 'the fetch is still delayed after the interval')
  assert(recordedFetchDelay(t0, t0 + 10_000) === 0, 'an overdue fetch is still delayed')
  // Monotonic in `now`: a later update never waits longer than an earlier one.
  const waits = [0, 40, 80, 120, 160, 200].map(offset => recordedFetchDelay(t0, t0 + offset))
  assert(
    waits.every((wait, index) => index === 0 || wait <= waits[index - 1]),
    `the wait is not monotonically shrinking: ${waits.join(',')}`,
  )
  // Simulate a root settling every 10ms with a FIXED anchor: the wait shrinks
  // toward zero and the fetch fires at the interval. A per-update debounce would
  // hold the wait pinned at the full interval forever.
  const stalled = [0, 10, 20, 30, 40, 50, 190, 200].map(offset => recordedFetchDelay(t0, t0 + offset))
  assert(stalled[0] === RECORDED_FETCH_INTERVAL, 'the burst did not start paced')
  assert(stalled.at(-1) === 0, 'a burst of updates never reached the fetch instant')
  assert(stalled[6] < stalled[0], 'the wait never shrank, so the fetch would starve')
})

await rm(dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL INTERLEAVED MUTATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
