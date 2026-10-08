/**
 * Load the plugin's browser bundle as the Web plugin loader would.
 *
 * This catches module-scope crashes (bad imports, top-level API misuse) that a
 * typecheck cannot see, and proves the bundle's declarations match what DSH's
 * `dsh.client` contract expects: an `apply` export and an `inject` list naming
 * the client services it waits for.
 *
 * Run after `pnpm build`:  node test/client-bundle.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] ?? resolve(here, '../lib/client.js')
const source = readFileSync(file, 'utf8')

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

let loaded = null

// The browser resolves these from the module system's platform seed table
// (the shell's staticModules), not from node_modules: in the page,
// @deepseek-ai/dsh-client-ui-primitives is already bundled into the shell, so a
// plugin bundle only ever sees its exports object. Node cannot load it directly
// (it imports .css), and loading the real package would not model the browser
// anyway — so the harness supplies the same stand-in table the loader does.
const SEED = new Set([
  '@deepseek-ai/dsh-client-ui-primitives',
])
const seedStub = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === '__esModule') return true
    // Any atom the card uses renders as an inert element; module-scope
    // evaluation is what this test is checking, not the rendered tree.
    return typeof prop === 'string' && /^[A-Z]/.test(prop)
      ? (props) => ({ $$typeof: Symbol.for('react.element'), type: prop, props })
      : undefined
  },
})
const browserRequire = (spec) => SEED.has(spec) ? seedStub : require(spec)

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory(browserRequire) }
    },
  },
}

check('bundle evaluates without throwing', () => {
  new Function(source)()
})

check('loader received the plugin module id', () => {
  if (loaded === null) throw new Error('loader was never called')
  if (loaded.id !== 'dsh-file-review-tab') throw new Error(`unexpected id ${loaded.id}`)
})

check('exports apply()', () => {
  if (typeof loaded?.exports?.apply !== 'function') {
    throw new Error(`exports: ${Object.keys(loaded?.exports ?? {}).join(', ') || '(none)'}`)
  }
})

check('exports the service inject list', () => {
  const inject = loaded?.exports?.inject
  if (!Array.isArray(inject)) throw new Error(`inject: ${JSON.stringify(inject)}`)
  for (const required of ['betterSidebar', 'sessions', 'locale', 'remote', 'slots', 'uiConversation']) {
    if (!inject.includes(required)) throw new Error(`inject is missing "${required}"`)
  }
})

check('bundles only platform seeds as external requires', () => {
  // The Web module system resolves these from its platform seed table; anything
  // else is a build-time externals drift that would throw at runtime.
  const allowed = new Set([
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
  const external = [...source.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1])
  const unexpected = [...new Set(external)].filter(name => !allowed.has(name))
  if (unexpected.length > 0) throw new Error(`unexpected externals: ${unexpected.join(', ')}`)
})

check('reuses the native primitives card atoms', () => {
  // Reusing these is what makes the card visually identical to the built-in one.
  for (const symbol of ['FileTypeIcon', 'HoverCard', 'IconChevronDownOutlineRegular']) {
    if (!source.includes(symbol)) throw new Error(`bundle does not reference ${symbol}`)
  }
})

check('declares ui-primitives in dsh.client.external', () => {
  const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'))
  const external = pkg.dsh?.client?.external
  if (!Array.isArray(external) || !external.includes('@deepseek-ai/dsh-client-ui-primitives')) {
    throw new Error(`dsh.client.external: ${JSON.stringify(external)}`)
  }
})

check('emits CSS-module classes in sorted order', () => {
  // lightningcss returns its export table in a nondeterministic key order, so
  // the build sorts the keys before emitting. Without that, lib/client.js
  // changes bytes on every build and its artifact rev (derived from file
  // metadata) invalidates the served bundle for no semantic reason. Assert the
  // invariant here so the sort cannot be dropped unnoticed.
  const tables = [...source.matchAll(/= \{\n((?:\t+"[\w$]+": "[\w$]+",?\n)+)\t+\}/g)]
  if (tables.length === 0) throw new Error('no CSS-module export tables found')
  for (const [, body] of tables) {
    const keys = [...body.matchAll(/"([\w$]+)":/g)].map(m => m[1])
    const sorted = [...keys].sort()
    if (keys.join(',') !== sorted.join(',')) {
      throw new Error(`CSS-module keys not sorted: ${keys.join(',')}`)
    }
  }
})

check('the comparison carries the native FileDiff declarations verbatim', () => {
  // Native's FileDiff is what makes a diff look like a diff anywhere in the app.
  // These are the declarations that give it its shape; a drift here is invisible
  // to typecheck and to a render test, but visibly wrong on screen.
  const native = [
    // the two-column grammar and the one-sided collapse
    'grid-template-columns:minmax(0,1fr) minmax(0,1fr)',
    'grid-template-columns:minmax(max-content,100%)',
    // the single-column row grammar (numbers, sign, text)
    'grid-template-columns:3.5em 3.5em 1.2em minmax(0,1fr)',
    // the side-by-side row grammar (number, text)
    'grid-template-columns:3.5em max-content',
    // 22px line rows
    'line-height:22px',
    // the native diff color tokens
    '--dsw-alias-file-diff-added-bg',
    '--dsw-alias-file-diff-deleted-bg',
    '--dsw-alias-file-diff-added-marker',
    // native's empty-cell fill
    '--diff-empty-fill',
    // the wrap mode
    'white-space:pre-wrap',
    'overflow-wrap:anywhere',
  ]
  const missing = native.filter(needle => !source.includes(needle))
  if (missing.length > 0) throw new Error(`missing native declarations: ${missing.join(' | ')}`)
})

check('the refresh tool drives its pending state from both async sources', () => {
  // The CSS above is inert unless the button actually emits the attribute. That
  // cannot be observed by rendering: the pending flags start false and no effect
  // runs under server rendering, so the attribute is always absent there. The
  // compiled binding is the observable fact instead.
  const at = source.indexOf('"data-review-tool": "refresh"')
  if (at === -1) throw new Error('no refresh tool in the bundle')
  const region = source.slice(Math.max(0, at - 500), at + 500)
  if (!/"data-pending":\s*refreshing\s*\?/.test(region)) {
    throw new Error('the refresh tool does not drive data-pending from `refreshing`')
  }
  // `refreshing` must OR both sources: a root-only session is fetching while a
  // status-only one is inspecting, and either is a real in-flight refresh.
  const derived = source.match(/const refreshing\s*=\s*([^;]+);/)
  if (derived === null) throw new Error('no `refreshing` derivation in the bundle')
  if (!/recordedPending/.test(derived[1]) || !/statusPending/.test(derived[1])) {
    throw new Error(`\`refreshing\` ignores a pending source: ${derived[1].trim()}`)
  }
  // And it must gate BOTH the disabled attribute and the click handler's effect.
  if (!/disabled:\s*refreshing\s*\|\|/.test(region)) {
    throw new Error('the refresh tool is not disabled while refreshing')
  }
})

check('a roots-only session keeps the refresh tool pressable', () => {
  // The bug this guards: gating the tool on `flat` alone. A Code Mode session
  // whose nested changes live only on the Host recorder has roots with an EMPTY
  // derived `flat` until the fetch lands, so a `flat` gate disables the tool
  // exactly when it is the only way to retry a failed fetch.
  const derived = source.match(/const canRefresh\s*=\s*([^;]+);/)
  if (derived === null) throw new Error('no `canRefresh` derivation in the bundle')
  if (!/roots/.test(derived[1])) {
    throw new Error(`\`canRefresh\` ignores roots, so a roots-only session cannot retry: ${derived[1].trim()}`)
  }
  // And it must not be gated on `flat`, which is the wrong signal in both
  // directions (empty for roots-only, non-empty for deletion-only).
  if (/\bflat\.length\b/.test(derived[1])) {
    throw new Error(`\`canRefresh\` gates on flat, which is never the right signal: ${derived[1].trim()}`)
  }
})

check('the status inspection gates on inspectable rows, not on flat', () => {
  // Same class of bug inside the effect. A deletion-only turn has
  // `flat.length > 0` with every entry filtered out of `inspectable`, so a
  // `flat` gate sends a status request with an EMPTY file list and then clears
  // every row's state from the empty reply. Effects do not run under server
  // rendering, so the compiled guard is what gets asserted.
  const at = source.indexOf('action: "undo"')
  if (at === -1) throw new Error('no status request in the bundle')
  const effect = source.slice(Math.max(0, at - 1200), at)
  const guard = [...effect.matchAll(/if \(!visible \|\| ([^)]+)\)/g)].at(-1)
  if (guard === undefined) throw new Error('no visibility guard found before the status request')
  if (!/inspectable\.length/.test(guard[1])) {
    throw new Error(`the status effect gates on ${guard[1].trim()}, not on inspectable.length`)
  }
  // The early return must ALSO clear the pending flag. The cleanup function only
  // suppresses the in-flight reply, so an early return that skipped this would
  // strand `statusPending` at true and leave the refresh tool spinning forever.
  if (!/setStatusPending\(false\)/.test(effect.slice(effect.indexOf(guard[0])))) {
    throw new Error('the early return does not clear statusPending, so it can be stranded')
  }
})

check('the recorded fetch clears its pending flag on every exit path', () => {
  // Symmetric to the above for the other async source, including the
  // abandoned-fetch paths (tab hidden, service unavailable).
  const at = source.indexOf('remote.recorded(')
  if (at === -1) throw new Error('no recorded fetch in the bundle')
  const effect = source.slice(Math.max(0, at - 1800), at + 900)
  const clears = [...effect.matchAll(/setRecordedPending\(false\)/g)].length
  if (clears < 3) {
    throw new Error(`the recorded fetch clears its pending flag only ${clears}x; expected the early return, the unavailable-service path and the settled fetch`)
  }
  if (!/\.finally\(/.test(effect)) {
    throw new Error('the recorded fetch has no finally(), so a rejection strands its pending flag')
  }
})

check('the empty-cell fill variable is declared on the element the renderer emits', () => {
  // Native declares `--diff-empty-fill` on FileDiff.root, which its CALLERS
  // apply; FileDiff itself only renders `.body`. This renderer emits `.body`
  // alone, so the variable must be declared there too or every empty split cell
  // loses its fill. Assert it lives on a class this renderer actually renders.
  const bodyDecl = source.match(/\.[\w$]+_body\{[^}]*--diff-empty-fill/)
  if (bodyDecl === null) {
    throw new Error('--diff-empty-fill is not declared on the rendered .body rule')
  }
})

check('the refresh tool has a visible running state and honors reduced motion', () => {
  // A refresh that looks identical while it runs reads as a dead button. Its
  // pending state is only reachable with a live Host round-trip (no effect runs
  // under server rendering), so the declaration itself is what gets asserted.
  // lightningcss minifies AND hashes the keyframes name, so match the suffix.
  const pending = source.match(/\.([\w$]+)_tool\[data-pending\][^{]*\{[^}]*animation:[^;}]*reviewToolSpin/)
  if (pending === null) {
    throw new Error('the pending refresh tool has no spin animation')
  }
  const animation = /animation:[^;}]*?([\w$]+_reviewToolSpin)/.exec(pending[0])
  if (animation === null) throw new Error('the spin animation is not named')
  if (!source.includes(`@keyframes ${animation[1]}{`)) {
    throw new Error(`@keyframes ${animation[1]} is missing`)
  }
  // Accessibility: an animation must be suppressible, and the selector that
  // suppresses it must be the same rule the animation was declared on.
  const reduced = source.match(/prefers-reduced-motion[^{]*\{[^@]*?\.([\w$]+)_tool\[data-pending\][^{]*\{[^}]*animation:\s*none/)
  if (reduced === null) {
    throw new Error('the pending spin ignores prefers-reduced-motion')
  }
  if (reduced[1] !== pending[1]) {
    throw new Error(`reduced-motion override targets ${reduced[1]}, animation is on ${pending[1]}`)
  }
})

console.log(failures === 0 ? '\nALL CLIENT BUNDLE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
