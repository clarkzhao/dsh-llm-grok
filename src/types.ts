/**
 * Wire types for Grok's OpenAI-compatible chat-completions endpoint.
 * This is intentionally a small subset; extend as needed.
 */

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_call_id?: string
  tool_calls?: WireToolCall[]
  reasoning_content?: string
}

export interface WireToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options?: { include_usage: true }
  temperature?: number
  max_tokens?: number
  stop?: string[]
  tools?: WireTool[]
  reasoning_effort?: string
}

export interface WireChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}
