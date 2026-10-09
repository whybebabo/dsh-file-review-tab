/**
 * Verify deletion-path extraction ignores command options.
 *
 * `rm`-family commands carry options whose arguments are NOT paths: `del /q
 * file.txt` deleted `file.txt`, and `shred -n 3 file.txt` shredded it while
 * counting to 3. Reporting `/q` or `3` as deleted files invented review entries
 * for files that still exist and inflated the deletion count.
 *
 * Runs standalone:  node test/deleted-paths.mjs
 */
import { deletedPathsFromCommand } from '../src/client/deleted-paths.ts'

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

/**
 * Assert the exact path list one command reports.
 *
 * Compares with JSON so a comma INSIDE a filename cannot be confused with a
 * list separator: `['a,b.txt']` and `['a', 'b.txt']` both `join(',')` to the
 * same string, which made the quoted-comma checks pass either way.
 */
const expect = (command, wanted) => {
  const got = deletedPathsFromCommand(command)
  if (JSON.stringify(got) !== JSON.stringify(wanted)) {
    throw new Error(`${JSON.stringify(command)} -> ${JSON.stringify(got)}; expected ${JSON.stringify(wanted)}`)
  }
}

check('cmd.exe `/` switches are not paths (the reported P3 case)', () => {
  expect('del /q file.txt', ['file.txt'])
  expect('del /q /f file.txt', ['file.txt'])
  expect('erase /s /q a.txt b.txt', ['a.txt', 'b.txt'])
})

check('a value-taking option does not leak its value (the reported P3 case)', () => {
  expect('shred -n 3 file.txt', ['file.txt'])
  expect('shred -n3 file.txt', ['file.txt'])
  expect('shred --iterations=3 file.txt', ['file.txt'])
})

check('`rd`/`rmdir` switches are handled without eating real paths', () => {
  expect('rd /s /q dir', ['dir'])
  // POSIX rmdir takes no `/x` switch, so a leading `/` is an absolute path.
  expect('rmdir /tmp/x', ['/tmp/x'])
  expect('rmdir /s /q /tmp/x', ['/tmp/x'])
})

check('an attached switch value is consumed with its switch', () => {
  // `/a:h` selects hidden files; `h` is not a path, and the path follows.
  expect('del /a:h hidden.txt', ['hidden.txt'])
  expect('del /a:-r file.txt', ['file.txt'])
})

check('a `/…` token that is NOT a real switch stays a path', () => {
  // These names exist in both shells, so a `/word` token there is an absolute
  // path, not a switch. Swallowing it would hide a genuine deletion.
  expect('rd /tmp', ['/tmp'])
  expect('rd /s /tmp/x', ['/tmp/x'])
  expect('rmdir /somedir', ['/somedir'])
})

check('POSIX `--` ends option parsing', () => {
  expect('rm -- file.txt', ['file.txt'])
  // After `--`, a leading dash is part of the operand, not an option.
  expect('rm -f -- -weird.txt', ['-weird.txt'])
})

check('POSIX options still leave the real path', () => {
  expect('rm -rf src/', ['src/'])
  expect('rm --interactive=never file.txt', ['file.txt'])
  expect('rm -f a.txt b.txt', ['a.txt', 'b.txt'])
})

check('PowerShell named parameters still name their path', () => {
  expect('Remove-Item -Path a.txt -Force', ['a.txt'])
  expect('Remove-Item -LiteralPath b.txt', ['b.txt'])
  // PowerShell's inline form attaches the path to the parameter name.
  expect('Remove-Item -Path:a.txt', ['a.txt'])
  expect('Remove-Item -LiteralPath:b.txt -Force', ['b.txt'])
})

check('a lone `-` (stdin) is not treated as a path', () => {
  expect('rm -', [])
})

check('a QUOTED comma is part of the filename, not a list separator', () => {
  // The reported P2 case. Tokenization removes quote boundaries, so splitting
  // every token on commas invented two paths for one real file.
  expect("rm 'a,b.txt'", ['a,b.txt'])
  expect('rm "a,b.txt"', ['a,b.txt'])
  expect('Remove-Item -Path "a,b.txt"', ['a,b.txt'])
  expect("rm 'a,b,c.txt'", ['a,b,c.txt'])
  // A quoted comma alongside a real list still keeps both shapes right.
  expect("rm 'a,b.txt' c.txt", ['a,b.txt', 'c.txt'])
})

check('an UNQUOTED comma still separates PowerShell list items', () => {
  expect("rm 'a.txt','b.txt'", ['a.txt', 'b.txt'])
  expect('Remove-Item a.txt,b.txt', ['a.txt', 'b.txt'])
  expect('rm a.txt, b.txt', ['a.txt', 'b.txt'])
  // A comma inside a quoted part and a bare separator in the same command.
  expect("rm 'a,b.txt',c.txt", ['a,b.txt', 'c.txt'])
})

check('a comma-separated list is never mistaken for an option', () => {
  // An option is a single argument; a list can only hold paths.
  expect('del /q a.txt,b.txt', ['a.txt', 'b.txt'])
  expect('shred -n 3 a.txt,b.txt', ['a.txt', 'b.txt'])
})

check('empty list parts name no path', () => {
  expect('rm a.txt,,b.txt', ['a.txt', 'b.txt'])
  expect('rm ,a.txt', ['a.txt'])
})

check('separators still split, so each command is parsed on its own', () => {
  expect('del /q a.txt && del /q b.txt', ['a.txt', 'b.txt'])
  expect('shred -n 2 a.txt; rm -f b.txt', ['a.txt', 'b.txt'])
})

check('non-deletion commands report nothing at all', () => {
  expect('echo rm x', [])
  expect('cat file.txt', [])
  expect('ls /q', [])
})

check('glob and expansion arguments stay excluded', () => {
  expect('rm *.txt', [])
  expect('del /q $TARGET', [])
})

console.log(failures === 0 ? '\nALL DELETED PATH CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
