export interface Options {
  command?: string
  timeoutMs?: number
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

// Auto-detect table: first extension match wins; its list is tried in order.
const AUTO: Array<[RegExp, string[]]> = [
  [/\.(ts|tsx|js|jsx|mjs|cjs)$/i, ['npx --no-install eslint {file}', 'npx --no-install prettier --check {file}']],
  [/\.py$/i, ['ruff check {file}']],
  // gofmt -l exits 0 even when it lists unformatted files; wrap so an unformatted file exits nonzero and prints the diff.
  [/\.go$/i, ['[ -z "$(gofmt -l {file})" ] || { gofmt -d {file}; exit 1; }']],
]

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Pure: file + options -> ordered shell commands to try (first non-absent wins). [] = run nothing.
export function resolveLinter(file: string, options: Options): string[] {
  const q = shellQuote(file)
  const sub = (tpl: string) => tpl.replace(/\{file\}/g, () => q)
  const configured = (options?.command ?? '').trim()
  if (configured) return [sub(configured)]
  for (const [re, tpls] of AUTO) if (re.test(file)) return tpls.map(sub)
  return []
}

// Pure: did the command fail because the tool isn't installed, rather than finding issues?
// ponytail: string-match heuristic for npx/npm "no local binary" exit (code 1, wording is
// version-dependent); upgrade to an explicit $.fs.exists / `command -v` probe if it misfires.
export function looksAbsent(out: RunResult): boolean {
  if (out.exitCode === 127) return true
  return /: command not found|could not determine executable to run/i.test(out.stderr)
}

export function clip(s: string, max = 4000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…(${s.length - max} more chars truncated by fix-on-edit)`
}

export function header(file: string): string {
  return `fix-on-edit: ${file} did not pass lint:\n`
}

// Pure: the set of new-file line numbers a `git diff -U0` touched (the +a,b of each @@ hunk).
export function parseChangedLines(diff: string): Set<number> {
  const set = new Set<number>()
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = parseInt(m[1], 10)
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10)
    for (let i = 0; i < count; i++) set.add(start + i)
  }
  return set
}

// Pure: the 1-based line a linter output line points at, or null when it names none.
// Covers eslint stylish ("  12:5  error"), ruff/gcc ("file:12:5:"), and tsc ("file(12,5)").
export function extractLineNo(line: string): number | null {
  const m = line.match(/^\s*(\d+):\d+/) || line.match(/:(\d+):\d+/) || line.match(/:(\d+):/) || line.match(/\((\d+),\d+\)/)
  return m ? parseInt(m[1], 10) : null
}

// Pure: keep only the diagnostics on lines the edit changed.
// - no line-numbered output at all (prettier, gofmt -d): can't scope -> show it whole.
// - some numbered, none on a changed line: the edit introduced nothing here -> stay silent.
// - otherwise: show just the numbered lines that land on a changed line.
export function scopeOutput(raw: string, changed: Set<number>): { show: boolean; text: string } {
  const lines = raw.split('\n')
  const numbered = lines.filter(l => extractLineNo(l) !== null)
  if (numbered.length === 0) return { show: true, text: raw }
  const inRange = numbered.filter(l => changed.has(extractLineNo(l)!))
  if (inRange.length === 0) return { show: false, text: '' }
  return { show: true, text: inRange.join('\n') }
}

// Pure: append text to whatever shape the tool result takes; unknown shape -> unchanged, never throws.
export function appendToResult(r: unknown, text: string): unknown {
  if (!r || typeof r !== 'object') return r
  const env = r as { result?: unknown }
  const res = env.result
  if (typeof res === 'string') return { ...env, result: `${res}\n\n${text}` }
  if (Array.isArray(res)) return { ...env, result: [...res, { type: 'text', text }] }
  if (res && typeof res === 'object' && Array.isArray((res as { content?: unknown }).content)) {
    const c = res as { content: unknown[] }
    return { ...env, result: { ...c, content: [...c.content, { type: 'text', text }] } }
  }
  return r
}
