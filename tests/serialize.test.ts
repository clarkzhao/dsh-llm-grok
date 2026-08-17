import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallId, LlmError, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serializeRequest, type AttachmentReader } from '../src/serialize.ts'
import type { WireContentPart, WireMessage } from '../src/types.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])

function imageRef(id: string) {
  return {
    attachmentId: id as never,
    mediaType: 'image/png' as const,
    bytes: PNG.byteLength,
    width: 8,
    height: 8,
    name: `${id}.png`,
  }
}

function reader(bytesById: Record<string, Uint8Array> = { shot: PNG }): AttachmentReader {
  const reads: string[] = []
  return {
    reads,
    async readImage(ref) {
      const id = String(ref.attachmentId)
      reads.push(id)
      const data = bytesById[id]
      if (data === undefined) throw new Error(`missing fixture ${id}`)
      return { ref, data }
    },
  }
}

function options(messages: GenerateOptions['messages']): GenerateOptions {
  return {
    provider: 'grok',
    model: 'grok-4.6',
    messages,
  }
}

function contentParts(message: WireMessage): WireContentPart[] {
  assert.ok(Array.isArray(message.content), 'expected multipart content')
  return message.content
}

test('text-only user messages stay a string and never touch attachments', async () => {
  const attachments = reader()
  const body = await serializeRequest(options([
    createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
  ]), undefined, attachments)

  assert.deepEqual(body.messages, [
    { role: 'user', content: 'hello' },
  ])
  assert.equal(attachments.reads.length, 0)
})

test('user text plus image becomes image_url data URL parts in order', async () => {
  const attachments = reader()
  const body = await serializeRequest(options([
    createUserMessage({
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', attachment: imageRef('shot') },
      ],
      source: { kind: 'user' },
    }),
  ]), undefined, attachments)

  assert.deepEqual(contentParts(body.messages[0]!), [
    { type: 'text', text: 'what is this?' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` } },
  ])
  assert.deepEqual(attachments.reads, ['shot'])
})

test('image-only user content is legal multipart with no text part', async () => {
  const body = await serializeRequest(options([
    createUserMessage({
      content: [{ type: 'image', attachment: imageRef('shot') }],
      source: { kind: 'user' },
    }),
  ]), undefined, reader())

  assert.deepEqual(contentParts(body.messages[0]!), [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` } },
  ])
})

test('the same attachmentId is read once per request', async () => {
  const attachments = reader()
  const ref = imageRef('shot')
  await serializeRequest(options([
    createUserMessage({
      content: [
        { type: 'image', attachment: ref },
        { type: 'text', text: 'again' },
        { type: 'image', attachment: ref },
      ],
      source: { kind: 'user' },
    }),
  ]), undefined, attachments)

  assert.deepEqual(attachments.reads, ['shot'])
})

test('tool-result images stay on the tool message as image_url parts', async () => {
  const attachments = reader()
  const body = await serializeRequest(options([
    createAssistantMessage({
      content: [{
        type: 'tool-call',
        id: CallId('call-1'),
        name: 'read_file',
        arguments: '{}',
      }],
      source: { provider: 'grok', model: 'grok-4.6' },
    }),
    createToolResultMessage({
      callId: CallId('call-1'),
      isError: false,
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', attachment: imageRef('shot') },
      ],
    }),
  ]), undefined, attachments)

  const tool = body.messages.find(message => message.role === 'tool')
  assert.ok(tool)
  assert.equal(tool.tool_call_id, 'call-1')
  assert.deepEqual(contentParts(tool), [
    { type: 'text', text: 'screenshot' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` } },
  ])
})

test('images without an attachment reader fail UNSUPPORTED_CONTENT', async () => {
  await assert.rejects(
    () => serializeRequest(options([
      createUserMessage({
        content: [{ type: 'image', attachment: imageRef('shot') }],
        source: { kind: 'user' },
      }),
    ])),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'UNSUPPORTED_CONTENT')
      return true
    },
  )
})

test('images in system or assistant messages fail UNSUPPORTED_CONTENT', async () => {
  const attachments = reader()
  await assert.rejects(
    () => serializeRequest({
      provider: 'grok',
      model: 'grok-4.6',
      messages: [{
        id: 'sys' as never,
        role: 'system',
        content: [{ type: 'image', attachment: imageRef('shot') }],
        source: { kind: 'user' },
      }],
    }, undefined, attachments),
    (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED_CONTENT',
  )

  await assert.rejects(
    () => serializeRequest(options([
      createAssistantMessage({
        content: [{ type: 'image', attachment: imageRef('shot') }],
        source: { provider: 'grok', model: 'grok-4.6' },
      }),
    ]), undefined, attachments),
    (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED_CONTENT',
  )
})
