/**
 * Verify undo -> redo is an exact round trip for multi-hunk and multi-mutation
 * files, driven through the REAL Host service against a real temp workspace.
 *
 * Two independent defects met here, and each alone was enough to break review:
 *
 *  1. `diffsFromBeforeAfter` trimmed a hunk's trailing context against ONE
 *     shared index, so a hunk whose change run had unequal side lengths kept too
 *     many lines on the longer side and violated
 *     `oldLines - newLines == net line delta`. Undo then matched that oversized
 *     block against the file and wrote back a corrupted document while
 *     reporting success.
 *  2. `transformFile` applied redo forward in one flat list, so a hunk that
 *     changed the line count shifted the anchors of every hunk behind it and the
 *     next `replaceHunk` returned null — a conflict on a file that was in fact
 *     perfectly undoable.
 *
 * Run after `pnpm build`:  node test/undo-redo.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileReviewService } from '../lib/index.js'
import { diffsFromBeforeAfter } from '../src/client/recorded-diffs.ts'
import { appendMutation } from '../src/mutation-order.ts'

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

const dir = await mkdtemp(join(tmpdir(), 'frt-undo-'))
const agent = { id: 'undo-agent', session: { header: { cwd: dir } }, runMaintenance: fn => fn() }
const service = new FileReviewService(new Context())

/** Write one fixture file and return its service-facing change descriptor. */
const fixture = async (name, diffs, text) => {
  await writeFile(join(dir, name), text, 'utf8')
  return { path: name, diffs }
}
const read = name => readFile(join(dir, name), 'utf8')
const line = n => Array.from({ length: n }, (_, i) => `l${i + 1}`)

await check('a single removal-heavy hunk survives undo byte-for-byte', async () => {
  // l3,l4,l5 -> A removes 2 lines, and the long unchanged tail is what forced
  // the (previously asymmetric) trailing-context trim.
  const before = line(22).join('\n') + '\n'
  const after = 'l1\nl2\nA\n' + line(17).map((_, i) => `l${i + 6}`).join('\n') + '\n'
  const diffs = diffsFromBeforeAfter('one.ts', before, after)
  const file = await fixture('one.ts', diffs, after)

  const undone = await service.apply(agent, { action: 'undo', files: [file] })
  assert(undone.files[0].state === 'undone', `undo said ${undone.files[0].state}`)
  assert(await read('one.ts') === before, 'undo did not restore the original content exactly')

  const redone = await service.apply(agent, { action: 'redo', files: [file] })
  assert(redone.files[0].state === 'applied', `redo said ${redone.files[0].state}: ${redone.files[0].reason ?? ''}`)
  assert(await read('one.ts') === after, 'redo did not restore the modified content exactly')
})

await check('every generated hunk satisfies the line-count invariant', async () => {
  // The invariant undo depends on: a hunk's own delta must equal the change it
  // describes, or replacing it swaps in the wrong number of lines.
  const cases = [
    ['adds 2 lines', 'l1\nl2\nA\nB\nC\n' + line(17).map((_, i) => `l${i + 4}`).join('\n') + '\n'],
    ['removes 2 lines', 'l1\nA\n' + line(17).map((_, i) => `l${i + 4}`).join('\n') + '\n'],
    ['replaces 1 line', 'l1\nl2\nZ\n' + line(17).map((_, i) => `l${i + 4}`).join('\n') + '\n'],
  ]
  for (const [label, after] of cases) {
    const before = line(20).join('\n') + '\n'
    const diffs = diffsFromBeforeAfter('inv.ts', before, after)
    const count = text => text.split('\n').length
    const fileDelta = count(after) - count(before)
    const sum = diffs.reduce((total, d) => total + count(d.newText) - count(d.oldText), 0)
    assert(sum === fileDelta, `${label}: hunks sum to ${sum} but the file moved ${fileDelta}`)
  }
})

await check('a two-hunk change undoes AND redoes exactly', async () => {
  const before = line(20).join('\n') + '\n'
  const after = 'l1\nl2\nA\nB\nC\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nZ\nl16\nl17\nl18\nl19\nl20\n'
  // Anchors as the engine records them: the second hunk's newStart already
  // accounts for the first hunk's +2.
  const diffs = [
    { path: 'two.ts', oldText: 'l1\nl2\nl3\nl4\nl5\nl6', newText: 'l1\nl2\nA\nB\nC\nl4\nl5\nl6', oldStart: 1, newStart: 1 },
    { path: 'two.ts', oldText: 'l12\nl13\nl14\nl15\nl16\nl17\nl18', newText: 'l12\nl13\nl14\nZ\nl16\nl17\nl18', oldStart: 12, newStart: 14 },
  ]
  const file = await fixture('two.ts', diffs, after)

  const undone = await service.apply(agent, { action: 'undo', files: [file] })
  assert(undone.files[0].state === 'undone', `undo said ${undone.files[0].state}`)
  assert(await read('two.ts') === before, 'undo did not restore the original content')

  const redone = await service.apply(agent, { action: 'redo', files: [file] })
  assert(redone.files[0].state === 'applied', `redo said ${redone.files[0].state}: ${redone.files[0].reason ?? ''}`)
  assert(await read('two.ts') === after, 'redo did not restore the modified content')

  // And the status the UI reads must agree the file is applied, not conflicted.
  const status = await service.status(agent, { files: [file] })
  assert(status.files[0].state === 'applied', `status reported ${status.files[0].state}`)
})

