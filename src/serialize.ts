/**
 * Serialize DSH messages into Grok's OpenAI chat-completions wire format.
 *
 * Text-only turns stay string content. ImageBlocks in user content and nested
 * tool-result content become `image_url` data URLs. Bytes are read from the
 * injected attachment store and never enter the session log.
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { WireContentPart, WireMessage, WireRequest, WireTool } from './types.ts'

export type AttachmentReader = Pick<AttachmentStore, 'readImage'>

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
  ref: ImageAttachmentRef,
  attachments: AttachmentReader | undefined,
  cache: Map<string, StoredImageAttachment>,
): Promise<StoredImageAttachment> {
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
  cache: Map<string, StoredImageAttachment>,
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

function serializeAssistant(message: AssistantMessage): WireMessage {
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
  messages: readonly RequestMessage[],
  attachments: AttachmentReader | undefined,
): Promise<WireMessage[]> {
  const cache = new Map<string, StoredImageAttachment>()
  const wire: WireMessage[] = []
  for (const message of messages) {
    // DSH 0.1.7 models a tool result as its own `tool`-role message rather than
    // a `tool-result` content block, so dispatch on the role directly.
    switch (message.role) {
      case 'system':
        if (contentHasImage(message.content)) rejectImages('system')
        wire.push({ role: 'system', content: flattenText(message.content) })
        continue

      // Tool additions/removals are folded into the request's tool list by
      // `projectToolUpdates` before dispatch; a chat-completions wire has no
      // history slot for them.
      case 'developer':
        continue

      case 'assistant':
        wire.push(serializeAssistant(message))
        continue

      case 'tool':
        if (contentHasImage(message.content)) {
          wire.push({
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: await serializeParts(message.content, attachments, cache),
          })
        } else {
          wire.push({
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: flattenText(message.content) || '(no output)',
          })
        }
        continue

      case 'user':
        if (contentHasImage(message.content)) {
          wire.push({ role: 'user', content: await serializeParts(message.content, attachments, cache) })
        } else {
          wire.push({ role: 'user', content: flattenText(message.content) })
        }
        continue
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
