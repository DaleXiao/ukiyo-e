import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSseBusinessError } from '../src/sse-error.ts'

test('native EventSource errors remain available to the reconnect handler', () => {
  assert.equal(parseSseBusinessError(new Event('error')), null)
})

test('server-sent error messages are classified as business errors', () => {
  const event = new MessageEvent('error', {
    data: JSON.stringify({ message: 'generation failed' }),
  })

  assert.deepEqual(parseSseBusinessError(event), { message: 'generation failed' })
})

test('malformed server error payloads stay business errors', () => {
  const event = new MessageEvent('error', { data: 'not-json' })
  assert.deepEqual(parseSseBusinessError(event), {})
})
