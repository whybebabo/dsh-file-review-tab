/**
 * Literal deletion-path extraction from terminal command text (unknown-safe).
 *
 * dsh has no dedicated delete-file tool: agents delete through the Bash/Pwsh
 * terminals, whose `tool/call` arguments carry the raw command line in
 * `command`. There is no filesystem snapshot to consult, so this parser is deliberately
 * conservative — it only reports paths that appear VERBATIM as arguments of a
 * known deletion command:
 *
 * - command substitution (`$(…)`, backticks) or process substitution anywhere
 *   in a segment disqualifies that whole segment;
 * - glob characters (`* ? [`) or variable expansion (`$`) in an argument
 *   disqualify that argument (the affected set cannot be enumerated post
 *   hoc);
 * - shell separators (`&&`, `||`, `|`, `;`, newline) split the line so
 *   `rm a && rm b` reports both while `echo rm x` reports nothing.
 *
 * A reported path is display-only vocabulary: the file is gone, so it carries
 * no diff hunks and no undo. Directories deleted with `rm -r` surface as the
 * directory path itself.
 */

/** Commands whose literal arguments name deleted paths (POSIX + PowerShell aliases). */
const DELETERS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'trash',
  'remove-item', 'ri', 'del', 'rd', 'erase',
])

/** PowerShell parameters whose NEXT argument is the path, not an option value. */
const PATH_PARAMETERS = /^-(path|literalpath)$/i

/**
 * Options whose NEXT token is a VALUE, not a path (`shred -n 3 file` — `3` is an
 * iteration count). Keyed by command, because `-n` means different things to
 * different tools; an option absent here is assumed valueless.
 *
 * Options that carry their value inline (`--iterations=3`) need no entry: they
 * are consumed as a single token.
 */
const VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['shred', new Set(['n', 'iterations', 's', 'size'])],
  ['trash', new Set(['trash-dir'])],
])

/**
 * cmd.exe `/x` switches, per command. `del /q file` deletes `file`, so `/q` is a
 * switch and not a path.
 *
 * The lists are EXACTLY what each cmd builtin defines, because these command
 * names also exist in PowerShell, where `/tmp/x` is an absolute path and not a
 * switch at all. Accepting any `/letters` token would silently swallow such a
 * path (`rd /tmp` is a real deletion in PowerShell); accepting only the real
 * switches keeps both shells correct.
 */
const SLASH_SWITCHES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['del', new Set(['p', 'f', 's', 'q', 'a'])],
  ['erase', new Set(['p', 'f', 's', 'q', 'a'])],
  ['rd', new Set(['s', 'q'])],
  ['rmdir', new Set(['s', 'q'])],
])

/**
 * The option name one `/…` token declares, or null when it is a path.
 *
 * `/a` may carry an attached value (`/a:h`, `/a:-r`), so a `:value` suffix is
 * allowed; the name is what precedes the colon.
 */
function slashSwitchName(command: string, token: string): string | null {
  const match = /^\/([A-Za-z]+)(?::[^\s]*)?$/.exec(token)
  if (match === null) return null
  const name = match[1]!.toLowerCase()
  return SLASH_SWITCHES.get(command)?.has(name) === true ? name : null
}

/**
 * The option name a token declares, lowercased, with the switch prefix and any
 * inline value removed, or null when the token is not an option at all.
 * @param token - One argument.
 * @param command - The command it was passed to.
 * @returns The bare option name, or null for a path.
 */
function optionName(token: string, command: string): string | null {
  if (token.startsWith('-')) {
    return token.replace(/^-+/, '').split('=')[0]!.toLowerCase()
  }
  if (token.startsWith('/')) return slashSwitchName(command, token)
  return null
}

/** Arguments never treated as paths: glob/expansion-bearing or self/parent refs. */
function isPathlike(token: string): boolean {
  if (token === '' || token === '.' || token === '..') return false
  return !/[*?\[\]$]/.test(token)
}

/**
 * Split one command line on shell separators, honoring quotes so a `;` inside
 * a quoted argument does not split.
 */
