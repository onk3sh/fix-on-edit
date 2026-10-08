import type { Register } from 'claude-code'
import { resolveLinter, looksAbsent, appendToResult, clip, header, type Options } from './resolve'

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
        return appendToResult(r, header(file) + clip(out.stdout || out.stderr)) // issues -> surface
      }
      return r // nothing ran, or every candidate was absent
    })
  }
}
