/**
 * Render the comparison surface itself and assert it behaves like dsh's own
 * FileDiff.
 *
 * `tab-render.mjs` mounts the sidebar tab, but a tab starts with every file row
 * collapsed, so its diff body only appears after an effect-driven expand — and
 * effects do not run under static rendering. The body's layout rules were
 * therefore the one part of the surface no test touched, even though "honors
 * split/wrap" is exactly what the sidebar has to match.
 *
 * This renders NativeDiff.tsx directly. The source is transpiled with the
 * repo's own TypeScript (no extra dependency) and its relative imports are
 * resolved here, so the test exercises the shipped component rather than a
 * re-implementation of it.
 *
 * Run after `pnpm build`:  node test/diff-render.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const clientDir = resolve(repo, 'src/client')

const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

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

// --- load the component the way the bundler does -------------------------

const transpile = (file) => ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
  fileName: file,
}).outputText

// A CSS module is opaque to this test; every class reads as `css_<name>` so the
// markup can be asserted on semantic class names instead of build hashes. This
// matters: the hashed names change on every build, the semantics do not.
const cssStub = new Proxy({}, { get: (_target, key) => `css_${String(key)}` })
const primitivesStub = {
  languageForPath: () => undefined,
  useCodeHighlighter: () => () => undefined,
}

const modules = new Map()
const evaluate = (code) => {
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(load, mod, mod.exports)
  return mod.exports
}
function load(spec) {
  if (spec.endsWith('.css')) return { __esModule: true, default: cssStub }
  if (spec.includes('ui-primitives')) return primitivesStub
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const name = spec.replace(/^\.\//, '')
    const file = /\.tsx?$/.test(name) ? resolve(clientDir, name) : resolve(clientDir, `${name}.ts`)
    if (!modules.has(file)) modules.set(file, evaluate(transpile(file)))
    return modules.get(file)
  }
  return require(spec)
}

const { NativeDiff } = load('./NativeDiff.tsx')

const LABELS = {
  created: 'created',
  deleted: 'deleted',
  unchanged: 'unchanged',
  truncated: (count) => `truncated at ${count}`,
  loading: 'loading',
  missing: 'missing',
}

/** A two-sided change: a deletion run and an addition run. */
const TWO_SIDED = [{
  oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
  lines: ['-const a = 1', '-const b = 2', '+const a = 10', ' const c = 3'],
}]
/** A pure creation: nothing to pair, which native renders unified regardless. */
const ONE_SIDED = [{
  oldStart: 0, oldLines: 0, newStart: 1, newLines: 2,
  lines: ['+brand new one', '+brand new two'],
}]

const render = (props) => renderToStaticMarkup(
  React.createElement(NativeDiff, { path: 'src/a.ts', split: false, wrap: false, labels: LABELS, ...props }),
)

const viewOf = (html) => /data-review-view="(\w+)"/.exec(html)?.[1]

// --- layout selection ----------------------------------------------------

check('unified view draws one numbered line per row', () => {
  const html = render({ hunks: TWO_SIDED, split: false, wrap: false })
  if (viewOf(html) !== 'unified') throw new Error(`data-review-view: ${viewOf(html)}`)
  if (!html.includes('css_line')) throw new Error('no unified line rows')
  if (html.includes('css_columns')) throw new Error('unified view built the split grid')
  // Both sides are numbered, and each row carries its sign.
  for (const sign of ['+', '-']) {
    if (!html.includes(`>${sign}</span>`)) throw new Error(`missing ${sign} sign`)
  }
})

check('split view builds the two columns', () => {
  const html = render({ hunks: TWO_SIDED, split: true, wrap: false })
  if (viewOf(html) !== 'split') throw new Error(`data-review-view: ${viewOf(html)}`)
  if (!html.includes('css_columns')) throw new Error('no columns grid')
  if (!html.includes('data-diff-side="left"') || !html.includes('data-diff-side="right"')) {
    throw new Error('columns are not addressable per side')
  }
  if (!html.includes('css_column')) throw new Error('no column element')
})

check('wrap=true switches split to wrapped rows instead of columns', () => {
  // Native's rule: `split && !wrap` selects the columns grid; with wrap the
  // side-by-side rows are used so long lines can wrap instead of scroll.
  const html = render({ hunks: TWO_SIDED, split: true, wrap: true })
  if (!html.includes('data-review-wrap')) throw new Error('data-review-wrap is not set')
  if (html.includes('css_columns')) throw new Error('wrap should not use the scrolling columns')
  if (!html.includes('css_splitLine')) throw new Error('wrap should use split rows')
})

