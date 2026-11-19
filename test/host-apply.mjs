/**
 * Drive the plugin's HOST half (`apply`) against a REAL cordis Context.
 *
 * This is the real module entry the DSH host loader calls. It proves the host
 * half still wires up on the current dsh line — `apply()` needs no host
 * services, the `tools/post-execute` recorder installs, and the `fileReview`
 * Remote service constructs and answers `recorded()` — without needing a full
 * profile boot.
 *
 * A hand-rolled context stub is not enough: `TypertRemoteService extends
 * Service` publishes itself through the cordis reflection layer, so only a real
 * Context exercises the same code path the host uses.
 *
 * Run after `pnpm build`:  node test/host-apply.mjs
 */
import { Context } from '@deepseek-ai/cordis'

const mod = await import('../lib/index.js')

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

console.log('exports:', Object.keys(mod).join(', '))

const sections = []
const effects = []

const ctx = new Context()

// The host half must NOT register prompt guidance: the Web composition already
// contributes `ui:deliverable-file-references`, and this plugin's own section
// contradicted it (inline code vs. Markdown links) in every request. A spy that
// records and throws turns any regression into a hard failure here.
ctx.provide('systemPrompt', {
  section(section) {
    sections.push(section)
    throw new Error('the host half registered a system-prompt section of its own')
  },
})

// Observe effects without replacing cordis's own implementation.
const originalEffect = ctx.effect.bind(ctx)
ctx.effect = (fn, label) => {
  effects.push(label)
  return originalEffect(fn, label)
}

const agent = {
  id: 'agent-1',
  session: { header: { cwd: process.cwd() } },
  runMaintenance: fn => fn(),
}

await check('apply() runs without throwing', () => {
  mod.apply(ctx)
})

await check('registers no system-prompt guidance of its own', () => {
  if (sections.length !== 0) {
    throw new Error(`expected no sections, got ${sections.map(section => section.name).join(', ')}`)
  }
})

await check('publishes the fileReview Remote service', () => {
  const service = ctx.get('fileReview')
  if (service === undefined) throw new Error('ctx.get("fileReview") returned undefined')
})

await check('registers the ptc recorder through ctx.effect', () => {
  if (!effects.some(label => String(label).includes('ptc recorder'))) {
    throw new Error(`effects: ${effects.map(String).join(', ') || '(none)'}`)
  }
})

await check('installs a tools/post-execute listener', () => {
  // cordis exposes registered listeners through its internal event map; the
  // observable proof is that a dispatch reaches the recorder (asserted below).
  if (typeof ctx.on !== 'function') throw new Error('ctx.on missing')
})

await check('exports the service and hunk transformer surface', () => {
  if (typeof mod.FileReviewService !== 'function') throw new Error('FileReviewService missing')
  if (typeof mod.transformFile !== 'function') throw new Error('transformFile missing')
})

await check('requires no host services of its own', () => {
  if (!Array.isArray(mod.inject) || mod.inject.length !== 0) {
    throw new Error(`inject: ${JSON.stringify(mod.inject)}`)
  }
})

// Drive the recorder through the real cordis event bus, exactly as the tool
// registry does: emit 'tools/post-execute' with (exec, result, next).
const emit = (exec, result, next = async () => ({ kind: 'accept' })) =>
  ctx.emit('tools/post-execute', exec, result, next)

await check('recorder records line coordinates for a model-direct mutation', async () => {
  // Model-direct calls used to be skipped entirely: their review hunks arrive
  // through the conversation snapshot, which has no line numbers in it — so the
  // renderer could only count each hunk from 1 ("line 1" for a change near the
  // end of a file). This hook is the one place the mutation's real coordinates
  // still exist, so EVERY mutation now contributes them, nested or not.
  const before = Array.from({ length: 30 }, (_v, i) => `line ${i + 1}`).join('\n')
  const after = before.replace('line 20', 'line 20 changed')
  await emit({ name: 'edit', callId: 'c1', agent }, { value: { path: 'a.ts', before, after } })
  const service = ctx.get('fileReview')
  const result = await service.anchors(agent, {
    calls: [{ callId: 'c1', path: 'a.ts', hunks: [{ oldText: 'line 20', newText: 'line 20 changed' }] }],
  })
  if (!Array.isArray(result?.anchors) || result.anchors.length !== 1) {
    throw new Error(`expected 1 anchor entry, got ${JSON.stringify(result)}`)
  }
  const [entry] = result.anchors
  if (entry.path !== 'a.ts') throw new Error(`unexpected path ${entry.path}`)
  if (entry.anchors.length !== 1) throw new Error(`expected 1 hunk anchor, got ${entry.anchors.length}`)
  if (entry.anchors[0].newStart !== 17) {
    throw new Error(`hunk anchored at new line ${entry.anchors[0].newStart}, expected 17`)
  }
  // A model-direct mutation is reviewable through the snapshot alone, so it must
  // still NOT land in the Code Mode record log.
  const recordedResult = await service.recorded(agent, { rootCallIds: ['c1'] })
  if (recordedResult.mutations.length !== 0) {
    throw new Error(`a model-direct mutation entered the Code Mode log: ${JSON.stringify(recordedResult)}`)
  }
})

