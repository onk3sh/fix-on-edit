# fix-on-edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a Claude Code mod that runs the project's linter on each file Claude edits and feeds any errors back into the tool result so Claude fixes them in the same turn.

**Architecture:** One `tool.call` hook per edit tool (`Edit`, `Write`, `MultiEdit`) that runs *after* the edit (`await next(e)` first), resolves a lint command for the changed file, runs it via `$.process.run`, and appends any failure output to the tool result. All decision logic lives in total (never-throwing) pure functions in `resolve.ts`; the hook is a thin orchestrator whose only I/O (`$.process.run`) is wrapped in try/catch, so the hook cannot throw and cannot break an edit.

**Tech Stack:** TypeScript, Claude Code mods API (v2.1.287+), `claude plugin validate` / `claude plugin test` (test kit `claude-code/testing`).

**Spec:** `docs/superpowers/specs/2026-10-08-fix-on-edit-design.md`

## Global Constraints

- Claude Code **2.1.287 or later** (mods floor). Copy into `plugin.json` only if a `version`/engine field is supported; otherwise state it in the README.
- Mod is **invisible on success**: no toast, no log, never `{ deny }`, never modifies the file. Output is surfaced only when the linter reports a problem.
- The hook must **never break an edit**: `await next(e)` runs first; every path returns either the original result `r` or `appendToResult(r, …)`.
- `$.process.run(argv: string[], { timeoutMs })` resolves to `{ exitCode: number, stdout: string, stderr: string }`. (Spec draft said `out.code` — the real field is `exitCode`. It takes an **argv array**, not a shell string — commands run as `['sh','-c', cmd]`.)
- `register(on, options)` — `options` holds the `userConfig` values with defaults filled in.
- userConfig: `command` (string, default `""`), `timeoutMs` (number, default `15000`).
- Auto-detect is small and fixed: ts/js family → eslint then prettier; `.py` → ruff; `.go` → gofmt; everything else → silent. Node tools via `npx --no-install` (project-local binary, no network).
- Commits to the mod repo (`onk3sh/fix-on-edit`, the user's own) end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. The catalogue PR's attribution is decided in Task 4 after reading that repo's contributing policy (strip the trailer/footer if it bans LLM co-authorship).

## Review Focus

Inputs the spec implies but no happy-path task exercises; each is pinned to the task whose tests cover it:

1. **Linter not installed** (npx has no local eslint/prettier; ruff/gofmt absent): must stay *silent*, not surface "command not found" noise as if it were a lint error. → Task 3, `looksAbsent` fallthrough test.
2. **File path with shell-special characters** (spaces, quotes): must not break the `sh -c` command or allow injection. → Task 2, `shellQuote` test.
3. **Unexpected result shape from `next(e)`** (not a string, not `{content}`, not a block array): `appendToResult` must degrade to returning the result unchanged, never throw. → Task 2, `appendToResult` unknown-shape test.
4. **Huge linter output** (a 10k-line log): must not dump the whole thing into Claude's context. → Task 2, `clip` truncation test.
5. **A second/third edit tool** (`Write`, `MultiEdit`) uses the same `file_path` field: all three must be wired, not just `Edit`. → Task 3, `Write` test (MultiEdit shares the identical registration in the loop).

---

### Task 1: Project scaffold + manifest

Establishes a loadable plugin so later `claude plugin test` runs can load the mod. The `register` stub registers nothing yet; it only has to load cleanly.

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/hooks.json`
- Create: `hooks/register.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a validated plugin dir; `export const register: Register` exists (body filled in Task 3).

- [ ] **Step 1: Write the manifest**

`.claude-plugin/plugin.json`:
```json
{
  "name": "fix-on-edit",
  "version": "0.1.0",
  "description": "Runs your project's linter on each file Claude edits and feeds any errors back so Claude fixes them in the same turn.",
  "author": { "name": "onk3sh" },
  "homepage": "https://github.com/onk3sh/fix-on-edit",
  "keywords": ["claude-code-mod", "lint", "quality"],
  "userConfig": {
    "command": {
      "type": "string",
      "default": "",
      "description": "Lint command with a {file} placeholder, e.g. 'eslint --fix {file}'. Empty = auto-detect by extension."
    },
    "timeoutMs": {
      "type": "number",
      "default": 15000,
      "description": "Timeout in milliseconds for the lint subprocess."
    }
  }
}
```

- [ ] **Step 2: Write the hooks module pointer**

`hooks/hooks.json`:
```json
{ "modules": ["./register.ts"] }
```

- [ ] **Step 3: Write the register stub**

`hooks/register.ts`:
```ts
import type { Register } from 'claude-code'

export const register: Register = (_on, _options) => {
  // hooks wired in Task 3
}
```

- [ ] **Step 4: Validate the plugin loads**

Run: `claude plugin validate .`
Expected: succeeds (manifest + module read, no errors). It is fine if it reports zero events at this stage. If it rejects a `userConfig` field shape, adjust the field to what the error names — `claude plugin validate` is authoritative over the manifest snippet above.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json hooks/hooks.json hooks/register.ts
git commit -m "chore: scaffold fix-on-edit mod (manifest, hooks module, register stub)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure helpers (`resolve.ts`)

All decision logic, isolated and total. TDD.

**Files:**
- Create: `hooks/resolve.ts`
- Test: `hooks/resolve.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exact signatures Task 3 relies on):
  - `interface Options { command?: string; timeoutMs?: number }`
  - `interface RunResult { exitCode: number; stdout: string; stderr: string }`
  - `shellQuote(s: string): string`
  - `resolveLinter(file: string, options: Options): string[]` — ordered shell commands to try (`{file}` already substituted + shell-quoted); `[]` means nothing to run.
  - `looksAbsent(out: RunResult): boolean` — true when the command failed because the tool isn't installed (vs. finding real issues).
  - `appendToResult(r: unknown, text: string): unknown` — append `text` to the tool result; unknown shape → `r` unchanged.
  - `clip(s: string, max?: number): string`
  - `header(file: string): string`

- [ ] **Step 1: Write the failing tests**

`hooks/resolve.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { resolveLinter, shellQuote, looksAbsent, appendToResult, clip } from './resolve'

test('config command wins and substitutes {file}, shell-quoted', () => {
  expect(resolveLinter('/a/b.py', { command: 'mylint {file} --x' }))
    .toEqual([`mylint '/a/b.py' --x`])
})

test('shellQuote escapes an embedded single quote safely', () => {
  expect(shellQuote(`/a/O'Neil.ts`)).toBe(`'/a/O'\\''Neil.ts'`)
})

test('auto-detect yields eslint then prettier for the JS/TS family', () => {
  expect(resolveLinter('/a/x.tsx', {})).toEqual([
    `npx --no-install eslint '/a/x.tsx'`,
    `npx --no-install prettier --check '/a/x.tsx'`,
  ])
})

test('auto-detect maps py and go and skips unknown extensions', () => {
  expect(resolveLinter('/a/x.py', {})).toEqual([`ruff check '/a/x.py'`])
  expect(resolveLinter('/a/x.go', {})).toEqual([`gofmt -l '/a/x.go'`])
  expect(resolveLinter('/a/notes.md', {})).toEqual([])
})

test('looksAbsent flags not-found exits but not real lint failures', () => {
  expect(looksAbsent({ exitCode: 127, stdout: '', stderr: 'sh: eslint: command not found' })).toBe(true)
  expect(looksAbsent({ exitCode: 1, stdout: '', stderr: 'npm error could not determine executable to run' })).toBe(true)
  expect(looksAbsent({ exitCode: 1, stdout: 'x.ts:1:1 error Foo', stderr: '' })).toBe(false)
})

test('appendToResult handles string, block-array, content, and unknown shapes', () => {
  expect(appendToResult({ result: 'a' }, 'b')).toEqual({ result: 'a\n\nb' })
  expect(appendToResult({ result: [{ type: 'text', text: 'a' }] }, 'b'))
    .toEqual({ result: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })
  expect(appendToResult({ result: { content: [{ type: 'text', text: 'a' }] } }, 'b'))
    .toEqual({ result: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } })
  expect(appendToResult({ result: 42 }, 'b')).toEqual({ result: 42 })
})

