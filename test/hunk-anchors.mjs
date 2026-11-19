/**
 * The client's anchor cache: claim/release bookkeeping and the lookup it hands
 * the renderer.
 *
 * The hook around it needs a DOM to run effects, which this repo's tests do not
 * have, so the DECISIONS live in pure functions and are tested here: which calls
 * get asked about, how a failure re-opens them, and that the renderer sees an
 * immutable lookup whose identity moves only when it gains coordinates.
 *
 * Run after `pnpm build`:  node test/hunk-anchors.mjs
 */
import {
  cachedHunkAnchors, claimCallIds, forgetHunkAnchors, releaseCallIds, rememberHunkAnchors,
} from '../src/client/hunk-anchors.ts'

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

check('a session with no lookup yet reads as an empty map', () => {
  const lookup = cachedHunkAnchors('session-empty')
  assert(lookup.size === 0, `expected an empty lookup, got ${lookup.size}`)
})

check('claiming an id asks about it once', () => {
  const session = 'session-claim'
  const first = claimCallIds(session, ['call-1', 'call-2'])
  assert(first.join(',') === 'call-1,call-2', `first claim was ${first.join(',')}`)
  // A second paint of the same hunks (the tab remounts, the preview reopens)
  // must not ask again: a HunkAnchor never appears later for a claimed id.
  const second = claimCallIds(session, ['call-2', 'call-1', 'call-3'])
  assert(second.join(',') === 'call-3', `second claim was ${second.join(',')}, expected call-3`)
})

check('duplicates inside one claim collapse', () => {
  // A file with two fragments from the same call paints two hunks but needs one
  // lookup, and the request must not carry the id twice.
  const claimed = claimCallIds('session-dupes', ['call-9', 'call-9', 'call-8', 'call-9'])
  assert(claimed.join(',') === 'call-9,call-8', `claim was ${claimed.join(',')}`)
})

check('a failed lookup releases its ids for a later attempt', () => {
  const session = 'session-retry'
  const claimed = claimCallIds(session, ['call-1'])
  assert(claimed.length === 1, 'the first claim took nothing')
  // Nothing arrived (no Remote mounted yet). Releasing is what keeps the hunks
  // from being permanently stuck at hunk-local numbering.
  releaseCallIds(session, claimed)
  const again = claimCallIds(session, ['call-1'])
  assert(again.join(',') === 'call-1', `after release, claim was ${again.join(',')}`)
})

check('remembering coordinates yields a new lookup and keeps the old one intact', () => {
  const session = 'session-remember'
  const before = cachedHunkAnchors(session)
  const after = rememberHunkAnchors(session, [
    { callId: 'call-1', path: 'a.ts', anchors: [{ oldStart: 17, newStart: 17 }] },
  ])
  assert(after !== before, 'the lookup identity did not change, so React would not re-render')
  assert(before.size === 0, 'the previous lookup was mutated instead of replaced')
  assert(after.get('call-1')?.[0].newStart === 17, 'the recorded coordinate was not stored')
  assert(cachedHunkAnchors(session) === after, 'the cache did not adopt the new lookup')
})

check('a later answer adds to the previous one without losing it', () => {
  const session = 'session-merge'
  rememberHunkAnchors(session, [
    { callId: 'call-1', path: 'a.ts', anchors: [{ oldStart: 3, newStart: 3 }] },
  ])
  const merged = rememberHunkAnchors(session, [
    { callId: 'call-2', path: 'b.ts', anchors: [{ oldStart: 9, newStart: 9 }] },
  ])
  assert(merged.size === 2, `expected 2 calls, got ${merged.size}`)
  assert(merged.get('call-1')?.[0].oldStart === 3, 'the first call was dropped')
})

check('forgetting a session drops both its cache and its claims', () => {
  const session = 'session-forget'
  rememberHunkAnchors(session, [
    { callId: 'call-1', path: 'a.ts', anchors: [{ oldStart: 1, newStart: 1 }] },
  ])
  claimCallIds(session, ['call-1'])
  forgetHunkAnchors(session)
  assert(cachedHunkAnchors(session).size === 0, 'the coordinates survived')
  // The claim must be gone too, or a disposed session's ids would never be asked
  // about if the id were ever reused.
  assert(claimCallIds(session, ['call-1']).join(',') === 'call-1', 'the claim survived')
})

console.log(failures === 0 ? '\nALL ANCHOR CACHE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1