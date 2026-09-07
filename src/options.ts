/**
 * Validate plugin config into per-request connection facts. Kept out of
 * `index.ts` so unit tests can import it without loading the Cordis plugin
 * entry (Node's strip-only loader cannot follow `.js` specifiers into `src/`).
 */

import { resolveRetryPolicy, type RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { GrokCatalogModel, GrokConnectionOptions } from './catalog.ts'

export const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
export const DEFAULT_PROXY = 'http://127.0.0.1:7890'
export const DEFAULT_API_KEY_ENV = 'GROK_SESSION_TOKEN'
export const DEFAULT_CONTEXT_WINDOW = 500000
export const DEFAULT_MAX_TOKENS = 128000

export interface Config {
  baseURL?: string
  apiKeyEnv?: string
  proxy?: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
  models?: GrokCatalogModel[]
  retryPolicy?: RetryPolicyConfig
}

export const DEFAULT_MODELS: GrokCatalogModel[] = [
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
  },
]

function resolveModels(
  models: GrokCatalogModel[] | undefined,
  defaultContextWindow: number,
  defaultMaxTokens: number,
): GrokCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map(model => {
    if (model.id.length === 0) throw new Error('dsh-llm-grok: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`dsh-llm-grok: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`dsh-llm-grok: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`dsh-llm-grok: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (seen.has(model.id)) throw new Error(`dsh-llm-grok: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? defaultContextWindow,
      maxTokens: model.maxTokens ?? defaultMaxTokens,
      ...model.reasoningEfforts === undefined ? {} : { reasoningEfforts: { ...model.reasoningEfforts } },
    }
  })
}

export function resolveAdapterOptions(config: Config): GrokConnectionOptions & { apiKeyEnv: string } {
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('dsh-llm-grok: defaultContextWindow must be a positive integer')
  }
  if (config.defaultMaxTokens !== undefined && (!Number.isSafeInteger(config.defaultMaxTokens) || config.defaultMaxTokens <= 0)) {
    throw new Error('dsh-llm-grok: defaultMaxTokens must be a positive safe integer')
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  const defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
  const proxy = config.proxy ?? DEFAULT_PROXY
  return {
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    ...proxy.length > 0 ? { proxy } : {},
    defaultContextWindow,
    defaultMaxTokens,
    models: resolveModels(config.models, defaultContextWindow, defaultMaxTokens),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'dsh-llm-grok: retryPolicy'),
  }
}
