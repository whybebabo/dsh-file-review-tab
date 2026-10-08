/**
 * Render the sidebar review tab and assert its header matches dsh's own
 * ReviewTab structure.
 *
 * The tab is not a public export of the bundle, so this drives the real
 * `apply(fakeCtx)` path and captures the component `registerTab` receives —
 * the same route `card-render.mjs` uses for the turn-tail card. Rendering it
 * with `react-dom/server` is the only check that proves the tab MOUNTS: a bad
 * hook order, a missing primitive export or a crash inside the comparison tree
 * are all invisible to typecheck and to the bundle-load checks.
 *
 * Run after `pnpm build`:  node test/tab-render.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] ?? resolve(here, '../lib/client.js')

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${name}\n        ${error?.message ?? error}`)
    if (process.env.DBG === '1' && error?.stack !== undefined) {
      console.log(error.stack.split('\n').slice(1, 12).join('\n'))
    }
  }
}

const React = require('react')

// The tab reads its Conversation snapshot through useSyncExternalStore with the
// browser's two-argument form; a browser has no server pass, so no server
// snapshot is needed there. `react-dom/server` insists on a third argument, so
// supply the same reader as the server snapshot — the render is then synchronous
// and the markup identical to what the browser paints on mount.
const realUseSyncExternalStore = React.useSyncExternalStore
React.useSyncExternalStore = (subscribe, getSnapshot, getServerSnapshot) =>
  realUseSyncExternalStore(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot)

// The page resolves platform seeds from the module system's table; node cannot
// load the real primitives package (it imports .css), so stub the atoms the tab
// renders and let everything else pass through.
const SEED = new Set(['@deepseek-ai/dsh-client-ui-primitives'])
const seedStub = {
  PathLabel: ({ path }) => React.createElement('span', { 'data-path-label': path }, path),
  Menu: ({ anchor, items, onSelect, selectedId }) =>
    React.createElement('span', { 'data-menu': '', 'data-selected': selectedId },
      anchor,
      React.createElement('span', { 'data-menu-items': String((items ?? []).length) })),
  // Surface delayMs so the 500ms tooltip delay is assertable.
  Tooltip: ({ children, label, delayMs }) =>
    React.createElement('span', { 'data-tooltip': String(label), 'data-delay': String(delayMs) }, children),
  IconChevronDownOutlineRegular: () => React.createElement('span', { 'data-icon': 'chevron-down' }),
  IconCompareSplitOutlineRegular: () => React.createElement('span', { 'data-icon': 'compare' }),
  IconWrapFillRegular: () => React.createElement('span', { 'data-icon': 'wrap' }),
  IconNowrapFillRegular: () => React.createElement('span', { 'data-icon': 'nowrap' }),
  IconRefreshOutlineRegular: () => React.createElement('span', { 'data-icon': 'refresh' }),
  IconInspectOutlineRegular: () => React.createElement('span', { 'data-icon': 'inspect' }),
  languageForPath: () => undefined,
  useCodeHighlighter: () => () => undefined,
}
const browserRequire = (spec) => SEED.has(spec) ? seedStub : require(spec)

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) { loaded = { id, exports: factory(browserRequire) } },
  },
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
  setInterval: globalThis.setInterval,
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    store: new Map(),
    getItem(key) { return this.store.get(key) ?? null },
    setItem(key, value) { this.store.set(key, String(value)) },
    removeItem(key) { this.store.delete(key) },
  },
}
// `navigator` is a getter-only global on modern node, so redefine it.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'en', clipboard: { writeText: async () => {} } },
})
new Function('require', 'module', 'exports', readFileSync(file, 'utf8'))(
  browserRequire,
  { exports: {} },
  {},
)

const { renderToStaticMarkup } = require('react-dom/server')

// Drive the real apply() and capture the tab descriptor it registers.
let descriptor = null
const localeRegistrations = []
const fakeCtx = new Proxy({
  effect(callback) { callback() },
  get: () => undefined,
  betterSidebar: {
    registerTab(value) { descriptor = value; return () => {} },
    openTab() {},
    openFile() {},
  },
  slots: {
    register() { return () => {} },
    inject() { return () => {} },
  },
  locale: {
    getSnapshot: () => ({ active: 'zh' }),
    register(ns, locale, dict) {
      localeRegistrations.push({ ns, locale, dict })
      return () => {}
    },
    // `bind(ns)` returns a namespace-bound translate. The real one reads the
    // active dictionary; the harness only needs it to be callable.
    bind: () => (key) => String(key),
  },
  uiConversation: { events: { register() { return () => {} } } },
  remote: { $mount: async () => () => {} },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) }, scope: () => undefined },
  // `provide` is how apply() publishes the prose-mention face; the real one
  // returns a disposer.
  provide() { return () => {} },
  logger: { info() {}, warn() {}, error() {} },
  on() {},
  inject() {},
}, {
  get(target, property) {
    if (property in target) return target[property]
    // Any other service face: an absent-service shape the tab tolerates.
    return undefined
  },
})

try {
  loaded.exports.apply(fakeCtx)
} catch (error) {
  console.log(`FATAL: apply() threw: ${error?.message ?? error}`)
  process.exit(1)
}

check('apply() registers a better-sidebar tab descriptor', () => {
  if (descriptor === null) throw new Error('no tab was registered')
  if (descriptor.id !== 'file-review') throw new Error(`id: ${descriptor.id}`)
  if (typeof descriptor.component !== 'function') throw new Error('component is not a function')
})

/**
 * Extract just the header element from the rendered markup.
 *
 * Class names here are the REAL ones from the built bundle, so they are hashed
 * (`r1eXuW_header`) and change every build — the harness cannot slice on a
 * literal like `css_body` without silently matching nothing and falling back to
 * the whole document. That fallback is dangerous: the per-turn rows below the
 * header also render `+1`/`-1`, so a whole-document assertion passes even when
 * the header's own counts are gone. This walks the div nesting from the header's
 * opening tag to its matching close, so the slice is the header and nothing else.
 */
