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
