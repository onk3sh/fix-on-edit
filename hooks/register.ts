import type { Register, EngineInterface } from 'claude-code'
import { resolveLinter, looksAbsent, appendToResult, clip, header, parseChangedLines, scopeOutput, type Options } from './resolve'

// The new-file lines the just-made edit touched, via `git diff -U0`.
// null = can't tell (not a git repo, untracked/new file, or git failed) -> caller shows the whole report.
async function changedLines($: EngineInterface, file: string, timeoutMs: number): Promise<Set<number> | null> {
  const dir = file.slice(0, file.lastIndexOf('/')) || '.'
  try {
    const d = await $.process.run(['git', '-C', dir, 'diff', '-U0', '--no-color', '--', file], { timeoutMs })
    if (d.exitCode !== 0) return null // not a git repo -> git exits nonzero
    const set = parseChangedLines(d.stdout)
    return set.size ? set : null // empty: untracked new file or no diff -> don't scope
  } catch {
    return null
  }
}

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'] as const

export const register: Register = (on, options: Options) => {
  const opts = options ?? {}
  const timeoutMs = opts.timeoutMs ?? 15000

  for (const tool of EDIT_TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const r = await next(e) // 1. let the edit run first — never block it
      const file = (e as { file_path?: unknown }).file_path
      if (typeof file !== 'string' || !file) return r

      for (const cmd of resolveLinter(file, opts)) {
        let out
        try {
          out = await $.process.run(['sh', '-c', cmd], { timeoutMs })
        } catch {
          return r // run failed to spawn/timed out -> swallow, keep the edit
        }
        if (looksAbsent(out)) continue // tool not installed -> try the next candidate
        if (out.exitCode === 0) return r // clean -> invisible
        const raw = out.stdout || out.stderr || ''
        const changed = await changedLines($, file, timeoutMs)
        if (!changed) return appendToResult(r, header(file) + clip(raw)) // can't scope -> whole report
        const scoped = scopeOutput(raw, changed)
        if (!scoped.show) return r // the edit introduced no issues on its own lines -> invisible
        return appendToResult(r, header(file) + clip(scoped.text)) // only the edit's own issues
      }
      return r // nothing ran, or every candidate was absent
    })
  }
}
