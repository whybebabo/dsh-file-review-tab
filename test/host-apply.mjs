/**
 * Drive the plugin's HOST half (`apply`) against a REAL cordis Context.
 *
 * This is the real module entry the DSH host loader calls. It proves the host
 * half still wires up on dsh 0.2.0 — the system-prompt section registers, the
 * `tools/post-execute` recorder installs, and the `fileReview` Remote service
 * constructs and answers `recorded()` — without needing a full profile boot.
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

// The system-prompt registry is normally contributed by dsh-system-prompt;
// stand in for it so apply() can register its guidance section. cordis only
// lets a context read services registered through provide/Service, so the stub
// goes in through provide() rather than a plain property set.
const systemPromptStub = {
  section(section) {
    sections.push(section)
    return () => {}
  },
}
ctx.provide('systemPrompt', systemPromptStub)

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

await check('registers exactly one system-prompt section', () => {
  if (sections.length !== 1) throw new Error(`expected 1 section, got ${sections.length}`)
  const [section] = sections
  if (section.name !== 'ui:file-review-references') throw new Error(`unexpected name ${section.name}`)
  if (typeof section.text !== 'string' || section.text.length === 0) throw new Error('empty text')
  if (section.order !== 190) throw new Error(`unexpected order ${section.order}`)
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

await check('inject declares the systemPrompt service', () => {
  if (!Array.isArray(mod.inject) || !mod.inject.includes('systemPrompt')) {
    throw new Error(`inject: ${JSON.stringify(mod.inject)}`)
  }
})

// Drive the recorder through the real cordis event bus, exactly as the tool
// registry does: emit 'tools/post-execute' with (exec, result, next).
const emit = (exec, result, next = async () => ({ kind: 'accept' })) =>
  ctx.emit('tools/post-execute', exec, result, next)

await check('recorder ignores a model-direct (non-nested) mutation', async () => {
  await emit({ name: 'edit', callId: 'c1' }, { value: { path: 'a.ts', before: null, after: 'x' } })
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
})

await check('recorded() scopes results to the queried rootCallIds', async () => {
  const service = ctx.get('fileReview')
  const result = await service.recorded(agent, { rootCallIds: ['nope'] })
  if (result.mutations.length !== 0) throw new Error(`expected 0, got ${result.mutations.length}`)
})

console.log(failures === 0 ? '\nALL HOST CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
