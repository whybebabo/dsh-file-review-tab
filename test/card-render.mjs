/**
 * Render the turn-tail card and assert the native-Card structure plus the two
 * added buttons.
 *
 * The client bundle is CJS built for the browser, so this test loads it through
 * the same `__ModuleLoader__` shim the browser uses, then renders the exported
 * component with `react-dom/server`. It is the only check that proves the card
 * actually MOUNTS — typecheck and bundle-load checks cannot see a bad hook
 * order, a missing primitive export, or a crash inside the render tree.
 *
 * Run after `pnpm build`:  node test/card-render.mjs
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
  }
}

// The browser resolves platform seeds from the module system's table; node
// cannot load the real primitives package (it imports .css), so stub the atoms
// the card and its hover preview render and let everything else pass through.
const React = require('react')
const SEED = new Set(['@deepseek-ai/dsh-client-ui-primitives'])
const seedStub = {
  FileTypeIcon: ({ path, kind, size }) =>
    React.createElement('span', { 'data-file-type-icon': path ?? kind ?? '', 'data-size': size }),
  HoverCard: ({ anchor, content }) =>
    React.createElement('span', { 'data-hover-card': '' }, anchor, content),
  IconChevronDownOutlineRegular: () => React.createElement('span', { 'data-chevron': 'down' }),
  IconChevronUpOutlineRegular: () => React.createElement('span', { 'data-chevron': 'up' }),
  IconListPenOutlineRegular: () => React.createElement('span', { 'data-icon': 'list-pen' }),
  IconRefreshOutlineRegular: () => React.createElement('span', { 'data-icon': 'refresh' }),
  PathLabel: ({ path }) => React.createElement('span', { 'data-path-label': path }, path),
  Menu: ({ anchor }) => React.createElement('span', { 'data-menu': '' }, anchor),
  Tooltip: ({ children }) => children,
  IconCompareSplitOutlineRegular: () => React.createElement('span', { 'data-icon': 'split' }),
  IconWrapFillRegular: () => React.createElement('span', { 'data-icon': 'wrap' }),
  IconNowrapFillRegular: () => React.createElement('span', { 'data-icon': 'nowrap' }),
  IconInspectOutlineRegular: () => React.createElement('span', { 'data-icon': 'inspect' }),
  // The native comparison surface highlights through the shared lazy
  // highlighter. Absent grammar load → plain-text fallback, which is exactly a
  // real first paint before a grammar arrives.
  languageForPath: () => undefined,
  useCodeHighlighter: () => () => undefined,
}
const browserRequire = (spec) => SEED.has(spec) ? seedStub : require(spec)

// The CJS wrapper hands this registration to the page loader as
// `{ id, factory: (require) => exports }`; running the factory IS the load.
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) { loaded = { id, exports: factory(browserRequire) } },
  },
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
}
new Function('require', 'module', 'exports', readFileSync(file, 'utf8'))(
  browserRequire,
  { exports: {} },
  {},
)

const { renderToStaticMarkup } = require('react-dom/server')

// `lib/client.js` exports only the plugin's `apply`/`inject` — the card is not
// a public export. Drive the real registration path instead: a fake ctx records
// the component the turnTail entry registers, which also proves `apply()` wires
// the slot the way this test assumes.
let registered = null
const noopEffect = (fn) => { try { fn() } catch { /* unused registrations */ } }
const fakeCtx = {
  effect: noopEffect,
  provide: () => {},
  get: () => undefined,
  locale: {
    bind: () => (key, params) => t(key, params),
    register: () => () => {},
  },
  remote: { $mount: () => Promise.resolve(() => {}) },
  uiConversation: { events: { register: () => () => {} } },
  slots: {
    inject: (_name, fn) => noopEffect(fn),
    register: (options, component) => { registered = { options, component }; return () => {} },
  },
  betterSidebar: undefined,
}

