/**
 * Runtime acceptance test for this plugin's Host Typert contribution.
 *
 * Type-level compatibility is not enough here: dsh 0.2.0's registry validates
 * every strict codec at registration time and calls `create()` to materialize
 * the process-realm schema. This drives the package's BUILT artifact
 * (lib/typert.host.js) through the REAL 0.2.0 registry, so a wrong codec shape
 * fails loudly in CI instead of only failing at a user's first undo click.
 *
 * Run after `pnpm build`:  node test/typert-descriptors.mjs
 */
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { Context } from '@deepseek-ai/cordis'

const contribution = (await import('../lib/typert.host.js')).default

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

console.log('contribution:', contribution.package, 'face:', contribution.face)
console.log('invocations:', contribution.invocations.map(i => i.id).join(', '))
console.log('schemas:', contribution.schemas.length)

const ctx = new Context()
const registry = new TypertRegistry(ctx)

// 1. Registration itself validates every strict codec (create() presence).
check('register(contribution) accepts the contribution', () => {
  registry.register(contribution)
})

// 2. Every descriptor's codecs must materialize a schema with parse().
for (const descriptor of contribution.invocations) {
  check(`${descriptor.id} codecs materialize`, () => {
    const codecs = [
      ...descriptor.parameters.map(p => [p.wire, p.codec]),
      ['result', descriptor.result],
    ]
    for (const [label, codec] of codecs) {
      if (codec.mode !== 'strict') throw new Error(`${label}: expected strict codec`)
      if (typeof codec.create !== 'function') throw new Error(`${label}: no create()`)
      const schema = codec.create()
      if (typeof schema.parse !== 'function') throw new Error(`${label}: schema has no parse()`)
    }
  })
}

// 3. The schemas must actually round-trip the payloads the plugin sends.
const byId = new Map(contribution.invocations.map(i => [i.id, i]))
const resultSchemaOf = id => byId.get(id).result.create()
const requestCodecOf = id =>
  byId.get(id).parameters.find(p => p.wire === 'request').codec.create()

check('FileReviewRequest round-trips an undo payload', () => {
  const schema = requestCodecOf('dsh-file-review-tab#fileReview/status')
  const payload = {
    action: 'undo',
    files: [{
      path: 'src/a.ts',
      diffs: [{ path: 'src/a.ts', oldText: 'a\n', newText: 'b\n', oldStart: 1, newStart: 1 }],
    }],
  }
  const parsed = schema.parse(payload)
  if (parsed.files[0].diffs[0].newText !== 'b\n') throw new Error('payload mutated')
})

check('FileReviewRequest rejects a bad action', () => {
  const schema = requestCodecOf('dsh-file-review-tab#fileReview/status')
  let threw = false
  try {
    schema.parse({ action: 'nope', files: [] })
  } catch {
    threw = true
  }
  if (!threw) throw new Error('invalid action was accepted')
})

check('FileReviewResult round-trips every state', () => {
  const schema = resultSchemaOf('dsh-file-review-tab#fileReview/apply')
  const states = ['applied', 'undone', 'conflict', 'unsupported', 'error']
  schema.parse({ files: states.map(state => ({ path: 'x', state, changed: false })) })
})

check('RecordedResult round-trips a mutation', () => {
  const schema = resultSchemaOf('dsh-file-review-tab#fileReview/recorded')
  schema.parse({
    mutations: [{ rootCallId: 'c1', name: 'edit', path: 'a.ts', before: null, after: 'x' }],
  })
})

check('RecordedRequest round-trips rootCallIds', () => {
  const schema = requestCodecOf('dsh-file-review-tab#fileReview/recorded')
  schema.parse({ rootCallIds: ['c1', 'c2'] })
})

check('agent lookup codec accepts a session id string', () => {
  const codec = byId.get('dsh-file-review-tab#fileReview/status')
    .parameters.find(p => p.wire === 'agentId').codec
  codec.create().parse('session-abc')
})

// 4. Control: the pre-migration `schema:` shape must be REJECTED, proving the
//    create() migration fixed a real runtime defect rather than a type nit.
check('control: the old { schema } codec shape is rejected', () => {
  const oldShape = {
    package: 'dsh-file-review-tab-control',
    face: 'host',
    schemas: [],
    invocations: [{
      id: 'dsh-file-review-tab-control#fileReview/status',
      service: 'fileReview',
      namespace: 'fileReview',
      method: 'status',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [{
        name: 'agent',
        wire: 'agentId',
        source: 'lookup',
        lookup: 'agent',
        codec: { mode: 'strict', typeSymbol: 'x#Y', schema: { parse: v => v } },
      }],
      result: { mode: 'src-json' },
    }],
    model: { services: [], events: [], objects: [] },
  }
  let threw = false
  try {
    new TypertRegistry(new Context()).register(oldShape)
  } catch (error) {
    threw = /has no create\(\) factory/.test(error.message)
  }
  if (!threw) throw new Error('the old schema: shape was accepted (migration was cosmetic)')
})

console.log(failures === 0 ? '\nALL TYPERT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
