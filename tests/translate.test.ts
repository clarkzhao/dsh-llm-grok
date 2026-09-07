import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { translate } from '../src/translate.ts'

async function collect(payloads: AsyncIterable<string>) {
  const chunks: Array<{ type: string } & Record<string, unknown>> = []
  for await (const chunk of translate(payloads)) {
    chunks.push(chunk as { type: string } & Record<string, unknown>)
  }
  return chunks
}

test('throws STREAM_CLOSED when a completely empty stream ends without [DONE]', async () => {
  async function* empty() { /* nothing yielded, then done */ }
  await assert.rejects(
    () => collect(empty()),
    (err: unknown) => err instanceof LlmError && err.code === 'STREAM_CLOSED',
  )
})

test('flushes a normal finish when content arrives and the stream closes without [DONE]', async () => {
  async function* partial() {
    yield JSON.stringify({
      choices: [{ delta: { content: 'Hello' }, index: 0 }],
    })
    yield JSON.stringify({
      choices: [{ delta: { content: ' world' }, index: 0 }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    })
    // stream simply ends here — no [DONE] sentinel
  }

  const chunks = await collect(partial())
  const types = chunks.map(c => c.type)

  assert.ok(types.includes('text-delta'), 'should have streamed text deltas')
  assert.ok(types.includes('block-end'), 'should have closed the opened block')
  assert.ok(types.includes('usage'), 'should have reported usage')
  assert.ok(types.includes('finish'), 'should have emitted a finish')

  const finish = chunks.find(c => c.type === 'finish') as { reason?: { kind?: string } }
  assert.equal(finish.reason?.kind, 'stop')

  const text = chunks
    .filter(c => c.type === 'text-delta')
    .map(c => c.text)
    .join('')
  assert.equal(text, 'Hello world')
})
