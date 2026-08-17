/**
 * Serialize DSH messages into Grok's OpenAI chat-completions wire format.
 *
 * Text-only turns stay string content. ImageBlocks in user content and nested
 * tool-result content become `image_url` data URLs. Bytes are read from the
 * injected attachment store and never enter the session log.
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { WireContentPart, WireMessage, WireRequest, WireTool } from './types.ts'

export interface StoredImage {
  ref: { mediaType: string }
  data: Uint8Array
}

export interface AttachmentReader {
  readImage(ref: { attachmentId: unknown; mediaType: string }): Promise<StoredImage>
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function rejectImages(role: string): never {
  throw new LlmError(
    `The Grok chat-completions adapter does not support image content in ${role} messages.`,
    'UNSUPPORTED_CONTENT',
  )
}

function dataUrl(mediaType: string, data: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
}

async function loadImage(
  ref: { attachmentId: unknown; mediaType: string },
  attachments: AttachmentReader | undefined,
  cache: Map<string, StoredImage>,
): Promise<StoredImage> {
  if (attachments === undefined) {
    throw new LlmError(
      'The Grok chat-completions adapter requires the durable attachment service to send image content.',
      'UNSUPPORTED_CONTENT',
    )
  }
  const key = String(ref.attachmentId)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const stored = await attachments.readImage(ref)
  cache.set(key, stored)
  return stored
}

async function serializeParts(
  blocks: readonly ContentBlock[],
  attachments: AttachmentReader | undefined,
  cache: Map<string, StoredImage>,
): Promise<WireContentPart[]> {
  const parts: WireContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const stored = await loadImage(block.attachment, attachments, cache)
      parts.push({
        type: 'image_url',
        image_url: { url: dataUrl(stored.ref.mediaType, stored.data) },
      })
    }
  }
  return parts
}

function serializeAssistant(message: Message): WireMessage {
  if (contentHasImage(message.content)) rejectImages('assistant')
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    content: text,
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
  }
}

async function serializeMessages(
  messages: Message[],
  attachments: AttachmentReader | undefined,
): Promise<WireMessage[]> {
  const cache = new Map<string, StoredImage>()
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) rejectImages('system')
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const userBlocks = message.content.filter(block => block.type !== 'tool-result')
    if (userBlocks.length > 0 || toolResults.length === 0) {
      if (contentHasImage(userBlocks)) {
        wire.push({ role: 'user', content: await serializeParts(userBlocks, attachments, cache) })
      } else {
        wire.push({ role: 'user', content: flattenText(userBlocks) })
      }
    }
    for (const result of toolResults) {
      if (contentHasImage(result.content)) {
        wire.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: await serializeParts(result.content, attachments, cache),
        })
      } else {
        wire.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: flattenText(result.content) || '(no output)',
        })
      }
    }
  }
  return wire
}

export async function serializeRequest(
  options: GenerateOptions,
  reasoningEffort?: string,
  attachments?: AttachmentReader,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessages(options.messages, attachments))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop === undefined ? {} : { stop: options.stop },
    ...tools === undefined || tools.length === 0 ? {} : { tools },
    ...reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort },
  }
}
