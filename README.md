# fix-on-edit

Runs your project's linter on each file Claude edits and feeds back **only the errors on the lines Claude just changed**, so Claude fixes them in the same turn without being distracted by pre-existing problems elsewhere in the file.

## Install

Use Claude Code's `/plugin` command:

```
/plugin https://github.com/onk3sh/fix-on-edit
```

Requires Claude Code **2.1.287+**.

## Configuration

Two optional user-config fields (set them when you install the plugin):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | string | `""` | Lint command with a `{file}` placeholder, e.g. `eslint --fix {file}`. Empty = auto-detect by extension. |
| `timeoutMs` | number | `15000` | Subprocess timeout in milliseconds. |

### Auto-detect table

If no `command` is set, the mod detects the linter by file extension (first available candidate wins — npx tools must be installed in the project; `ruff`/`gofmt` must be on `PATH`):

| Extensions | Candidates (in order) |
|---|---|
| `.ts .tsx .js .jsx .mjs .cjs` | `npx --no-install eslint {file}`, then `npx --no-install prettier --check {file}` |
| `.py` | `ruff check {file}` |
| `.go` | `gofmt` |

Node tools use `npx --no-install` to run project-local binaries without fetching from the network. Other extensions are not auto-detected. For Go, the file is flagged when `gofmt` reports it isn't formatted.

## Diff-scoped feedback

A linter run on the whole file reports every problem in it, including ones on lines Claude never touched. Dumping all of that back at Claude is noise — it buries the error the edit actually introduced and can send Claude off "fixing" unrelated code.

So after the linter runs, the mod keeps **only the diagnostics on lines the current edit changed**:

1. `git diff -U0` on the file gives the exact new-file line ranges the edit touched.
2. Each line-numbered diagnostic (eslint, ruff, tsc, gcc shapes) is kept only if its line falls in that set; everything else is dropped.
3. If the edit introduced no in-range problems, the mod stays silent even when the file has errors elsewhere.

Fallbacks, so nothing is ever hidden by accident:

- **Not a git repo, or an untracked/new file:** no diff to scope against → the whole report is surfaced (every line of a brand-new file is "changed" anyway).
- **File-level output with no line numbers** (e.g. `prettier --check`, `gofmt -d`): can't be scoped → surfaced whole.

## Guarantees

- **Invisible on success:** if the linter exits cleanly (code 0), the result is unchanged.
- **Only your edit's errors:** in a git repo, only diagnostics on the lines you changed are surfaced (see above).
- **Never breaks an edit:** if the linter can't be spawned or times out, the edit still succeeds and the mod stays silent. (A linter that runs and reports problems surfaces them — that is the point.)
- **Never denies:** always returns the original result, never uses `deny`.
- **Never modifies the file itself:** the mod only observes. A `command` you configure with `--fix`/`--write` can change the file — that is your choice, not the mod's.

## Footprint

- A single `tool.call` handler, registered for `Edit`, `Write`, and `MultiEdit`.
- One `$.process.run` call per candidate linter — one for most languages, at most two for JS/TS (eslint, then prettier only if eslint isn't installed) — plus one `git diff` call only when a linter actually reports problems.
- No network access; no file I/O.
- Subprocess timeout is configurable.

## How it works

After Claude edits a file:

1. Resolve a linter command (config, or auto-detect by extension).
2. Run it on the single changed file with the configured timeout.
3. If it fails (exit code ≠ 0), scope the output to the lines the edit changed (see [Diff-scoped feedback](#diff-scoped-feedback)) and append what remains to the tool result so Claude sees it.
4. Claude self-corrects in the same turn.

If any step can't proceed (no linter found, subprocess missing, timeout, etc.), the mod stays silent.

**Note:** a linter that *errors on invocation* (missing config, a file outside its configured root, etc.) exits non-zero, so its error is surfaced like a lint failure. Set an explicit `command` if you need to control exactly what runs.