function splitSegments(command: string): readonly string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]
    if (quote !== null) {
      if (char === '\\') {
        const next = command[at + 1]
        // Only a double-quoted escaped quote matters for segmentation; every
        // other backslash (Windows paths) is literal.
        if (quote === '"' && next === '"') {
          current += char + '"'
          at += 1
          continue
        }
        current += char
        continue
      }
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const two = command.slice(at, at + 2)
    if (two === '&&' || two === '||') {
      segments.push(current)
      current = ''
      at += 1
      continue
    }
    if (char === '|' || char === ';' || char === '\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/**
 * Shell-like tokenization of one segment. Quotes are joined into the token and
 * recorded, because quote boundaries decide whether a comma separates paths.
 *
 * Backslash semantics follow the Windows-relevant reading: inside SINGLE
 * quotes (bash/PowerShell alike) everything is literal, and unquoted
 * backslashes stay literal too (PowerShell paths); only inside DOUBLE quotes
 * does a backslash escape the closing quote or itself (bash). A trailing open
 * quote still yields the tokens gathered so far.
 *
 * Each token is returned as its comma-separated PARTS: PowerShell passes a list
 * as `'a.txt','b.txt'`, which is one whitespace token but two paths. Only an
 * UNQUOTED comma splits, so a comma that is part of a filename survives —
 * `rm 'a,b.txt'` is one path, not two.
 */
function tokenize(segment: string): readonly (readonly string[])[] {
  const tokens: string[][] = []
  let parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  const flushPart = () => {
    // An empty part (leading/trailing/doubled comma) names no path.
    if (current !== '') parts.push(current)
    current = ''
  }
  const flushToken = () => {
    flushPart()
    if (parts.length > 0) tokens.push(parts)
    parts = []
  }
  for (let at = 0; at < segment.length; at += 1) {
    const char = segment[at]
    if (char === undefined) break
    if (quote !== null) {
      if (char === '\\') {
        const next = segment[at + 1]
        if (quote === '"' && (next === '"' || next === '\\')) {
          current += next
          at += 1
          continue
        }
        current += char
        continue
      }
      if (char === quote) {
        quote = null
        continue
      }
      // Quoted: a comma here is literal, part of the filename.
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      flushToken()
      continue
    }
    // Unquoted: PowerShell's list separator, so it ends this path.
    if (char === ',') {
      flushPart()
      continue
    }
    current += char
  }
  flushToken()
  return tokens
}

/**
 * Deletion paths named literally by one terminal command line, in argument
 * order, deduplicated. `undefined`/non-string titles and non-terminal views
 * report nothing.
 */
export function deletedPathsFromCommand(command: string): readonly string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  // PowerShell passes comma-separated lists as separate arguments
  // (`rm 'a.txt','b.txt'`); a comma may also just live in a filename, so each
  // part still passes the same pathlike filter.
  const accept = (raw: string): void => {
    if (!isPathlike(raw) || seen.has(raw)) return
    seen.add(raw)
    paths.push(raw)
  }
  /** Accept every path a token names (a PowerShell list carries several). */
  const acceptAll = (token: readonly string[]): void => {
    for (const part of token) accept(part)
  }
  /**
   * The token's text when it is a single argument, or undefined when it is a
   * comma-separated LIST. Only single-part tokens can be options: an unquoted
   * comma always separated paths, and no option in these commands takes one.
   */
  const optionToken = (token: readonly string[]): string | undefined =>
    token.length === 1 ? token[0] : undefined
  for (const segment of splitSegments(command)) {
    // Command/process substitution: the affected paths are unknowable.
    if (segment.includes('$(') || segment.includes('`') || segment.includes('<(')) continue
    const tokens = tokenize(segment)
    // Leading environment assignments (`FOO=1 rm x`) precede the command.
    let at = 0
    while (at < tokens.length) {
      const head = tokens[at] === undefined ? undefined : optionToken(tokens[at]!)
      if (head === undefined || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) break
      at += 1
    }
    const commandWord = tokens[at] === undefined ? undefined : optionToken(tokens[at]!)
    if (commandWord === undefined) continue
    const basename = commandWord.slice(Math.max(commandWord.lastIndexOf('/'), commandWord.lastIndexOf('\\')) + 1)
    const command = basename.toLowerCase()
    if (!DELETERS.has(command)) continue
    const valueOptions = VALUE_OPTIONS.get(command)
    // POSIX `--` ends option parsing: every later token is an operand, even one
    // that starts with `-` (`rm -- -weird.txt` deletes `-weird.txt`).
    let optionsEnded = false
    for (let index = at + 1; index < tokens.length; index += 1) {
      const parts = tokens[index]
      if (parts === undefined) continue
      const token = optionToken(parts)
      if (optionsEnded || token === undefined) {
        // Either option parsing is over, or this token is a path list.
        acceptAll(parts)
        continue
      }
      if (token === '--') {
        optionsEnded = true
        continue
      }
      // The path is here (`-Path`/`-LiteralPath`), so take the next token.
      if (PATH_PARAMETERS.test(token) && index + 1 < tokens.length) {
        index += 1
        const named = tokens[index]
        if (named !== undefined) acceptAll(named)
        continue
      }
      // PowerShell also accepts the inline form (`-Path:a.txt`), where the path
      // is attached to the parameter name rather than passed as its own token.
      const inlinePath = /^-(?:path|literalpath):(.*)$/i.exec(token)
      if (inlinePath !== null) {
        const named = inlinePath[1]
        if (named !== undefined && named !== '') accept(named)
        continue
      }
      const option = optionName(token, command)
      if (option !== null) {
        // A value-taking option's next token is its VALUE (`-n 3`), never a
        // path — reporting it invented a deletion for a file that still exists.
        // An inline value (`--iterations=3`) is already one token, so only the
        // separated form consumes anything. `-` alone is stdin, not an option.
        const inline = token.includes('=')
        if (!inline && token !== '-' && valueOptions?.has(option) === true) index += 1
        continue
      }
      acceptAll(parts)
    }
  }
  return paths
}