const headerOf = (html) => {
  const at = html.search(/<div class="[^"]*_header"/)
  if (at === -1) return html
  const tags = /<div\b[^>]*>|<\/div>/g
  tags.lastIndex = at
  let depth = 0
  let match
  while ((match = tags.exec(html)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1
      if (depth === 0) return html.slice(at, match.index + match[0].length)
    } else {
      depth += 1
    }
  }
  return html.slice(at)
}

/**
 * The whole `<button>` element carrying one `data-review-tool` marker.
 *
 * Slicing from the marker back to the nearest `<button` only yields the
 * attributes that happen to precede it. Attribute order in the rendered markup
 * follows JSX source order, so `data-review-tool` (written after `disabled` and
 * `aria-label` in some branches, before them in others) silently decides which
 * assertions can see what. This returns the complete element instead.
 */
const buttonOf = (html, tool) => {
  const marker = `data-review-tool="${tool}"`
  const at = html.indexOf(marker)
  if (at === -1) return null
  const open = html.lastIndexOf('<button', at)
  if (open === -1) return null
  const close = html.indexOf('</button>', at)
  return html.slice(open, close === -1 ? undefined : close + '</button>'.length)
}


/** Mount the tab against an arbitrary conversation snapshot. */
const renderNodes = (nodes, extra = {}) => {
  const component = descriptor.component
  const snapshot = {
    nodes,
    turnEnds: new Map(nodes.map((_node, index) => [index + 1, index + 1])),
    partial: null,
    runningCalls: [],
  }
  const ctx = new Proxy({
    sessions: { scope: () => undefined },
    get: (name) => (name === 'uiConversation'
      ? { binding: () => ({ snapshot: { getSnapshot: () => snapshot, subscribe: () => () => {} } }) }
      : undefined),
    betterSidebar: { openFile() {}, openTab() {} },
  }, { get: (target, property) => target[property] })

  return renderToStaticMarkup(React.createElement(component, {
    ctx,
    // better-sidebar hands the component a scope; the tab destructures
    // sessionId/cwd out of it.
    scope: { sessionId: 'session-1', cwd: '/repo' },
    visible: true,
    tab: {},
    ...extra,
  }))
}

