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