check('wrap is omitted (not "false") when off, so the CSS attribute selector misses', () => {
  // `[data-review-wrap]` is a presence selector in the stylesheet; emitting
  // data-review-wrap="false" would match it and wrongly wrap every line.
  const html = render({ hunks: TWO_SIDED, split: false, wrap: false })
  if (html.includes('data-review-wrap')) throw new Error('data-review-wrap is present when wrap is off')
})

check('a one-sided change renders unified even when split was requested', () => {
  // Native suppresses the side-by-side layout when there is nothing to pair,
  // WITHOUT changing the requested mode. The columns would otherwise be half empty.
  const html = render({ hunks: ONE_SIDED, split: true, wrap: false })
  if (viewOf(html) !== 'unified') throw new Error(`data-review-view: ${viewOf(html)}`)
  if (html.includes('css_columns')) throw new Error('one-sided change still built columns')
})

check('a two-sided change keeps the requested split', () => {
  // The guard above must not be so eager that it disables a real two-sided diff.
  const html = render({ hunks: TWO_SIDED, split: true, wrap: false })
  if (viewOf(html) !== 'split') throw new Error(`data-review-view: ${viewOf(html)}`)
})

check('paired rows leave the unmatched side empty', () => {
  // Two deletions against one addition: the second row has no right-hand cell,
  // which the stylesheet fills via --diff-empty-fill.
  const html = render({ hunks: TWO_SIDED, split: true, wrap: false })
  if (!html.includes('css_empty')) throw new Error('no empty cell for the unmatched side')
})

// --- numbering, headers and notes ---------------------------------------

check('hunk banner carries both coordinate ranges', () => {
  const html = render({ hunks: TWO_SIDED })
  if (!html.includes('@@ -1,3 +1,3 @@')) throw new Error('hunk banner is wrong')
  if (!html.includes('data-diff-hunk-header')) throw new Error('hunk header is not addressable')
})

check('line numbers follow each side independently', () => {
  const html = render({ hunks: TWO_SIDED, split: false })
  // old: 1,2 then context 3; new: context 1, then 2,3 for the additions.
  for (const no of ['>1<', '>2<', '>3<']) {
    if (!html.includes(no)) throw new Error(`missing line number ${no}`)
  }
})

check('a pure creation is noted rather than drawn as an edit', () => {
  const html = render({ hunks: ONE_SIDED, note: 'created' })
  if (!html.includes('data-diff-note="metadata"')) throw new Error('no created note')
  if (!html.includes('created')) throw new Error('note text missing')
})

check('an empty creation is noted as empty', () => {
  const html = render({ hunks: [], note: 'created' })
  if (!html.includes('data-diff-note="empty"')) throw new Error('empty creation not noted')
})

check('an unchanged comparison is noted as empty', () => {
  const html = render({ hunks: [], note: 'unchanged' })
  if (!html.includes('data-diff-note="empty"')) throw new Error('unchanged not noted')
})

// --- non-content states --------------------------------------------------

check('loading renders a status line, not hunks', () => {
  const html = render({ hunks: [], status: 'loading' })
  if (!html.includes('role="status"')) throw new Error('loading is not announced')
  if (!html.includes('css_status')) throw new Error('no status element')
  if (html.includes('data-review-view')) throw new Error('loading drew a comparison body')
})

check('missing renders a status line, not hunks', () => {
  const html = render({ hunks: [], status: 'missing' })
  if (!html.includes('css_status')) throw new Error('no status element')
  if (html.includes('data-review-view')) throw new Error('missing drew a comparison body')
})

// --- the render budget ---------------------------------------------------

check('an over-budget comparison truncates and says so', () => {
  // Native renders at most 5000 lines and notes the cut. A test that skipped
  // this would let a huge diff freeze the panel unnoticed.
  const lines = ['-first line']
  for (let at = 0; at < 6000; at += 1) lines.push(`+added line ${at}`)
  const html = render({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 6000, lines }] })
  if (!html.includes('data-diff-truncated')) throw new Error('truncation not marked')
  if (!html.includes('truncated at 5000')) throw new Error('truncation note is not the native cap')
  if (html.includes('added line 5990')) throw new Error('rendered past the line budget')
})

console.log(failures === 0 ? '\nALL DIFF RENDER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
