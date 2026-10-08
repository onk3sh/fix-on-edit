# fix-on-edit

Runs your project's linter on each file Claude edits and feeds any errors back so Claude fixes them in the same turn.

## Install

Use Claude Code's `/plugin` command:

```
/plugin https://github.com/onk3sh/fix-on-edit
```

Requires Claude Code **2.1.287+**.

## Configuration

Two optional user-config fields in `.claude/settings.local.json`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | string | `""` | Lint command with a `{file}` placeholder, e.g. `eslint --fix {file}`. Empty = auto-detect by extension. |
| `timeoutMs` | number | `15000` | Subprocess timeout in milliseconds. |

### Auto-detect table

If no `command` is set, the mod detects the linter by file extension (first candidate whose binary is on PATH wins):

| Extensions | Candidates (in order) |
|---|---|
| `.ts .tsx .js .jsx .mjs .cjs` | `npx --no-install eslint {file}`, then `npx --no-install prettier --check {file}` |
| `.py` | `ruff check {file}` |
| `.go` | `gofmt -l {file}` |

Node tools use `npx --no-install` to run project-local binaries without fetching from the network. Other extensions are not auto-detected.

## Guarantees

- **Invisible on success:** if the linter exits cleanly (code 0), the result is unchanged.
- **Never breaks an edit:** if the linter is missing, times out, or crashes, the edit succeeds and the mod returns silently.
- **Never denies:** always returns the original result, never uses `deny`.
- **Never modifies the file:** only observes; the file is whatever `Edit` wrote.

## Footprint

- One `tool.call` hook registered for `Edit`, `Write`, and `MultiEdit`.
- One `$.process.run` call per edit (only if a linter is resolved).
- No network access; no file I/O.
- Subprocess timeout is configurable.

## How it works

After Claude edits a file:

1. Resolve a linter command (config, or auto-detect by extension).
2. Run it on the single changed file with the configured timeout.
3. If it fails (exit code ≠ 0), append the error output to the tool result so Claude sees it.
4. Claude self-corrects in the same turn.

If any step can't proceed (no linter found, subprocess missing, timeout, etc.), the mod stays silent.
