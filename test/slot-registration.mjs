/**
 * Verify the plugin's turnTail registration shape against the REAL slot core.
 *
 * `conversation.chat.turnTail` became a `list` slot in dsh 0.2.0, where an
 * entry is keyed by `id` (the old chain shape declared `select` + `priority`).
 * This reproduces the real SlotCore validation to prove the plugin's
 * `{ id, order }` registration is accepted and that a chain-shaped
 * registration would NOT have been a valid list entry.
 *
 * Runs standalone (no build required):
 *   node test/slot-registration.mjs
 */
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

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

const component = () => null

check('list slot requires an `id` (the old chain shape has none)', () => {
  const core = new SlotCore()
  // Declare the slot the way ui-chat's parent entry does.
  core.register(
    { name: 'root', children: { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } } },
    () => null,
  )
  let threw = false
  try {
    core.register({ name: 'conversation.chat.turnTail' }, component)
  } catch (error) {
    threw = /requires options\.id/.test(error.message)
  }
  if (!threw) throw new Error('a list entry without id was accepted')
})

check('the plugin shape { id, order } registers as a list entry', () => {
  const core = new SlotCore()
  core.register(
    { name: 'root', children: { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } } },
    () => null,
  )
  core.register(
    {
      name: 'conversation.chat.turnTail',
      id: 'dsh-file-review-tab',
      order: -2,
      registrant: 'dsh-file-review-tab',
    },
    component,
  )
  const entries = core.entriesOfSlot('conversation.chat.turnTail')
  if (entries.length !== 1) throw new Error(`expected 1 entry, got ${entries.length}`)
  if (entries[0].options.id !== 'dsh-file-review-tab') {
    throw new Error(`unexpected id ${entries[0].options.id}`)
  }
  if (entries[0].options.order !== -2) throw new Error(`unexpected order ${entries[0].options.order}`)
})

check('duplicate id at the same priority is rejected (single-occupant cell)', () => {
  const core = new SlotCore()
  core.register(
    { name: 'root', children: { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } } },
    () => null,
  )
  const options = { name: 'conversation.chat.turnTail', id: 'dsh-file-review-tab' }
  core.register(options, component)
  let threw = false
  try {
    core.register(options, component)
  } catch (error) {
    threw = /already has an entry with id/.test(error.message)
  }
  if (!threw) throw new Error('a duplicate id+priority was accepted')
})

check('an undeclared slot is rejected at load time', () => {
  const core = new SlotCore()
  let threw = false
  try {
    core.register({ name: 'conversation.chat.turnTail', id: 'x' }, component)
  } catch (error) {
    threw = /is not declared/.test(error.message)
  }
  if (!threw) throw new Error('registration into an undeclared slot was accepted')
})

console.log(failures === 0 ? '\nALL SLOT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
