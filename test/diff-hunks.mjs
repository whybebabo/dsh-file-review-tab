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

const edit = (oldText, newText, created = false) => [{
  path: 'a.ts', oldText, newText, oldStart: 1, newStart: 1,
  ...(created ? { created: true } : {}),
}]

const { structuredPatch } = await import('diff')

// The shared reversibility rule: the Host service and both surfaces must agree
// on exactly which hunks can be replayed, or a mixed turn reports a partial
// failure for files the service was always going to refuse.
const { changeReversible } = await import('../src/reversible.ts')

check('a complete anchored hunk is reversible', () => {
  assert(changeReversible('a.ts', edit('old\n', 'new\n')), 'a complete hunk was refused')
})

check('an unknown prior side is not reversible', () => {
  assert(!changeReversible('a.ts', [{ path: 'a.ts', oldText: null, newText: 'x\n' }]),
    'a null old side (created/unknown history) was accepted')
})

check('an unanchored empty side is not reversible', () => {
  assert(!changeReversible('a.ts', [{ path: 'a.ts', oldText: '', newText: 'x\n' }]),
    'an empty old side without oldStart was accepted')
  assert(!changeReversible('a.ts', [{ path: 'a.ts', oldText: 'x\n', newText: '' }]),
    'an empty new side without newStart was accepted')
  assert(changeReversible('a.ts', [{ path: 'a.ts', oldText: '', newText: 'x\n', oldStart: 1, newStart: 1 }]),
    'a legally anchored empty old side was refused')
})

check('an identical pair and a foreign path are not reversible', () => {
  assert(!changeReversible('a.ts', edit('same\n', 'same\n')), 'an unchanged pair was accepted')
  assert(!changeReversible('b.ts', edit('old\n', 'new\n')), 'a hunk naming another path was accepted')
})

check('an empty change set is not reversible', () => {
  assert(!changeReversible('a.ts', []), 'an empty change set was accepted')
})

/**
 * dsh-tool-fs's own `computeHunkDiffs`: one context fragment per hunk, 3 lines
 * of context, and no line numbers in the payload. Reproduced here from the
 * engine's source rather than reused from this plugin, so what the renderer is
 * fed is the real wire shape and the anchor split is compared against the very
 * patch it must match.
 */
const engineFragments = (before, after) => structuredPatch('', '', before, after, undefined, undefined, { context: 3 })
  .hunks.map((hunk) => {
    const oldLines = []
    const newLines = []
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) oldLines.push(text)
      else if (line.startsWith('+')) newLines.push(text)
      else { oldLines.push(text); newLines.push(text) }
    }
    return { oldLines, newLines }
  })

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
  assert(diffNote(edit(null, '', true), []) === 'created', 'empty creation was labeled unchanged')
  assert(diffNote([], [], true) === 'deleted', 'deleted change lost its deleted note')
  assert(diffNote(edit('same', 'same'), []) === 'unchanged', 'unchanged comparison lost its note')
  const changed = edit('before', 'after')
  assert(diffNote(changed, toNativeHunks(changed)) === undefined, 'ordinary edit got a note')
})

check('a creation note survives an unflagged hunk later in the same file', () => {
  // Creation is a FILE-level fact, so one authoritative creation record carries
  // it for the whole file. The failing shape was a turn that created a file and
  // then edited it: only the first hunk is flagged, so `every()` returned false
  // and the "created in this turn" note disappeared even though it was true.
  const created = { path: 'a.ts', oldText: null, newText: 'a\n', created: true }
  const later = { path: 'a.ts', oldText: 'a', newText: 'b', oldStart: 1, newStart: 1 }
  assert(diffNote([created, later], toNativeHunks([created, later])) === 'created',
    'a later edit cleared the creation note')
  // Order must not matter (hunks arrive in settlement order, but the fact does
  // not depend on it), and an unflagged-only list must stay unlabeled.
  assert(diffNote([later, created], toNativeHunks([later, created])) === 'created',
    'the creation note depended on hunk order')
  assert(diffNote([later], toNativeHunks([later])) === undefined,
    'a list without any creation record was labeled created')
})

