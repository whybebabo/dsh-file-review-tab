/**
 * Verify a deep link into an AUTO-ARCHIVED turn still lands on its row.
 *
 * The chat row's 审查 button publishes paths plus the owning turn, and the tab
 * replays them while opening the archive section in the SAME commit. Resolving
 * the target against the currently mounted rows therefore failed: an archived
 * turn's rows are not mounted yet, so the match came back empty, the pending
 * scroll was cleared, and the link silently landed nowhere — the archive opened
 * but nothing scrolled into view.
 *
 * `planDeepLink` therefore resolves against every turn the tab CAN render. These
 * checks pin the resolution, the archive reveal, and the ordering the scroll
 * target is chosen from.
 *
 * Runs standalone:  node test/deep-link.mjs
 */
import {
  ARCHIVE_KEEP_TURNS,
  ARCHIVE_PAGE_TURNS,
  splitArchivedTurns,
} from '../src/client/session-changes.ts'
import { planDeepLink } from '../src/client/deep-link.ts'

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

/** A session of `count` settled turns, each changing one file. */
const session = (count) => Array.from({ length: count }, (_, i) => ({
  turn: i + 1,
  live: false,
  files: [{ path: `file${i + 1}.ts` }],
}))

check('a link to an ARCHIVED turn resolves and reveals the archive', () => {
  const turns = session(12)
  const { archived } = splitArchivedTurns(turns)
  // The reported case: turn 7 is archived (only the newest 5 are kept).
  const target = archived[0]
  assert(target.turn === 7, `expected turn 7 to be archived, got ${target.turn}`)

  const plan = planDeepLink(turns, archived, [target.files[0].path], target.turn)
  assert(plan.first !== null, 'the archived target did not resolve at all')
  assert(plan.first.turn === target.turn, `resolved turn ${plan.first.turn}, expected ${target.turn}`)
  assert(plan.expanded.includes(`7|file7.ts`), `expand set was ${JSON.stringify(plan.expanded)}`)
  assert(plan.archive !== null, 'the archive section was not revealed')
  assert(plan.archive.pages * ARCHIVE_PAGE_TURNS >= 1, 'the reveal did not cover the target group')
})

check('the reveal pages far enough for a deep target', () => {
  const turns = session(40)
  const { archived } = splitArchivedTurns(turns)
  // Oldest archived turn: its index forces several pages.
  const target = archived[archived.length - 1]
  const plan = planDeepLink(turns, archived, [target.files[0].path], target.turn)
  assert(plan.first !== null, 'the oldest archived turn did not resolve')
  assert(plan.archive !== null, 'the archive section was not revealed')
  const archivedIndex = archived.findIndex(turn => turn.turn === target.turn)
  const needed = Math.ceil((archivedIndex + 1) / ARCHIVE_PAGE_TURNS)
  assert(plan.archive.pages === needed, `revealed ${plan.archive.pages} pages, needed ${needed}`)
})

check('a link to a MAIN-list turn needs no archive reveal', () => {
  const turns = session(12)
  const { main, archived } = splitArchivedTurns(turns)
  const target = main[0]
  const plan = planDeepLink(turns, archived, [target.files[0].path], target.turn)
  assert(plan.first !== null, 'a main-list target did not resolve')
  assert(plan.archive === null, 'a main-list target asked for an archive reveal')
})

check('a live turn is never treated as archived', () => {
  // A live turn stays in the main list however old its number is.
  const turns = [...session(3), { turn: 9, live: true, files: [{ path: 'live.ts' }] }]
  const { main, archived } = splitArchivedTurns(turns)
  assert(main.some(turn => turn.turn === 9), 'the live turn was not kept in the main list')
  const plan = planDeepLink(turns, archived, ['live.ts'], 9)
  assert(plan.first !== null, 'the live turn did not resolve')
  assert(plan.archive === null, 'a live turn was given an archive reveal')
})

check('a turn anchor confines expansion to that turn only', () => {
  // The same path recurs later; a turn-anchored link must not expand both.
  const turns = [
    { turn: 1, live: false, files: [{ path: 'shared.ts' }] },
    { turn: 2, live: false, files: [{ path: 'other.ts' }] },
    { turn: 3, live: false, files: [{ path: 'shared.ts' }] },
  ]
  const plan = planDeepLink(turns, [], ['shared.ts'], 1)
  assert(plan.expanded.join(',') === '1|shared.ts', `expanded ${JSON.stringify(plan.expanded)}`)
  assert(plan.first.turn === 1, `scrolled to turn ${plan.first.turn}, expected 1`)
})

check('a legacy path-only link expands every occurrence', () => {
  const turns = [
    { turn: 1, live: false, files: [{ path: 'shared.ts' }] },
    { turn: 3, live: false, files: [{ path: 'shared.ts' }] },
  ]
  const plan = planDeepLink(turns, [], ['shared.ts'], undefined)
  assert(plan.expanded.length === 2, `expanded ${JSON.stringify(plan.expanded)}, expected both turns`)
})

check('the scroll target is the newest matching row, as before', () => {
  const turns = [
    { turn: 1, live: false, files: [{ path: 'shared.ts' }] },
    { turn: 5, live: false, files: [{ path: 'shared.ts' }] },
  ]
  const plan = planDeepLink(turns, [], ['shared.ts'], undefined)
  assert(plan.first.turn === 5, `scrolled to turn ${plan.first.turn}, expected the newest (5)`)
})

check('a multi-path link anchors on its first matching row', () => {
  const turns = [
    { turn: 2, live: false, files: [{ path: 'a.ts' }, { path: 'b.ts' }] },
  ]
  const plan = planDeepLink(turns, [], ['a.ts', 'b.ts'], 2)
  assert(plan.expanded.length === 2, 'a multi-path link did not expand both rows')
  assert(plan.first !== null, 'a multi-path link resolved nothing')
  assert(plan.first.turn === 2, `anchored on turn ${plan.first.turn}`)
})

check('a link matching nothing stays unresolved rather than guessing', () => {
  const turns = session(3)
  assert(planDeepLink(turns, [], ['missing.ts'], 1).first === null, 'an absent path resolved')
  assert(planDeepLink(turns, [], ['file1.ts'], 99).first === null, 'an absent turn resolved')
})

check('an empty change set resolves nothing', () => {
  const plan = planDeepLink([], [], ['a.ts'], undefined)
  assert(plan.first === null && plan.expanded.length === 0, 'an empty session produced a target')
})

check('the archive reveal matches the keep threshold actually in force', () => {
  const turns = session(ARCHIVE_KEEP_TURNS + 1)
  const { main, archived } = splitArchivedTurns(turns)
  assert(archived.length === 1, `expected 1 archived turn, got ${archived.length}`)
  const plan = planDeepLink(turns, archived, [archived[0].files[0].path], archived[0].turn)
  assert(plan.first !== null, 'the boundary archived turn did not resolve')
  assert(plan.archive !== null, 'the boundary archived turn was not revealed')
  assert(!main.some(turn => turn.turn === archived[0].turn), 'the target was still in the main list')
})

console.log(failures === 0 ? '\nALL DEEP LINK CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