const render = (files, extra = {}) => {
  // Build the snapshot shape deriveSessionChanges actually walks: a chat legacy
  // slice holding settled tool-result nodes whose call head is an `edit`, plus
  // the turnEnds map that attributes each node's seq to a turn.
  const nodes = files.map((entry, index) => ({
    kind: 'tool-result',
    seq: index + 1,
    isError: false,
    // A real ToolResultNode always carries subCalls (Code Mode nests there),
    // plus the callId deriveSessionRoots reads.
    subCalls: [],
    callId: `call-${index + 1}`,
    call: {
      name: 'edit',
      argsRaw: JSON.stringify({
        file_path: entry.path,
        old_string: entry.oldText,
        new_string: entry.newText,
      }),
    },
    meta: {
      diffs: [{
        path: entry.path,
        oldText: entry.oldText,
        newText: entry.newText,
        oldStart: 1,
        newStart: 1,
      }],
    },
  }))
  return renderNodes(nodes, extra)
}

/**
 * A turn whose only change is a terminal deletion: `flat` is non-empty (the row
 * still renders with its own explanation) but nothing is inspectable.
 */
const deletionOnlyNodes = () => [{
  kind: 'tool-result',
  seq: 1,
  isError: false,
  subCalls: [],
  callId: 'call-1',
  call: { name: 'bash', argsRaw: JSON.stringify({ command: 'rm gone.txt' }) },
  meta: {},
}]

/**
 * A Code Mode `run_code` root whose nested facts did NOT survive into the
 * snapshot: `deriveSessionRoots` keeps it (no nested diffs), and its subCalls
 * yield no changes — so the derived `flat` is empty and the only source of
 * changes is the Host recorder's `recorded` fetch.
 */
const rootsOnlyNodes = () => [{
  kind: 'tool-result',
  seq: 1,
  isError: false,
  callId: 'call-1',
  call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'write(...)' }) },
  meta: {},
  subCalls: [{
    kind: 'tool-result',
    seq: 2,
    isError: false,
    subCalls: [],
    callId: 'call-2',
    // An unknown nested tool: conservative vocabulary yields no change, which is
    // exactly the "nested facts did not survive" shape.
    call: { name: 'unknown_tool', argsRaw: JSON.stringify({}) },
    meta: {},
  }],
}]


// A session that changed nothing: the tab must still mount, with its header.
check('renders without throwing when the session changed nothing', () => {
  const html = render([])
  if (!html.includes('data-file-review-tab')) throw new Error('no tab root rendered')
})

check('tab root mirrors the native review surface attributes', () => {
  const html = render([])
  if (!html.includes('data-changes-review')) throw new Error('missing data-changes-review')
})

check('header is the native 38px comparison bar with the tool row', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  // Native semantics: the selector trigger carries aria-haspopup, and the tool
  // row is keyed by data-review-tool.
  if (!html.includes('aria-haspopup="menu"')) throw new Error('no file selector trigger')
  for (const tool of ['split', 'wrap']) {
    if (!html.includes(`data-review-tool="${tool}"`)) throw new Error(`missing tool: ${tool}`)
  }
})

check('the selector is a PathLabel with the native chevron affordance', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  // The path must be drawn by the shared PathLabel atom, not a plain string:
  // that atom is what gives the label its path-aware styling app-wide.
  if (!html.includes('data-path-label="src/one.ts"')) throw new Error('path is not a PathLabel')
  if (!html.includes('data-icon="chevron-down"')) throw new Error('no chevron on the selector')
  if (!html.includes('data-review-file="src/one.ts"')) throw new Error('selector is not keyed by file')
})