check('apply() registers the turnTail entry with a component', () => {
  loaded.exports.apply(fakeCtx)
  if (registered === null) throw new Error('slots.register was never called')
  if (registered.options?.name !== 'conversation.chat.turnTail') {
    throw new Error(`registered ${JSON.stringify(registered.options?.name)}`)
  }
  if (registered.options?.id !== 'dsh-file-review-tab') {
    throw new Error(`registered id ${JSON.stringify(registered.options?.id)}`)
  }
  if (typeof registered.component !== 'function') throw new Error('component is not a function')
})

const ProducedFiles = registered.component

const t = (key, params) => {
  const dict = {
    'produced.editedOne': `Edited ${params?.name ?? ''}`,
    'produced.edited': `Edited ${params?.count ?? ''} files`,
    'produced.deletedOne': 'Deleted 1 file',
    'produced.deletedAll': `Deleted ${params?.count ?? ''} files`,
    'produced.previewHint': 'Preview in sidebar',
    'produced.viewDiff': `View changes to ${params?.name ?? ''}`,
    'produced.openReview': 'Open changes',
    'produced.toggleUnavailable': 'Unavailable',
    'produced.all': `All ${params?.count ?? ''} files`,
    'produced.collapse': 'Collapse',
    'produced.expandAria': 'Show all',
    'produced.collapseAria': 'Collapse all',
    'produced.undo': 'Undo',
    'produced.redo': 'Reapply',
    'produced.undoing': 'Undoing',
    'produced.redoing': 'Reapplying',
    'produced.deleted': 'deleted',
    'produced.noticeClose': 'Close',
    'produced.noticeDismiss': 'Dismiss',
    'produced.skippedFiles': 'Skipped',
    'produced.open': `Open ${params?.name ?? ''}`,
    'review.title': 'Review',
    'review.stats': `${params?.added ?? 0} added`,
    'review.copy': 'Copy',
    'review.copied': 'Copied',
    'review.showUnchanged': 'Show',
    'review.hideUnchanged': 'Hide',
    'diff.created': 'Created in this turn',
    'diff.deleted': 'Deleted in this turn',
    'diff.unchanged': 'Unchanged',
    'diff.truncated': 'Truncated',
    'diff.loading': 'Loading',
    'diff.missing': 'Missing',
  }
  return dict[key] ?? key
}

const review = (path, added, removed) => ({
  path,
  diffs: [{
    path,
    oldText: 'a\nb\nc',
    newText: `a\nb\nc\n${Array.from({ length: added }, (_, i) => `+new${i}`).join('\n')}`,
    oldStart: 1,
    newStart: 1,
  }],
})

// TurnLocation.data is a ConversationLocationDataStore keyed by Turn-data kind;
// only `get('deliverables')` is read by the claim test.
const turnOwner = (produced) => ({
  turn: {
    turn: 3,
    start: undefined,
    end: undefined,
    status: 'closed',
    steps: [],
    data: { get: (kind) => kind === 'deliverables' ? { produced } : undefined },
  },
  seq: 9,
  openFile: () => {},
})

const baseProps = {
  t,
  projectRoot: 'C:\\work',
}

// Entries carry the settlement seq the closing boundary filters on.
const entry = (path, diffs, seq = 1) => ({ seq, path, diffs })

const render = (produced) => renderToStaticMarkup(
  React.createElement(ProducedFiles, { ...baseProps, ...turnOwner(produced) }),
)

// A turn with no produced files must render nothing: the list slot has no
// chain selector to decline with, so the component's own claim test is the
// only thing keeping an empty card out of every turn.
check('renders null for a turn that produced no files', () => {
  const html = render([])
  if (html !== '') throw new Error(`expected empty output, got ${html.slice(0, 120)}`)
})

const single = [entry('src/one.ts', review('src/one.ts', 2, 1).diffs)]

check('single file renders the header with the file-type tile', () => {
  const html = render(single)
  for (const needle of [
    'data-changed-files',
    'data-file-type-icon="src/one.ts"', // a real path, not a generic kind
    'Edited one.ts',
  ]) {
    if (!html.includes(needle)) throw new Error(`missing ${needle} in ${html.slice(0, 400)}`)
  }
})

