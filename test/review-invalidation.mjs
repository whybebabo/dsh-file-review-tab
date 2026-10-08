/** Verify session-scoped review-state invalidation and disposer behavior. */

import {
  publishFileReviewInvalidation,
  subscribeFileReviewInvalidation,
} from '../src/client/deep-link.ts'

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

check('review invalidations carry their session id to every subscriber', () => {
  const first = []
  const second = []
  const disposeFirst = subscribeFileReviewInvalidation(sessionId => first.push(sessionId))
  const disposeSecond = subscribeFileReviewInvalidation(sessionId => second.push(sessionId))

  publishFileReviewInvalidation('session-a')
  publishFileReviewInvalidation('session-b')
  disposeFirst()
  publishFileReviewInvalidation('session-c')
  disposeSecond()

  if (first.join(',') !== 'session-a,session-b') {
    throw new Error(`first subscriber received ${JSON.stringify(first)}`)
  }
  if (second.join(',') !== 'session-a,session-b,session-c') {
    throw new Error(`second subscriber received ${JSON.stringify(second)}`)
  }
})

console.log(failures === 0
  ? '\nALL REVIEW INVALIDATION CHECKS PASSED'
  : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
