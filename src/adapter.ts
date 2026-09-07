/**
 * GrokAdapter: OpenAI-compatible chat-completions adapter for DSH's LLM seam.
 *
 * It talks directly to `https://cli-chat-proxy.grok.com/v1` through a Node
 * `undici` ProxyAgent (for example `http://127.0.0.1:7890`). No local Python
 * proxy is required. Connection facts arrive through a thunk resolved once
 * per operation so a settings change reaches the next request without
 * re-registration; an in-flight stream keeps the facts it started with.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import {
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
  attributionHeaders,
  errorChain,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { serializeRequest } from './serialize.js'
import { translate } from './translate.js'
import { grokHeaders, httpErrorCode, sanitizeErrorBody } from './http.js'
import type { GrokConnectionOptions } from './options.ts'

export interface GrokAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => GrokConnectionOptions
  /** Resolve the bearer for the connection snapshot of this request. */
  resolveApiKey: (connection: GrokConnectionOptions) => Promise<string>
  resolveAttachments?: () => AttachmentStore | undefined
}

const DONE = '[DONE]'
const GROK_DIRECT_HOST = 'cli-chat-proxy.grok.com'
const INPUT_MODALITIES = ['text', 'image'] as const

function endpoint(baseURL: string, path: '/chat/completions' | '/models'): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`
}

function isDirectGrok(baseURL: string): boolean {
  return baseURL.includes(GROK_DIRECT_HOST)
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1e3
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-grok-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

export class GrokAdapter extends LlmAdapter {
  private readonly config: GrokAdapterOptions
  private dispatcher: ProxyAgent | undefined
  private dispatcherProxy: string | undefined

  constructor(config: GrokAdapterOptions) {
    super()
    this.config = config
  }

  /** Close the cached proxy agent; call once when the adapter is retired. */
  dispose(): void {
    this.dispatcher?.close().catch(() => undefined)
    this.dispatcher = undefined
    this.dispatcherProxy = undefined
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Grok (Subscription)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.config.options().models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: INPUT_MODALITIES,
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.modelInfoFor(this.config.options(), provider, model)
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options()
    return Promise.resolve({
      model: this.modelInfoFor(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }

  private modelInfoFor(
    connection: GrokConnectionOptions,
    provider: string,
    model: string,
  ): LlmResolvedModelInfo {
    const found = connection.models.find(item => item.id === model)
    const contextWindow = found?.contextWindow ?? connection.defaultContextWindow
    const maxTokens = found?.maxTokens ?? connection.defaultMaxTokens
    const efforts = found?.reasoningEfforts
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: INPUT_MODALITIES,
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
      ...efforts !== undefined
        ? {
          reasoning: {
            efforts: Object.keys(efforts).map(id => ({ id: ReasoningEffortId(id), name: id })),
          },
        }
        : {},
    }
  }

  private dispatcherFor(proxy: string | undefined): ProxyAgent | undefined {
    if (proxy === undefined || proxy.length === 0) {
      if (this.dispatcher !== undefined) {
        this.dispatcher.close().catch(() => undefined)
        this.dispatcher = undefined
        this.dispatcherProxy = undefined
      }
      return undefined
    }
    if (this.dispatcher !== undefined && this.dispatcherProxy === proxy) return this.dispatcher
    if (this.dispatcher !== undefined) this.dispatcher.close().catch(() => undefined)
    this.dispatcher = new ProxyAgent(proxy)
    this.dispatcherProxy = proxy
    return this.dispatcher
  }

  private async *streamWithConnection(
    options: GenerateOptions,
    connection: GrokConnectionOptions,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = await this.config.resolveApiKey(connection)
    const model = connection.models.find(item => item.id === options.model)
    const effort = options.reasoningEffort === undefined
      ? undefined
      : model?.reasoningEfforts?.[String(options.reasoningEffort)] ?? String(options.reasoningEffort)

    const body = await serializeRequest(options, effort, this.config.resolveAttachments?.())
    const direct = isDirectGrok(connection.baseURL)
    const headers: Record<string, string> = direct
      ? grokHeaders(apiKey, options.model)
      : {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
        ...attributionHeaders(),
      }

    const dispatcher = this.dispatcherFor(connection.proxy)
    let response: Response
    try {
      const url = endpoint(connection.baseURL, '/chat/completions')
      response = await undiciFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
        ...dispatcher !== undefined ? { dispatcher } : {},
      }) as unknown as Response
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError('Grok request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(`Grok connection failed: ${errorChain(error)}`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '')
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(
        `Grok API error (${response.status}): ${sanitizeErrorBody(text)}`,
        httpErrorCode(response.status, text),
        {
          status: response.status,
          ...delay === undefined ? {} : { providerRetryAfterMs: delay },
          ...id === undefined ? {} : { requestId: id },
        },
      )
    }

    const events = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
    const reader = events.getReader()

    async function* payloads(): AsyncGenerator<string> {
      while (true) {
        const { done, value } = await reader.read()
        // A clean EOF just ends the iteration. `translate` distinguishes a
        // genuine truncation (nothing yielded at all) from a provider that
        // finished its content but never sent the `[DONE]` sentinel, so it can
        // flush a normal finish instead of failing with STREAM_CLOSED.
        if (done) return
        const data = value.data
        if (data === DONE) {
          yield DONE
          return
        }
        if (data) yield data
      }
    }

    yield* translate(payloads())
  }
}