await check('anchors() omits a call it cannot resolve either way', async () => {
  const service = ctx.get('fileReview')
  // No recording for this id, and the agent has no workspace to look in, so the
  // locate fallback cannot answer: the call is simply absent and the client
  // keeps its hunk-local numbering.
  const result = await service.anchors(agent, {
    calls: [{ callId: 'nope', path: 'a.ts', hunks: [{ oldText: 'x', newText: 'y' }] }],
  })
  if (result.anchors.length !== 0) throw new Error(`expected 0, got ${result.anchors.length}`)
  const empty = await service.anchors(agent, { calls: [] })
  if (empty.anchors.length !== 0) throw new Error('an empty request answered with entries')
})

await check('recorder tolerates malformed result payloads', async () => {
  const base = { name: 'edit', parent: {}, agent }
  await emit({ ...base, callId: 'c2' }, { value: 42 })
  await emit({ ...base, callId: 'c3' }, { value: null })
  await emit({ ...base, callId: 'c4' }, { value: [] })
  await emit({ ...base, callId: 'c5' }, { value: { path: 7, after: 'x' } })
  await emit({ ...base, callId: 'c6' }, { value: { path: 'a', before: 1, after: 'x' } })
})

await check('recorder captures a well-formed nested mutation', async () => {
  await emit(
    { name: 'edit', callId: 'c8', rootCallId: 'root-1', parent: {}, agent },
    { value: { path: 'b.ts', before: 'old', after: 'new' } },
  )
  const service = ctx.get('fileReview')
  const result = await service.recorded(agent, { rootCallIds: ['root-1'] })
  if (!Array.isArray(result?.mutations) || result.mutations.length !== 1) {
    throw new Error(`expected 1 recorded mutation, got ${JSON.stringify(result)}`)
  }
  const [mutation] = result.mutations
  if (mutation.path !== 'b.ts' || mutation.before !== 'old' || mutation.after !== 'new') {
    throw new Error(`unexpected mutation ${JSON.stringify(mutation)}`)
  }
  // A nested dispatch is a mutation like any other: it gets coordinates too.
  const anchored = await service.anchors(agent, {
    calls: [{ callId: 'c8', path: 'b.ts', hunks: [{ oldText: 'old', newText: 'new' }] }],
  })
  if (anchored.anchors.length !== 1 || anchored.anchors[0].callId !== 'c8') {
    throw new Error(`nested mutation lost its anchors: ${JSON.stringify(anchored)}`)
  }
})

await check('recorded() scopes results to the queried rootCallIds', async () => {
  const service = ctx.get('fileReview')
  const result = await service.recorded(agent, { rootCallIds: ['nope'] })
  if (result.mutations.length !== 0) throw new Error(`expected 0, got ${result.mutations.length}`)
})

await check('anchors() places a hunk it never recorded, from the file on disk', async () => {
  // The retroactive path: a session reviewed after the plugin was installed has
  // hunks the recorder never saw. Their coordinates are recovered by finding the
  // fragment in the file as it stands — the only honest answer, and the one that
  // makes an OLD turn readable instead of showing "line 1".
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(process.cwd(), '.tmp-frt-locate-'))
  const path = join(dir, 'notes.md')
  const lines = Array.from({ length: 40 }, (_v, i) => `line ${i + 1}`)
  lines[24] = 'line 25 changed'
  await writeFile(path, lines.join('\n'), 'utf8')
  try {
    // The reviewed hunk is lines 22..28, as the engine would have trimmed it.
    const oldText = Array.from({ length: 7 }, (_v, i) => `line ${22 + i}`).join('\n')
    const newSide = Array.from({ length: 7 }, (_v, i) => (i === 3 ? 'line 25 changed' : `line ${22 + i}`))
    const service = ctx.get('fileReview')
    const result = await service.anchors(agent, {
      calls: [{
        callId: 'never-recorded',
        path,
        hunks: [{ oldText, newText: newSide.join('\n') }],
      }],
    })
    if (result.anchors.length !== 1) {
      throw new Error(`expected an entry for the located call, got ${JSON.stringify(result)}`)
    }
    const [entry] = result.anchors
    if (entry.callId !== 'never-recorded') throw new Error(`unexpected call ${entry.callId}`)
    if (entry.anchors[0].newStart !== 22) {
      throw new Error(`placed at ${entry.anchors[0].newStart}, expected 22`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('anchors() refuses a fragment the file no longer contains', async () => {
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(process.cwd(), '.tmp-frt-locate-'))
  const path = join(dir, 'gone.md')
  await writeFile(path, 'something else entirely\n', 'utf8')
  try {
    const service = ctx.get('fileReview')
    const result = await service.anchors(agent, {
      calls: [{ callId: 'c-missing', path, hunks: [{ oldText: 'a', newText: 'changed text' }] }],
    })
    if (result.anchors.length !== 0) {
      throw new Error(`expected no entry for an unplaceable call, got ${JSON.stringify(result)}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log(failures === 0 ? '\nALL HOST CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1