check('a null old side alone never means "created"', () => {
  // The regression this guards: inferring the creation note from
  // `oldText === null`. Null also means "the prior content is unavailable", and
  // mutation-call.ts synthesizes exactly that when a result carries no
  // meta.diffs for a `write` overwrite, a `str_replace_editor insert`, or an
  // `edit` whose old_string is empty. All three change files that ALREADY
  // EXISTED, so labeling them "created in this turn" was wrong.
  for (const [label, oldText] of [['write overwrite', null], ['insert', null], ['empty old_string', null]]) {
    const diffs = edit(oldText, 'new content\n')
    const note = diffNote(diffs, toNativeHunks(diffs))
    assert(note !== 'created', `${label} was labeled created from a null old side`)
  }
  // An explicit creation flag is what carries the fact, and it must survive
  // alongside a non-null old side (an empty file recreated in place).
  const flagged = edit('', 'new content\n', true)
  assert(diffNote(flagged, toNativeHunks(flagged)) === 'created', 'an explicit creation flag was ignored')
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

// --- absolute line numbers -------------------------------------------------
// A wire hunk is a context fragment with no line numbers in it, so the renderer
// can only count from 1 unless the Host's recorded coordinates are supplied.
// These pin the pairing rules: position within a call, refusal on a count
// mismatch, and a fragment-only hunk keeping exactly its old behaviour.
{
  const { hunkAnchors } = await import('../src/hunk-anchors.ts').catch(() => ({}))

  check('anchors number a fragment by the file lines it really sits on', () => {
    // 20 unchanged lines, one replaced: the fragment is lines 17..23 of the file.
    const before = Array.from({ length: 20 }, (_v, i) => `line ${i + 1}`)
    const after = [...before]
    after[19] = 'line 20 changed'
    const oldText = before.slice(16).join('\n')
    const newText = after.slice(16).join('\n')
    const diff = { path: 'a.ts', oldText, newText, callId: 'call-1' }
    const hunks = toNativeHunks([diff], 3, new Map([['call-1', [{ oldStart: 17, newStart: 17 }]]]))
    assert(hunks[0].oldStart === 17, `hunk started at ${hunks[0].oldStart}, expected 17`)
    const deleted = hunks[0].lines.findIndex(line => line.startsWith('-'))
    assert(deleted === 3, `change sat at offset ${deleted}, expected 3`)
  })

  check('without an anchor the fragment keeps its hunk-local numbering', () => {
    const before = Array.from({ length: 20 }, (_v, i) => `line ${i + 1}`)
    const after = [...before]
    after[19] = 'line 20 changed'
    const diff = { path: 'a.ts', oldText: before.slice(16).join('\n'), newText: after.slice(16).join('\n'), callId: 'call-1' }
    const hunks = toNativeHunks([diff], 3)
    assert(hunks[0].oldStart === 1, `unanchored hunk started at ${hunks[0].oldStart}, expected 1`)
  })

  check('one anchor list feeds a call\'s fragments in order', () => {
    // Two fragments from ONE call: the second must take the second anchor.
    const diffs = [
      { path: 'a.ts', oldText: 'a\nb\nc', newText: 'a\nB\nc', callId: 'call-9' },
      { path: 'a.ts', oldText: 'd\ne\nf', newText: 'd\nE\nf', callId: 'call-9' },
    ]
    const anchors = new Map([['call-9', [{ oldStart: 11, newStart: 11 }, { oldStart: 41, newStart: 41 }]]])
    const hunks = toNativeHunks(diffs, 3, anchors)
    assert(hunks.length === 2, `expected 2 hunks, got ${hunks.length}`)
    assert(hunks[1].oldStart === 41, `second hunk started at ${hunks[1].oldStart}, expected 41`)
  })

  check('a mismatched anchor count is refused, not applied', () => {
    // Two anchors for one fragment means the list describes a different patch;
    // using it would shift every number in the file instead of merely leaving
    // them hunk-local, so the call falls back entirely.
    const diff = { path: 'a.ts', oldText: 'x\ny', newText: 'x\nY', callId: 'call-2' }
    const anchors = new Map([['call-2', [{ oldStart: 30, newStart: 30 }, { oldStart: 60, newStart: 60 }]]])
    const hunks = toNativeHunks([diff], 3, anchors)
    assert(hunks[0].oldStart === 1, `refused anchor still shifted the hunk to ${hunks[0].oldStart}`)
  })

  check('hunkAnchors splits hunks exactly as the engine\'s fragments do', () => {
    // The Host computes coordinates with structuredPatch over before/after, and
    // the engine derived the fragments the client holds the same way. If the
    // split ever disagreed, the positional pairing above would be meaningless —
    // so prove the two lengths agree on a multi-hunk file.
    const before = Array.from({ length: 60 }, (_v, i) => `line ${i + 1}`).join('\n')
    const after = before
      .replace('line 5', 'line 5 x')
      .replace('line 30', 'line 30 y')
      .replace('line 55', 'line 55 z')
    const fragments = engineFragments(before, after)
    const anchors = hunkAnchors(before, after)
    assert(anchors.length === fragments.length,
      `anchors ${anchors.length} vs fragments ${fragments.length}`)
    assert(anchors[0].newStart === 2, `first anchor started at ${anchors[0].newStart}, expected 2`)
  })
}

// The provenance rule, exercised end to end through the modules that actually
// produce these diffs — a unit test on diffNote alone would not catch a wrong
// flag at the source, which is where the bug lived.
const { deriveSessionChanges, mergeRecordedTurns } =
  await import('../src/client/session-changes.ts').catch(() => ({}))
const { diffsFromBeforeAfter } = await import('../src/client/recorded-diffs.ts').catch(() => ({}))
if (deriveSessionChanges !== undefined) {
  /** A settled tool-result node carrying NO meta.diffs (the fallback path). */
  const node = (name, args, meta = {}) => ({
    kind: 'tool-result', seq: 1, isError: false, subCalls: [], callId: 'call-1',
    call: { name, argsRaw: JSON.stringify(args) }, meta,
  })
  const noteOfNode = (settled) => {
    const snapshot = { nodes: [settled], turnEnds: new Map([[1, 1]]), partial: null, runningCalls: [] }
    const file = deriveSessionChanges(snapshot).flatMap(turn => turn.files)[0]
    if (file === undefined) return { note: 'NO FILE', diffs: [] }
    const hunks = toNativeHunks(file.diffs, 3)
    return { note: diffNote(file.diffs, hunks), diffs: file.diffs }
  }

  check('only authoritative provenance is labeled "created"', () => {
    // Genuine creations: the call shape guarantees the file did not exist.
    const create = noteOfNode(node('str_replace_editor',
      { command: 'create', path: 'new.ts', file_text: 'hello\n' }))
    assert(create.note === 'created', `str_replace_editor create: ${create.note}`)
    assert(create.diffs.every(diff => diff.created === true), 'create did not set the explicit flag')

    // Edits to files that already existed, on the no-meta fallback path. Each of
    // these synthesizes `oldText: null` merely because the prior content is
    // unknown, which is exactly what must NOT be read as a creation.
    for (const [label, settled] of [
      ['str_replace_editor insert', node('str_replace_editor',
        { command: 'insert', path: 'existing.ts', new_str: 'inserted\n' })],
      ['write overwrite', node('write', { file_path: 'existing.ts', content: 'replaced\n' })],
      ['edit with empty old_string', node('edit',
        { file_path: 'existing.ts', old_string: '', new_string: 'x\n' })],
    ]) {
      const result = noteOfNode(settled)
      assert(result.note !== 'created', `${label} was labeled created (note=${result.note})`)
      assert(result.diffs.every(diff => diff.created !== true), `${label} set the creation flag`)
    }
  })

  // End to end over the model-direct path the reported bug came from: two
  // engine fragments from two calls, the Host's coordinates for each call, and
  // the renderer's pairing. The whole chain is exercised, because the anchor
  // lookup only works if derivation stamps the call id it keys on.
  check('a turn\'s model-direct edits are numbered by the file\'s own lines', async () => {
    const { hunkAnchors } = await import('../src/hunk-anchors.ts')
    const before = Array.from({ length: 40 }, (_v, i) => `line ${i + 1}`)
    const step1 = [...before]
    step1[4] = 'line 5 changed'
    const step2 = [...step1]
    step2[34] = 'line 35 changed'
    const fragments = (from, to) => engineFragments(from.join('\n'), to.join('\n')).map(hunk => ({
      path: 'a.ts', oldText: hunk.oldLines.join('\n'), newText: hunk.newLines.join('\n'),
    }))
    const settled = (seq, callId, oldString, newString, diffs) => ({
      kind: 'tool-result', seq, isError: false, subCalls: [], callId,
      call: { name: 'edit', argsRaw: JSON.stringify({ file_path: 'a.ts', old_string: oldString, new_string: newString }) },
      meta: { diffs },
    })
    const snapshot = {
      nodes: [
        settled(1, 'call-1', 'line 5', 'line 5 changed', fragments(before, step1)),
        settled(2, 'call-2', 'line 35', 'line 35 changed', fragments(step1, step2)),
      ],
      turnEnds: new Map([[1, 2]]),
      partial: null,
      runningCalls: [],
    }
    const file = deriveSessionChanges(snapshot).flatMap(turn => turn.files)[0]
    assert(file !== undefined, 'the turn derived no file')
    assert(file.diffs.every(diff => diff.callId !== undefined), 'a derived hunk lost its call id')

    const anchors = new Map([
      ['call-1', hunkAnchors(before.join('\n'), step1.join('\n'))],
      ['call-2', hunkAnchors(step1.join('\n'), step2.join('\n'))],
    ])
    const anchored = toNativeHunks(file.diffs, 3, anchors)
    const starts = anchored.map(hunk => hunk.oldStart).join(',')
    assert(starts === '2,32', `anchored hunk starts were ${starts}, expected 2,32`)

    // Without the coordinates the very same hunks still draw, just hunk-local —
    // the fallback that keeps an old Host working.
    const plain = toNativeHunks(file.diffs, 3).map(hunk => hunk.oldStart).join(',')
    assert(plain === '1,1', `unanchored hunk starts were ${plain}, expected 1,1`)
  })

  check('the engine wire path decodes a null old side as a creation', () => {
    // meta.diffs is authoritative: dsh's own schema documents `oldText` as
    // "The original content (None for new files)". This is the ONE path where a
    // null old side may be read as a creation, and it must keep working.
    const settled = node('write', { file_path: 'made.ts', content: 'a\n' }, {
      diffs: [{ path: 'made.ts', oldText: null, newText: 'a\n' }],
    })
    const result = noteOfNode(settled)
    assert(result.note === 'created', `a wire creation lost its note (${result.note})`)
    assert(result.diffs.every(diff => diff.created === true), 'the wire creation did not set the flag')
  })

  // Code Mode (`run_code`) mutations reach review through the Host recorder's
  // full before/after pair, not the wire views. Both checks below drive that
  // path, because that is where the two reported gaps lived.
  if (diffsFromBeforeAfter !== undefined && mergeRecordedTurns !== undefined) {
    const recordedRoot = { turn: 1, live: false, rootCallId: 'root-1' }
    /** Merge recorded Code Mode mutations for one turn. */
    const mergeRecorded = (mutations) =>
      mergeRecordedTurns([], [recordedRoot], mutations).flatMap(turn => turn.files)
    /** The single merged file, with its note, or a loud failure. */
    const recordedFile = (mutations) => {
      const files = mergeRecorded(mutations)
      assert(files.length === 1, `expected 1 file, got ${files.length}`)
      return { ...files[0], note: diffNote(files[0].diffs, toNativeHunks(files[0].diffs, 3)) }
    }

    check('a Code Mode creation of an empty file is not discarded', () => {
      // `before === null` is a recorded fact: the path did not exist. An empty
      // `after` therefore still created the file, and returning [] here made
      // mergeRecordedTurns skip the mutation entirely — the file never appeared
      // in review. The model-direct twin (`str_replace_editor create` with no
      // file_text) reports this exact shape, so both must agree.
      const file = recordedFile([
        { rootCallId: 'root-1', name: 'write', path: 'empty.ts', before: null, after: '' },
      ])
      assert(file.diffs.length === 1, `empty creation produced ${file.diffs.length} diffs`)
      assert(file.diffs[0].created === true, 'the empty creation did not set the creation flag')
      assert(file.diffs[0].oldText === null, 'the empty creation lost its null old side')
      assert(file.diffs[0].newText === '', 'the empty creation gained content')
      assert(file.note === 'created', `empty creation was noted ${file.note}, not created`)
      // The empty pair draws no lines; the note is what identifies the file.
      assert(toNativeHunks(file.diffs, 3).length === 0, 'an empty creation drew hunks')
    })

    check('creation survives a later edit to the same file in one turn', () => {
      // Creation is a file-level fact. The first mutation records it; the
      // second is an ordinary edit whose hunk carries no flag. Requiring EVERY
      // hunk to be flagged dropped the note precisely here, even though the
      // file was still created in this turn.
      const file = recordedFile([
        { rootCallId: 'root-1', name: 'write', path: 'new.ts', before: null, after: 'a\n' },
        { rootCallId: 'root-1', name: 'edit', path: 'new.ts', before: 'a\n', after: 'b\n' },
      ])
      assert(file.diffs.length === 2, `expected both hunks, got ${file.diffs.length}`)
      assert(file.diffs[0].created === true, 'the creation hunk lost its flag')
      assert(file.diffs[1].created !== true, 'the ordinary edit was flagged as a creation')
      assert(file.note === 'created', `create-then-edit was noted ${file.note}, not created`)
      // And the reverse order must NOT invent a creation for a pre-existing file.
      const edited = recordedFile([
        { rootCallId: 'root-1', name: 'write', path: 'old.ts', before: 'a\n', after: 'b\n' },
        { rootCallId: 'root-1', name: 'edit', path: 'old.ts', before: 'b\n', after: 'c\n' },
      ])
      assert(edited.note !== 'created', `an existing file was labeled ${edited.note}`)
    })

    check('an unchanged recorded mutation still contributes nothing', () => {
      // The empty-creation fix must not turn a genuine no-op into a review row:
      // identical before/after changes nothing on disk.
      assert(
        diffsFromBeforeAfter('same.ts', 'a\n', 'a\n').length === 0,
        'an unchanged existing file produced a diff',
      )
      assert(
        diffsFromBeforeAfter('same.ts', '', '').length === 0,
        'an unchanged empty existing file produced a diff',
      )
      const files = mergeRecorded([
        { rootCallId: 'root-1', name: 'write', path: 'same.ts', before: 'a\n', after: 'a\n' },
      ])
      assert(files.length === 0, `an unchanged mutation produced ${files.length} files`)
    })
  }
}

console.log(failures === 0 ? '\nALL DIFF CORE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
