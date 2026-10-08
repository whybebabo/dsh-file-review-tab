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
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory(require) }
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

check('bundles only react as an external require', () => {
  const external = [...source.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1])
  const unexpected = [...new Set(external)].filter(name => name !== 'react' && name !== 'react/jsx-runtime')
  if (unexpected.length > 0) throw new Error(`unexpected externals: ${unexpected.join(', ')}`)
})

console.log(failures === 0 ? '\nALL CLIENT BUNDLE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
