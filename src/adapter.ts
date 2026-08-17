/**
 * GrokAdapter: OpenAI-compatible chat-completions adapter for DSH's LLM seam.
 *
 * By default it talks to the local `grok_dsh_proxy.py` endpoint
 * (`http://127.0.0.1:8765/v1`), which is the current working solution for
 * using a Grok subscription through DSH. The plugin may later be extended to
 * speak directly to `https://cli-chat-proxy.grok.com/v1` using a Node proxy
 * agent (TODO).
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { serializeRequest } from './serialize.js'
import { translate } from './translate.js'

export interface GrokCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: Record<string, string>
}

export interface GrokAdapterOptions {
  baseURL: string
  apiKeyEnv: string
  proxy?: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
  models?: GrokCatalogModel[]
  resolveApiKey: () => Promise<string>
}

const DONE = '[DONE]'

function endpoint(baseURL: string, path: '/chat/completions' | '/models'): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`
}

export class GrokAdapter extends LlmAdapter {
  constructor(private readonly options: GrokAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Grok (Subscription)' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = this.options.models ?? []
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const found = this.options.models?.find(item => item.id === model)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      ...found?.contextWindow !== undefined ? { context: { contextWindow: found.contextWindow } } : {},
      ...found?.maxTokens !== undefined ? { defaultMaxTokens: found.maxTokens } : {},
      ...found?.reasoningEfforts !== undefined
        ? {
          reasoning: {
            efforts: Object.keys(found.reasoningEfforts).map(id => ({ id: ReasoningEffortId(id), name: id })),
          },
        }
        : {},
    }
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const apiKey = await this.options.resolveApiKey()
    const model = this.options.models?.find(item => item.id === options.model)
    const effort = options.reasoningEffort === undefined
      ? undefined
      : model?.reasoningEfforts?.[String(options.reasoningEffort)] ?? String(options.reasoningEffort)

    const body = serializeRequest(options, effort)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }

    let response: Response
    try {
      response = await fetch(endpoint(this.options.baseURL, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      throw new LlmError(`Grok connection failed: ${String(error)}`, 'TRANSPORT')
    }

    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `Grok API error (${response.status}): ${text.slice(0, 500)}`,
        response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP_' + String(response.status),
      )
    }

    const events = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
    const reader = events.getReader()

    async function* payloads(): AsyncGenerator<string> {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const data = value.data
        if (data === DONE) {
          yield DONE
          return
        }
        if (data) yield data
      }
      throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
    }

    yield* translate(payloads())
  }
}
