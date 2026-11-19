/**
 * The retroactive locator: placing a hunk whose coordinates were never recorded.
 *
 * The recorder only sees mutations that settle while the plugin is loaded, so a
 * session reviewed after installing it has hunks with no coordinates at all.
 * Their fragments are still enough to find them in the file as it stands — but
 * only when the answer is unambiguous, because a confidently wrong line number
 * is worse than the per-hunk count it replaces. These checks pin exactly that
 * line: unique placements are used, ambiguous ones are refused.
 *
 * Run after `pnpm build`:  node test/anchor-locate.mjs
 */
import { locateAnchors } from '../src/anchor-locate.ts'

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

/** A file of numbered lines, 1-based, optionally with replacements applied. */
const file = (count, changed = []) => Array.from({ length: count }, (_value, index) => {
  const number = index + 1
  return changed.includes(number) ? `line ${number} changed` : `line ${number}`
}).join('\n')

/**
 * One fragment as the engine reports it: 3 context lines, the changed line, 3
 * more. The file it must be found in is the AFTER state, which is what is on
 * disk by the time anyone reviews it.
 */
const fragment = (from, to, changed) => ({
  oldText: Array.from({ length: to - from + 1 }, (_v, i) => `line ${from + i}`).join('\n'),
  newText: Array.from({ length: to - from + 1 }, (_v, i) => {
    const number = from + i
    return number === changed ? `line ${number} changed` : `line ${number}`
  }).join('\n'),
})

check('a unique fragment is placed on its real line', () => {
  const anchors = locateAnchors(file(60, [20]), [fragment(17, 23, 20)])
  assert(anchors !== null, 'a unique fragment was refused')
  assert(anchors[0].newStart === 17, `placed at ${anchors[0].newStart}, expected 17`)
  // A hunk that starts with context sits on the same line on both sides.
  assert(anchors[0].oldStart === 17, `old side at ${anchors[0].oldStart}, expected 17`)
})

check('each fragment of one call keeps its own line', () => {
  const anchors = locateAnchors(file(60, [20, 40]), [fragment(17, 23, 20), fragment(37, 43, 40)])
  assert(anchors !== null, 'two unique fragments were refused')
  assert(anchors.map(anchor => anchor.newStart).join(',') === '17,37',
    `placed at ${anchors.map(anchor => anchor.newStart).join(',')}, expected 17,37`)
})

check('a line the call removed shifts the old side of a later hunk', () => {
  // The first hunk drops line 18, so everything below sits one line higher in
  // the file than it did — the later hunk's OLD side is a line further down.
  const after = Array.from({ length: 60 }, (_v, i) => `line ${i + 1}`)
    .filter(line => line !== 'line 18')
    .join('\n')
  const anchors = locateAnchors(after, [
    { oldText: 'line 17\nline 18\nline 19', newText: 'line 17\nline 19' },
    { oldText: 'line 37\nline 38\nline 39', newText: 'line 37\nline 38\nline 39' },
  ])
  assert(anchors !== null, 'the pair was refused')
  assert(anchors[1].newStart === 36, `new side at ${anchors[1].newStart}, expected 36`)
  assert(anchors[1].oldStart === 37, `old side at ${anchors[1].oldStart}, expected 37`)
})

check('an ambiguous fragment is refused, not guessed', () => {
  // The same block appears twice: nothing in the payload says which one changed.
  const repeated = 'a\nb\nc\na\nb\nc\n'
  const anchors = locateAnchors(repeated, [{ oldText: 'a\nb\nc', newText: 'a\nB\nc' }])
  assert(anchors === null, 'an ambiguous fragment was placed anyway')
})

check('a fragment the file no longer contains is refused', () => {
  const anchors = locateAnchors(file(20), [{ oldText: 'line 40', newText: 'line 40 changed' }])
  assert(anchors === null, 'a missing fragment was placed anyway')
})

check('a pure deletion is refused (its new side has no lines to find)', () => {
  // `newText: ''` places nothing, so there is no honest coordinate to report.
  const anchors = locateAnchors(file(20), [{ oldText: 'line 5\n', newText: '' }])
  assert(anchors === null, 'an empty new side was placed anyway')
})

check('one unplaceable fragment refuses the whole call', () => {
  // Mixing a located hunk with an unlocated one would number half a file from
  // the truth and half from a counter, which reads as a corrupt diff.
  const anchors = locateAnchors(file(20), [fragment(17, 23, 20), { oldText: 'gone', newText: 'gone away' }])
  assert(anchors === null, 'a partially placeable call was accepted')
})

check('CRLF fragments still place against LF file text', () => {
  const anchors = locateAnchors(file(60, [19]), [
    { oldText: 'line 17\r\nline 18\r\nline 19', newText: 'line 17\r\nline 18\r\nline 19 changed' },
  ])
  assert(anchors !== null, 'a CRLF fragment was refused')
  assert(anchors[0].newStart === 17, `placed at ${anchors[0].newStart}, expected 17`)
})

check('an empty file places nothing', () => {
  assert(locateAnchors('', [{ oldText: 'a', newText: 'b' }]) === null, 'an empty file placed a fragment')
})

console.log(failures === 0 ? '\nALL LOCATOR CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1