check('the header carries the selected file +N/-N counts', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  if (!html.includes('data-menu-items="1"')) throw new Error('the selector got no menu items')
  // Scope to the HEADER element: the same +N/-N strings also appear in the
  // per-turn stats rows below, so a whole-document assertion would pass even
  // with the header counts removed entirely.
  const header = headerOf(html)
  for (const count of ['+1', '-1']) {
    if (!header.includes(`>${count}</span>`)) throw new Error(`header is missing count ${count}`)
  }
})

check('every header tool is a 500ms tooltip', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  const delays = [...html.matchAll(/data-delay="(\d+)"/g)].map(m => m[1])
  // split + wrap + refresh. The view toggles are native's; refresh is the one
  // control native's bar has no equivalent for, because native's comparison
  // header belongs to the review tab itself rather than an extension point.
  if (delays.length !== 3) throw new Error(`expected 3 header tooltips, got ${delays.length}`)
  for (const delay of delays) {
    if (delay !== '500') throw new Error(`a tooltip uses ${delay}ms, native uses 500ms`)
  }
})

check('the split and wrap tools are pressed-state toggles', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  for (const tool of ['split', 'wrap']) {
    const tag = buttonOf(html, tool)
    if (tag === null) throw new Error(`no ${tool} tool in the header`)
    if (!tag.includes('aria-pressed')) throw new Error(`${tool} has no aria-pressed`)
  }
})

check('the header tool row is split, wrap and refresh', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  const header = headerOf(html)
  const tools = [...header.matchAll(/data-review-tool="([\w-]+)"/g)].map(m => m[1])
  // Split and wrap (native's two view toggles) then refresh, which re-checks
  // every row's Host-side undo state. Any other entry is the regression this
  // guards: this plugin's per-file capabilities live in the body instead.
  const expected = ['split', 'wrap', 'refresh']
  if (tools.join(',') !== expected.join(',')) {
    throw new Error(`header tools are [${tools.join(', ')}], expected [${expected.join(', ')}]`)
  }
})

check('the refresh tool is a labelled, tooltipped header button', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  const tag = buttonOf(html, 'refresh')
  if (tag === null) throw new Error('no refresh tool in the header')
  // An icon-only control must carry its own accessible name.
  if (!tag.includes('aria-label=')) throw new Error('the refresh tool has no aria-label')
  // And a tooltip, so the glyph is explained on hover like native's tools. The
  // tooltip wraps the button, so look at its opening tag just before.
  const at = html.indexOf('data-review-tool="refresh"')
  const tip = html.slice(Math.max(0, html.lastIndexOf('data-tooltip=', at)), at)
  if (!tip.includes('data-tooltip=')) throw new Error('the refresh tool has no tooltip')
})

check('the refresh tool is enabled only when there is state to re-check', () => {
  // With nothing to inspect the control is inert; with changes it is pressable.
  // (The in-flight half of the condition needs a pending Host round-trip, which
  // server rendering cannot produce — no effect runs, so the pending flags stay
  // at their initial false.)
  const empty = render([])
  const emptyTag = buttonOf(empty, 'refresh')
  if (emptyTag === null) throw new Error('the refresh tool vanished with an empty session')
  if (!emptyTag.includes('disabled')) {
    throw new Error('refresh is pressable with nothing to re-check')
  }
  const busyTag = buttonOf(render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }]), 'refresh')
  if (busyTag.includes('disabled')) {
    throw new Error('refresh is inert while there are changes to re-check')
  }
})

check('a roots-only session can still be refreshed', () => {
  // A Code Mode session whose nested changes live only on the Host recorder has
  // roots but an EMPTY derived `flat` until the `recorded` fetch lands. That
  // first fetch is the one that can fail, so gating the tool on `flat` would
  // disable it exactly when it is the only way to retry — the user could not
  // recover while the window kept focus.
  const html = renderNodes(rootsOnlyNodes())
  const tag = buttonOf(html, 'refresh')
  if (tag === null) throw new Error('the refresh tool vanished in a roots-only session')
  if (tag.includes('disabled')) {
    throw new Error('refresh is disabled in a roots-only session, so a failed fetch cannot be retried')
  }
})