await check('status reports applied after undo too', async () => {
  const before = line(20).join('\n') + '\n'
  const after = 'l1\nl2\nA\nB\nC\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nZ\nl16\nl17\nl18\nl19\nl20\n'
  const diffs = [
    { path: 'st.ts', oldText: 'l1\nl2\nl3\nl4\nl5\nl6', newText: 'l1\nl2\nA\nB\nC\nl4\nl5\nl6', oldStart: 1, newStart: 1 },
    { path: 'st.ts', oldText: 'l12\nl13\nl14\nl15\nl16\nl17\nl18', newText: 'l12\nl13\nl14\nZ\nl16\nl17\nl18', oldStart: 12, newStart: 14 },
  ]
  const file = await fixture('st.ts', diffs, after)
  await service.apply(agent, { action: 'undo', files: [file] })
  const status = await service.status(agent, { files: [file] })
  assert(status.files[0].state === 'undone', `status reported ${status.files[0].state}`)
})

await check('two settlements of one file round-trip (separate coordinate spaces)', async () => {
  // A file edited twice in a turn: the second settlement's line numbers describe
  // the text the FIRST one left behind. Applied as one flat list they would
  // match the wrong lines; grouped, each settlement replays against its own text.
  const original = line(12).join('\n') + '\n'
  const afterFirst = 'l1\nX\nY\n' + line(9).map((_, i) => `l${i + 4}`).join('\n') + '\n'
  const afterSecond = 'l1\nX\nY\nl4\nl5\nl6\nZ\nl8\nl9\nl10\nl11\nl12\n'

  const first = diffsFromBeforeAfter('multi.ts', original, afterFirst)
  const second = diffsFromBeforeAfter('multi.ts', afterFirst, afterSecond)
  const diffs = []
  appendMutation(diffs, first)
  appendMutation(diffs, second)
  const file = await fixture('multi.ts', diffs, afterSecond)

  const undone = await service.apply(agent, { action: 'undo', files: [file] })
  assert(undone.files[0].state === 'undone', `undo said ${undone.files[0].state}: ${undone.files[0].reason ?? ''}`)
  assert(await read('multi.ts') === original, 'undo did not walk both settlements back to the original')

  const redone = await service.apply(agent, { action: 'redo', files: [file] })
  assert(redone.files[0].state === 'applied', `redo said ${redone.files[0].state}: ${redone.files[0].reason ?? ''}`)
  assert(await read('multi.ts') === afterSecond, 'redo did not replay both settlements')
})

await check('an unstamped payload still round-trips (backward compatibility)', async () => {
  // `mutation` is optional so a client built before the field existed keeps
  // working. Its hunks are read as ONE coordinate space, which is exactly right
  // for the single-settlement payload such a client sends.
  const original = line(12).join('\n') + '\n'
  const after = 'l1\nX\nY\n' + line(9).map((_, i) => `l${i + 4}`).join('\n') + '\n'
  const diffs = diffsFromBeforeAfter('compat.ts', original, after)
  assert(diffs.every(d => d.mutation === undefined), 'the generator started stamping settled hunks')
  const file = await fixture('compat.ts', diffs, after)

  const undone = await service.apply(agent, { action: 'undo', files: [file] })
  assert(undone.files[0].state === 'undone', `undo said ${undone.files[0].state}`)
  assert(await read('compat.ts') === original, 'an unstamped single-settlement undo lost content')

  const redone = await service.apply(agent, { action: 'redo', files: [file] })
  assert(redone.files[0].state === 'applied', `redo said ${redone.files[0].state}`)
  assert(await read('compat.ts') === after, 'an unstamped single-settlement redo lost content')
})

await check('the SERVICE orders settlements by seq, not by array position', async () => {
  // The service is the last line of defence: hunks can reach it already built
  // by a client, so it cannot assume the array order is the event order. Here
  // the two settlements are handed over LATEST-FIRST with their seqs attached,
  // which is what a cross-channel merge produced before the fix.
  const original = line(12).join('\n') + '\n'
  const afterFrontInsert = 'X\nY\n' + line(12).join('\n') + '\n'
  const afterRearEdit = 'X\nY\n' + line(11).join('\n') + '\nZZZ\n'

  const first = diffsFromBeforeAfter('wire.ts', original, afterFrontInsert)
  const second = diffsFromBeforeAfter('wire.ts', afterFrontInsert, afterRearEdit)
  // Deliberately inverted: the later settlement (seq 2) comes first.
  const diffs = []
  appendMutation(diffs, second, 2)
  appendMutation(diffs, first, 1)
  assert(diffs[0].seq === 2 && diffs[1].seq === 1, 'the fixture did not invert the settlements')

  const file = await fixture('wire.ts', diffs, afterRearEdit)
  const undone = await service.apply(agent, { action: 'undo', files: [file] })
  assert(undone.files[0].state === 'undone', `undo said ${undone.files[0].state}: ${undone.files[0].reason ?? ''}`)
  assert(await read('wire.ts') === original, 'undo applied the settlements in array order instead of event order')

  const redone = await service.apply(agent, { action: 'redo', files: [file] })
  assert(redone.files[0].state === 'applied', `redo said ${redone.files[0].state}: ${redone.files[0].reason ?? ''}`)
  assert(await read('wire.ts') === afterRearEdit, 'redo applied the settlements in array order instead of event order')
})

await rm(dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL UNDO/REDO CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
