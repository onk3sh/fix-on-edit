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
