# fix-on-edit — design

Date: 2026-10-08
Status: locked, pre-implementation

## Intent

A Claude Code **mod** (function-hook plugin, Claude Code 2.1.287+) that runs the
project's own linter/formatter on the single file Claude just edited and feeds any
errors straight back into the model's context, so Claude self-corrects immediately
instead of leaving broken code to be discovered later.

**Who it's for:** developers running long agentic Claude Code sessions — the people
who install mods. **Success:** after an Edit/Write, if the changed file fails the
project linter, Claude sees the errors in the tool result and fixes them in the same
turn; if it passes, the mod is invisible.

### Why this mod (gap analysis)

The ~2,900-mod catalogue is dominated by two saturated categories: usage/cost
dashboards (~23 curated) and "while you wait" toys — games, pets, Doom (~21). Almost
every mod is **passive** (panes, bands, status lines). The capability mods uniquely
have — intercepting tool calls/results in-flight to change what the agent does — is
barely used (essentially one mod, `deploy-verify`, deploy-only). `fix-on-edit` sits in
that empty behavior-modification space and improves output quality rather than
displaying stats.

## Mechanism

One hook on `tool.call`, matching the edit tools, running **after** the edit:

```ts
on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
  const r = await next(e)                         // 1. let the edit happen
  const file = e.file_path                        // 2. the one changed file
  if (!file) return r
  const cmd = resolveLinter(file, options)        // 3. config, else auto-detect
  if (!cmd) return r                              //    no linter -> stay silent
  let out
  try { out = await $.process.run(cmd, { timeoutMs: options.timeoutMs }) }
  catch { return r }                              // 4. linter missing/broken -> never break the edit
  if (out.code === 0) return r                    // 5. clean -> untouched
  return appendToResult(r, header(file) + (out.stdout || out.stderr))  // 6. model sees it
})
```

Registered once per edit tool: `Edit`, `Write`, `MultiEdit`.

### API facts this relies on (from the mods reference, v2.1.290)

- `on('tool.call', { tool }, handler)` — handler `async ($, e, next)`.
- `await next(e)` runs the tool and resolves to its **result** (content blocks, Agent
  SDK shape; a tool without a declared result type is `unknown`).
- A `tool.call` hook may return `next(e)`, `{ deny: reason }`, or `{ result }`. We
  return the (possibly augmented) resolved result — **never `deny`**.
- `e` for an edit tool carries the tool's inputs, including `file_path`.
- `$.process.run(cmd, { timeoutMs })` runs a subprocess (default 30 s, max 10 min).
  Time inside a mods-API call does **not** count against the hook's 10 s execution
  budget, so running a linter here is within limits.
- `options` (second arg to `register`) holds the `userConfig` values from the manifest,
  defaults filled in.
- `on(...).catch(handler)` registers an error backstop for the hook.

> **Calibration knob:** the exact shape of the tool *result* and the edit event fields
> is declaration-merged and can differ by installed build. `appendToResult` and the
> `e.file_path` read are confirmed at build time against the types Claude Code writes
> for the installed version (`claude plugin validate` / "get the types for your build"),
> and `appendToResult` is written to degrade safely if the result isn't the expected
> shape (fall back to returning `r` unchanged).

## Linter resolution

1. If `userConfig.command` is set, use it, substituting `{file}` with the edited path
   (shell-quoted). Example: `eslint --fix {file}`.
2. Otherwise auto-detect by file extension, taking the first candidate whose binary
   resolves on PATH (a failed spawn is treated as "not available" and skipped):

   | Extensions | Candidates (first available wins) |
   |---|---|
   | `.ts .tsx .js .jsx .mjs .cjs` | `npx --no-install eslint {file}`, then `npx --no-install prettier --check {file}` |
   | `.py` | `ruff check {file}` |
   | `.go` | `gofmt -l {file}` |
   | anything else | none → silent |

   Node tools are invoked via `npx --no-install` so the **project-local** binary in
   `node_modules/.bin` is used and nothing is ever fetched from the network; if the
   project has no eslint/prettier installed, `npx --no-install` exits non-zero and that
   candidate is skipped. `ruff`/`gofmt` are expected on PATH. Auto-detect is
   intentionally small; everything else is covered by `command`.

## Configuration (`userConfig` in `.claude-plugin/plugin.json`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | string | `""` | Lint command with a `{file}` placeholder. Empty → auto-detect. Put `--fix`/`--write` here if the tool supports it. |
| `timeoutMs` | number | `15000` | Subprocess timeout passed to `$.process.run`. |

## Silence & failure rules (non-negotiable)

- No `file_path`, no resolved command, or exit code 0 → return the result **unchanged**.
- `$.process.run` throws, times out, or the binary is missing → swallow, return `r`.
- `.catch()` backstop returns the original result if the hook itself throws.
- Never emit a success toast; never `deny`; never modify the file. The mod is invisible
  unless there is something for Claude to fix.

## Files (mod plugin layout)

```
.claude-plugin/plugin.json   manifest + userConfig declaration + types ref
hooks/hooks.json             { "modules": ["./register.ts"] }
hooks/register.ts            export const register: Register = (on, options) => {...}
hooks/resolve.ts             resolveLinter(file, options) -> string | null  (pure, unit-tested)
hooks/register.test.ts       claude plugin test cases (below)
types/index.d.ts             userConfig value types (if needed)
README.md                    what it does, install, config, footprint
```

`resolveLinter` is a pure function (extension + options → command | null) so the
interesting logic is testable without the hook runtime.

## Tests (`claude plugin test`, `*.test.ts`)

Mock `$` (stub `$.process.run`) and `e`:

1. **errors surfaced** — `process.run` returns `{ code: 1, stdout: "err" }` → returned
   result contains the linter output.
2. **clean pass** — `process.run` returns `{ code: 0 }` → returned result is identical
   to `await next(e)`.
3. **no resolver** — `command` empty and extension unknown → `resolveLinter` returns
   null → result identical, `process.run` never called.
4. **process throws** — `process.run` rejects → result identical (swallowed).
5. **resolveLinter unit** — `{file}` substitution, extension mapping, config precedence.

## Out of scope (YAGNI)

Config/UI pane, multi-file batching, result caching, non-edit tools, a separate
`--fix` toggle, language servers. Add only if asked.

## Publication

- Repo `onk3sh/fix-on-edit`, GitHub topic `claude-code-mod` → the catalogue's
  three-hourly scan auto-lists it within hours (no PR needed for listing).
- Separately: PR to `karanb192/awesome-claude-code-mods` adding `onk3sh/fix-on-edit`
  to `data/seeds.txt` plus a curated one-line entry under **Agents and workflows** (or
  a behavior/quality section), in the exact shape
  `- [fix-on-edit](url) - one sentence ending with a period.` This is the substantive
  awesome-repo contribution (Play 1-A's catalogue PR).