check('single file adds exactly the two header buttons', () => {
  const html = render(single)
  if (!html.includes('>Undo<')) throw new Error('undo button missing')
  if (!html.includes('>Review<')) throw new Error('review button missing')
  if (!html.includes('data-icon="refresh"')) throw new Error('undo icon missing')
  if (!html.includes('data-icon="list-pen"')) throw new Error('review icon missing')
})

check('single file renders no list and no fold', () => {
  const html = render(single)
  // One file is header-only, exactly like the built-in card.
  if (html.includes('<ul')) throw new Error('single-file card rendered a file list')
  if (html.includes('Collapse')) throw new Error('single-file card rendered a fold control')
})

check('single deleted file keeps its deletion title, badge and preview note', () => {
  const html = render([{ ...entry('src/gone.ts', []), deleted: true }])
  for (const needle of ['Deleted 1 file', '>deleted</span>', 'Deleted in this turn']) {
    if (!html.includes(needle)) throw new Error(`missing ${needle} in ${html.slice(0, 800)}`)
  }
  if (html.includes('>+0</span>') || html.includes('>-0</span>')) {
    throw new Error('deleted-only card still renders meaningless +0/-0 counts')
  }
})

check('empty file creation is identified as created in the preview', () => {
  const path = 'src/empty.ts'
  // The creation fact rides the explicit `created` flag, which is what the
  // engine's `meta.diffs` decode sets for a null old side. A null old side
  // ALONE is not a creation — `write` overwrites, `str_replace_editor insert`
  // and an `edit` with an empty old_string also produce one.
  const html = render([entry(path, [{ path, oldText: null, newText: '', created: true }])])
  if (!html.includes('Created in this turn')) throw new Error('empty creation lost its created note')
  if (html.includes('>Unchanged</p>')) throw new Error('empty creation was labeled unchanged')
})

check('a null old side with no creation flag is not labeled created', () => {
  // The regression guard for the label above: an overwrite whose prior content
  // is unknown (no meta.diffs) must not claim the file is new.
  const path = 'src/existing.ts'
  const html = render([entry(path, [{ path, oldText: null, newText: 'replaced\n' }])])
  if (html.includes('Created in this turn')) {
    throw new Error('an unprovenanced null old side was labeled created')
  }
})

const many = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']
  .map((p, i) => entry(p, review(p, 1, 0).diffs, i + 1))

check('multi-file card uses the generic code glyph and folds at 4 rows', () => {
  const html = render(many)
  if (!html.includes('data-file-type-icon="code"')) throw new Error('missing generic code tile')
  if (!html.includes('Edited 6 files')) throw new Error('missing file count title')
  const rows = (html.match(/data-hover-card/g) ?? []).length
  if (rows !== 4) throw new Error(`expected exactly 4 hover-wrapped rows, saw ${rows}`)
  // Fold shows "All 6 files" while collapsed; rows e/f stay hidden.
  if (!html.includes('All 6 files')) throw new Error('missing fold label')
  if (html.includes('>f.ts<')) throw new Error('collapsed card rendered row f.ts')
})

check('fold keeps the visible rows addressable by path', () => {
  const html = render(many)
  // Rows are the deep-link surface; each must name its own path.
  if (!html.includes('>a.ts<') || !html.includes('>d.ts<')) {
    throw new Error('visible rows missing their paths')
  }
})

// Invalid HTML nesting is a real hazard here: the card's main surface is itself
// a <button>, and the two action buttons sit beside it in the same bar, so a
// stray wrapper could nest them. Browsers silently break a nested button,
// making the outer one's click swallow the inner one.
check('never nests a button inside another button', () => {
  for (const produced of [single, many]) {
    const html = render(produced)
    let depth = 0
    for (const tag of html.match(/<button\b|<\/button>/g) ?? []) {
      if (tag === '</button>') depth -= 1
      else {
        depth += 1
        if (depth > 1) throw new Error(`nested button depth ${depth}`)
      }
    }
  }
})

console.log(failures === 0 ? '\nALL CARD RENDER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