test('clip truncates long output and marks the cut', () => {
  const long = 'x'.repeat(5000)
  const out = clip(long)
  expect(out.length).toBeLessThan(long.length)
  expect(out).toContain('truncated by fix-on-edit')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `claude plugin test`
Expected: FAIL — `resolve.ts` does not exist / exports undefined.

- [ ] **Step 3: Write the implementation**

`hooks/resolve.ts`:
```ts
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
  [/\.go$/i, ['gofmt -l {file}']],
]

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Pure: file + options -> ordered shell commands to try (first non-absent wins). [] = run nothing.
export function resolveLinter(file: string, options: Options): string[] {
  const q = shellQuote(file)
  const sub = (tpl: string) => tpl.replace(/\{file\}/g, q)
  const configured = (options.command ?? '').trim()
  if (configured) return [sub(configured)]
  for (const [re, tpls] of AUTO) if (re.test(file)) return tpls.map(sub)
  return []
}

// Pure: did the command fail because the tool isn't installed, rather than finding issues?
// ponytail: string-match heuristic for npx/npm "no local binary" exit (code 1, wording is
// version-dependent); upgrade to an explicit $.fs.exists / `command -v` probe if it misfires.
export function looksAbsent(out: RunResult): boolean {
  if (out.exitCode === 127) return true
  const text = `${out.stdout}\n${out.stderr}`
  return /could not determine executable to run|command not found|not found in|no such file or directory/i.test(text)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `claude plugin test`
Expected: PASS (all resolve.test.ts cases).

- [ ] **Step 5: Commit**

```bash
git add hooks/resolve.ts hooks/resolve.test.ts
git commit -m "feat: linter resolution, absence heuristic, and result-append helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The hook (`register.ts`)

Wire the three edit tools to the pure helpers. TDD against the test kit.

**Files:**
- Modify: `hooks/register.ts` (replace the Task 1 stub body)
- Test: `hooks/register.test.ts`

**Interfaces:**
- Consumes (from Task 2): `resolveLinter`, `looksAbsent`, `appendToResult`, `clip`, `header`, `Options`.
- Produces: the loaded mod's behavior — no exported symbols other than `register`.

- [ ] **Step 1: Write the failing tests**

`hooks/register.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'

// Review Focus 1 is the "missing linter" test; Review Focus 5 is the Write test.

test('surfaces linter errors to Claude', async ($, on) => {
  on('tool.call', () => ({ result: 'edit applied' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: 'foo.ts:1:5  error  Unexpected token', stderr: '' } }))
  const out = await $.tool.call({ tool: 'Edit', file_path: '/proj/foo.ts' })
  expect(JSON.stringify(out)).toContain('foo.ts:1:5  error  Unexpected token')
  expect(JSON.stringify(out)).toContain('did not pass lint')
})

test('a clean file is returned unchanged', async ($, on) => {
  on('tool.call', () => ({ result: 'edit applied' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const out = await $.tool.call({ tool: 'Write', file_path: '/proj/clean.py' })
  expect(out).toEqual({ result: 'edit applied' })
})

test('an unsupported extension runs no linter', async ($, on) => {
  on('tool.call', () => ({ result: 'edit applied' }))
  let ran = false
  on('process.run', () => {
    ran = true
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const out = await $.tool.call({ tool: 'Edit', file_path: '/proj/notes.md' })
  expect(out).toEqual({ result: 'edit applied' })
  expect(ran).toBe(false)
})

test('a failing linter process never breaks the edit', async ($, on) => {
  on('tool.call', () => ({ result: 'edit applied' }))
  on('process.run', () => ({ deny: 'spawn failed' })) // makes $.process.run reject inside the mod
  const out = await $.tool.call({ tool: 'Edit', file_path: '/proj/foo.ts' })
  expect(out).toEqual({ result: 'edit applied' })
})

test('a missing local linter stays silent instead of surfacing tool noise', async ($, on) => {
  on('tool.call', () => ({ result: 'edit applied' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'npm error could not determine executable to run' } }))
  const out = await $.tool.call({ tool: 'Edit', file_path: '/proj/foo.ts' })
  expect(out).toEqual({ result: 'edit applied' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `claude plugin test`
Expected: FAIL — the stub `register` wires no hooks, so `$.tool.call` returns the bare stub result and the "surfaces errors" test's `did not pass lint` assertion fails (and `process.run` is never called).

- [ ] **Step 3: Write the implementation**

`hooks/register.ts`:
```ts
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
```

> **Deviation from spec (deliberate):** the spec listed a `.catch()` backstop "returns the original result if the hook itself throws." The `.catch` return contract isn't documented for `tool.call`, so instead the hook is throw-free *by construction*: the only external call (`$.process.run`) is in try/catch, and every `resolve.ts` helper is total. `next(e)` has already resolved before any helper runs, so even an unexpected throw can't corrupt the edit. Same guarantee, no dependency on an unconfirmed API.

- [ ] **Step 4: Run tests to verify they pass**

Run: `claude plugin test`
Expected: PASS (both test files — resolve + register).

- [ ] **Step 5: Validate the live wiring**

Run: `claude plugin validate .`
Expected: reports the `tool.call` event and the `process.run` mods-API call, no errors.

> **Calibration against the installed build:** `e.file_path` and the `{ result }` envelope shape are declaration-merged and can differ by build. If a real session shows the edited path under a different field, or the surfaced text doesn't reach Claude, read the types for the installed version (Create-a-mod → "get the types for your build") and adjust the single `e.file_path` read and/or `appendToResult`'s shape branches. `appendToResult` already degrades to unchanged on an unrecognized shape, so a mismatch fails safe (silent), never breaks edits.

- [ ] **Step 6: Commit**

```bash
git add hooks/register.ts hooks/register.test.ts
git commit -m "feat: run the resolved linter after each edit and surface failures

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: README + publication

Document the mod, publish the repo with the discovery topic, and open the catalogue PR.

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: a passing, validated mod (Tasks 1–3).
- Produces: public repo `onk3sh/fix-on-edit` (topic `claude-code-mod`) + a PR to `karanb192/awesome-claude-code-mods`.

- [ ] **Step 1: Write the README**

`README.md` covering: one-line what/why; install via `/plugin`; the two `userConfig` fields with the auto-detect table (ts/js→eslint,prettier · py→ruff · go→gofmt); the invisible-on-success / never-breaks-an-edit guarantees; footprint (one `tool.call` hook, one `process.run` call, no network, no file writes); and that it needs Claude Code 2.1.287+.

- [ ] **Step 2: Commit the README**

```bash
git add README.md
git commit -m "docs: README — what it does, install, config, footprint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 3: Create and push the public repo**

```bash
gh repo create onk3sh/fix-on-edit --public --source=. --remote=origin --push
```
(The spec's design + this plan are already committed in `docs/superpowers/`, so they ship with it. `gh` in this sandbox needs `dangerouslyDisableSandbox: true` — TLS cert error otherwise.)

- [ ] **Step 4: Add the discovery topic**

```bash
gh api -X PUT repos/onk3sh/fix-on-edit/topics -f names[]=claude-code-mod
```
This alone lists the mod via the catalogue's ~3-hourly auto-scan. The PR below is the substantive, immediate contribution.

- [ ] **Step 5: Precheck the catalogue repo (honor OSS memory)**

- Read `contributing.md` / `README` of `karanb192/awesome-claude-code-mods` for any **AI/LLM co-authorship policy**. If it bans LLM co-authorship, strip the `Co-Authored-By` trailer and any "Generated with Claude Code" footer from the PR commit and body (per `feedback_oss_ai_attribution`). Otherwise keep the footer on the PR body.
- Confirm no existing open PR already adds `onk3sh/fix-on-edit`, and that `data/seeds.txt` doesn't already contain it (per `feedback_duplicate_pr_precheck`).
- Note the exact lint/test the PR CI runs (`awesome-lint`; `node --test tools/*.test.mjs`) and the exact curated-line format and the right section heading by reading the current `README.md`.

- [ ] **Step 6: Open the catalogue PR**

On a fork + branch: add `onk3sh/fix-on-edit` to `data/seeds.txt` and one curated line under the best-fit section (a behavior/quality or "Agents and workflows" heading), in the exact shape the README uses:
```
- [fix-on-edit](https://github.com/onk3sh/fix-on-edit) - Runs your project's linter on each file Claude edits and feeds any errors back so Claude fixes them in the same turn.
```
Then `gh pr create` with a title/body explaining the mod and that it self-validates. PR body ends with the footer unless Step 5 found an AI-policy ban:
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 7: Report**

Report the repo URL, the topic (auto-listing ETA), and the PR URL.

---

## Self-Review

**1. Spec coverage:**
- Mechanism (hook after edit, per edit tool, config-else-auto, silent/surface) → Task 3. ✓
- `resolveLinter` pure + config precedence + `{file}` substitution + auto-detect table → Task 2. ✓
- Silence & failure rules (no file_path / no cmd / exit 0 / process throws / absent tool) → Task 3 tests 2–5. ✓
- userConfig (`command`, `timeoutMs`) → Task 1 manifest + Task 3 `timeoutMs` wiring. ✓
- Files list → Tasks 1–4; `types/index.d.ts` dropped (only needed for `$.state`/namespace, used by neither — recorded in Global Constraints). ✓
- Publication (topic + seeds.txt + curated line) → Task 4. ✓
- Spec's five test cases → resolve unit (Task 2) + four hook behaviors (Task 3). ✓

**2. Placeholder scan:** none — every code/test step has literal content. Task 1 README/Task 4 prose steps describe sections to write, not code stubs.

**3. Type consistency:** `resolveLinter`, `looksAbsent`, `appendToResult`, `clip`, `header`, `Options`, `RunResult` — identical names/signatures in Task 2 Produces, the implementation, and Task 3 Consumes/imports. `$.process.run` result field is `exitCode` everywhere (not `code`). ✓

**4. Review Focus:** all five lines have an owning task + test (RF1→Task 3 missing-linter test; RF2→Task 2 shellQuote; RF3→Task 2 appendToResult unknown shape; RF4→Task 2 clip; RF5→Task 3 Write test). ✓

**Spec issues resolved inline in this plan:** (a) `out.code`→`out.exitCode`; (b) `$.process.run` takes argv → run via `['sh','-c',cmd]`; (c) the spec's "pure `resolveLinter` that also probes PATH" contradiction → split into a pure `resolveLinter` returning an ordered candidate list and a runtime `looksAbsent` check in the hook; (d) added `clip` truncation (RF4) and the `.catch` deviation note.
