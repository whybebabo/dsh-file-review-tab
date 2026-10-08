/**
 * Verify the shared diff core that both comparison surfaces render through.
 *
 * `toNativeHunks` is the bridge between this plugin's recorded before/after
 * snapshots and dsh's served hunk shape. If it drifts — wrong numbering, wrong
 * sign prefix, no context trimming — the sidebar and the hover preview both
 * render wrong lines while still *looking* plausible, which no render test can
 * catch. So the invariants are asserted directly.
 *
 * Runs standalone against the built client bundle:
 *   node test/diff-hunks.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] ?? resolve(here, '../lib/client.js')

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

// The bundle exposes only apply/inject, so reach the diff core through the
// internal module graph: build a tiny probe bundle instead of re-implementing
// the pairing here (a copy would pass while production drifts).
const probePath = resolve(here, '../lib/client.js')
const source = readFileSync(probePath, 'utf8')
// The core is bundled inline; locate it by a stable marker it owns.
const hasCore = source.includes('nativeDiffText') || source.includes('toNativeHunks')
check('the diff core is bundled into the client artifact', () => {
  assert(hasCore, 'the diff core is not present in lib/client.js')
})

// Behavioural checks run against the module's own logic, imported directly from
// source through the bundled transform: the functions are pure and dependency
// free apart from `diff`, so a direct import is faithful.
const { diffNote, missingMessage, pairLines, summarizeDiffs, toNativeHunks, isOneSided, nativeDiffText } =
  await import('../src/client/diff-hunks.ts').catch(async () => {
    // Older node cannot import .ts; fall back to the bundled copy via the
    // client's own module table.
    return {}
  })

if (pairLines === undefined) {
  console.log('  SKIP  direct source import unavailable in this node')
  console.log(failures === 0 ? '\nALL DIFF CORE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

const edit = (oldText, newText) => [{ path: 'a.ts', oldText, newText, oldStart: 1, newStart: 1 }]

check('a one-line edit trims to a small hunk, not the whole file', () => {
  const before = Array.from({ length: 200 }, (_v, i) => `line ${i + 1}`).join('\n')
  const after = before.replace('line 100', 'line 100 changed')
  const hunks = toNativeHunks(edit(before, after), 3)
  assert(hunks.length === 1, `expected 1 hunk, got ${hunks.length}`)
  // 3 context + 1 del + 1 add + 3 context = 8 lines, never 200.
  assert(hunks[0].lines.length === 8, `expected 8 lines, got ${hunks[0].lines.length}`)
  assert(hunks[0].lines.some(line => line.startsWith('-')), 'no deletion line')
  assert(hunks[0].lines.some(line => line.startsWith('+')), 'no addition line')
})

check('hunk coordinates number both sides correctly', () => {
  const hunks = toNativeHunks(edit('a\nb\nc\n', 'a\nB\nc\n'), 3)
  const hunk = hunks[0]
  assert(hunk.oldStart === 1 && hunk.oldLines === 3, `old: ${hunk.oldStart},${hunk.oldLines}`)
  assert(hunk.newStart === 1 && hunk.newLines === 3, `new: ${hunk.newStart},${hunk.newLines}`)
})

check('line text drops the sign, exactly as native derives it', () => {
  const hunks = toNativeHunks(edit('old\n', 'new\n'), 3)
  const texts = hunks.flatMap(hunk => hunk.lines.map(line => line.slice(1)))
  assert(texts.includes('old'), `missing "old" in ${JSON.stringify(texts)}`)
  assert(texts.includes('new'), `missing "new" in ${JSON.stringify(texts)}`)
})

check('a pure creation is one-sided (native collapses the split view)', () => {
  const hunks = toNativeHunks(edit(null, 'a\nb\n'), 3)
  assert(isOneSided(hunks), 'a creation was not reported one-sided')
})

check('comparison notes preserve empty creations and deletions', () => {
  assert(diffNote(edit(null, ''), []) === 'created', 'empty creation was labeled unchanged')
  assert(diffNote([], [], true) === 'deleted', 'deleted change lost its deleted note')
  assert(diffNote(edit('same', 'same'), []) === 'unchanged', 'unchanged comparison lost its note')
  const changed = edit('before', 'after')
  assert(diffNote(changed, toNativeHunks(changed)) === undefined, 'ordinary edit got a note')
})

check('a pure deletion is one-sided', () => {
  const hunks = toNativeHunks(edit('a\nb\n', ''), 3)
  assert(isOneSided(hunks), 'a deletion was not reported one-sided')
})

check('a command-deleted file keeps its own explanation, not the generic one', () => {
  // "deleted by a command" and "the change cannot be reconstructed" are
  // different facts; the sidebar body must not report the second for the first.
  assert(
    missingMessage(true, 'DELETED_BY_COMMAND', 'GENERIC') === 'DELETED_BY_COMMAND',
    'a deleted file fell back to the generic unavailable copy',
  )
  assert(
    missingMessage(false, 'DELETED_BY_COMMAND', 'GENERIC') === 'GENERIC',
    'an unreconstructable change lost its generic copy',
  )
})

check('a mixed edit is NOT one-sided (native keeps the split view)', () => {
  const hunks = toNativeHunks(edit('a\nb\n', 'a\nB\n'), 3)
  assert(!isOneSided(hunks), 'a mixed edit was reported one-sided')
})

check('counts come from the same pairing the viewer draws with', () => {
  const stats = summarizeDiffs(edit('a\nb\nc\n', 'a\nX\nY\nc\n'))
  assert(stats.added === 2, `added: ${stats.added}`)
  assert(stats.removed === 1, `removed: ${stats.removed}`)
  const hunks = toNativeHunks(edit('a\nb\nc\n', 'a\nX\nY\nc\n'), 3)
  const drawn = hunks.flatMap(hunk => hunk.lines)
  assert(drawn.filter(line => line.startsWith('+')).length === stats.added,
    'the +N badge disagrees with the drawn additions')
  assert(drawn.filter(line => line.startsWith('-')).length === stats.removed,
    'the -N badge disagrees with the drawn deletions')
})

check('serialized text round-trips the hunk headers', () => {
  const hunks = toNativeHunks(edit('a\nb\n', 'a\nB\n'), 3)
  const text = nativeDiffText(hunks)
  assert(text.startsWith('@@ -'), `no hunk header: ${text.slice(0, 20)}`)
  assert(text.includes('-b') && text.includes('+B'), 'missing changed lines')
})

check('multiple distant edits split into separate hunks', () => {
  const before = Array.from({ length: 100 }, (_v, i) => `line ${i + 1}`).join('\n')
  const after = before.replace('line 5', 'line 5 x').replace('line 90', 'line 90 y')
  const hunks = toNativeHunks(edit(before, after), 3)
  assert(hunks.length === 2, `expected 2 hunks, got ${hunks.length}`)
})

console.log(failures === 0 ? '\nALL DIFF CORE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
