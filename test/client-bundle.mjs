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

console.log(failures === 0 ? '\nALL CLIENT BUNDLE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
