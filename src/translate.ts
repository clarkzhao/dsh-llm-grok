/**
 * Translate Grok SSE chat-completion chunks into DSH StreamChunks.
 * This mirrors the DeepSeek adapter's translation logic, adapted for Grok.
 */

import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { WireChunk } from './types.ts'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

export function mapUsage(usage: NonNullable<WireChunk['usage']>): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: (usage.prompt_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens ?? 0,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  // Emit the deferred tail: any opened blocks are closed, usage is reported,
  // and a finish is produced. A `stop` (or absent) finish with no opened
  // blocks is a degenerate provider completion and maps to an EMPTY_RESPONSE
  // error finish rather than a successful empty message.
  function finish(): Generator<StreamChunk> {
    function* tail(): Generator<StreamChunk> {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      }
    }
    return tail()
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      yield* finish()
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index ?? 0)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index ?? 0, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  // Some providers (Grok's subscription cli-proxy in particular) close the
  // SSE stream after the final content chunk without emitting the `[DONE]`
  // sentinel. Treat a clean end-of-input as a normal completion: flush the
  // blocks we have already buffered, rather than failing the whole turn with
  // STREAM_CLOSED. Only a stream that closed with absolutely nothing — no
  // content, no reasoning, no usage, no finish reason — is a real error.
  if (order.length > 0 || pendingUsage || pendingFinish) {
    yield* finish()
    return
  }

  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