check('a deletion-only session offers no pointless refresh', () => {
  // Every row is a deleted file: `flat` is non-empty (the rows render with their
  // own explanation) but nothing is inspectable, so a refresh would issue a
  // status request with an empty file list and change nothing.
  const html = renderNodes(deletionOnlyNodes())
  const tag = buttonOf(html, 'refresh')
  if (tag === null) throw new Error('the refresh tool vanished in a deletion-only session')
  if (!tag.includes('disabled')) {
    throw new Error('refresh is pressable when nothing is inspectable')
  }
})

check('the open-in-sidebar control is gone from the header but kept per file row', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  const header = headerOf(html)
  if (header.includes('data-review-tool="open-file"')) {
    throw new Error('the open-file tool is still in the header')
  }
  // Its capability must survive: every file row keeps its editor button. Slice
  // the body as everything after the header element (class names are hashed per
  // build, so the boundary has to come from headerOf, not a literal).
  const body = html.slice(html.indexOf(header) + header.length)
  const LABEL = '\u5728\u7f16\u8f91\u5668\u4e2d\u6253\u5f00'
  if (!body.includes(LABEL)) {
    throw new Error('the per-file open-in-editor control is missing from the body')
  }
})

check('the header selector lists only the latest turn\'s files', () => {
  // Two turns, one file each. Native's review tab is per-turn, so the header's
  // selector must offer the newest turn's file and NOT the older turn's.
  const html = render([
    { path: 'src/first.ts', oldText: 'a\n', newText: 'b\n' },
    { path: 'src/second.ts', oldText: 'c\n', newText: 'd\n' },
  ])
  const header = headerOf(html)
  if (!header.includes('data-review-file="src/second.ts"')) {
    throw new Error('the newest turn\'s file is not selected in the header')
  }
  if (header.includes('src/first.ts')) {
    throw new Error('the header still offers an older turn\'s file')
  }
  if (!header.includes('data-menu-items="1"')) {
    const items = /data-menu-items="(\d+)"/.exec(header)?.[1]
    throw new Error(`the selector offers ${items} files; the latest turn has 1`)
  }
})

check('older turns remain in the body even though the header is latest-turn only', () => {
  // The header is a per-turn view; the body is still the whole-session list.
  const html = render([
    { path: 'src/first.ts', oldText: 'a\n', newText: 'b\n' },
    { path: 'src/second.ts', oldText: 'c\n', newText: 'd\n' },
  ])
  for (const path of ['first.ts', 'second.ts']) {
    if (!html.includes(path)) throw new Error(`${path} is missing from the body`)
  }
})

check('undo/reapply is not in the header, and stays available in the body', () => {
  // The capability must survive its removal from the chrome: each turn group and
  // each file row keeps its own toggle.
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  const header = headerOf(html)
  if (header.includes('data-review-tool="toggle"')) {
    throw new Error('the undo toggle is still in the header')
  }
  // The body's per-turn and per-file undo buttons remain.
  const body = html.slice(header.length === 0 ? 0 : html.indexOf(header) + header.length)
  const undos = [...body.matchAll(/>([^<]*)\u64a4\u9500[^<]*</g)]
  if (undos.length < 2) throw new Error(`expected per-turn and per-file undo in the body, found ${undos.length}`)
})

check('never nests a button inside another button', () => {
  const html = render([{ path: 'src/one.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }])
  let depth = 0
  for (const tag of html.match(/<button\b|<\/button>/g) ?? []) {
    if (tag === '</button>') depth -= 1
    else {
      depth += 1
      if (depth > 1) throw new Error(`nested button depth ${depth}`)
    }
  }
})

console.log(failures === 0 ? '\nALL TAB RENDER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
