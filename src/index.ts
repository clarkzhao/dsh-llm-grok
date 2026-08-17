/**
 * dsh-llm-grok plugin entry.
 *
 * Registers a `grok` provider route on DSH's LLM seam. The adapter talks to
 * the local Grok subscription proxy by default; see README for setup.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GrokAdapter } from './adapter.js'
import type { GrokCatalogModel } from './adapter.js'

export const name = 'llm-grok'
export const inject = ['llm']

const PROVIDER = 'grok'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8765/v1'
const DEFAULT_API_KEY_ENV = 'GROK_SESSION_TOKEN'

export interface Config {
  baseURL?: string
  apiKeyEnv?: string
  proxy?: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
  models?: GrokCatalogModel[]
}

const reasoningEfforts = z.dict(z.string())

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoningEfforts,
})

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  proxy: z.string(),
  defaultContextWindow: z.number().step(1).min(1).default(500000),
  defaultMaxTokens: z.number().step(1).min(1).default(128000),
  models: z.array(catalogModel).default([
    {
      id: 'grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 500000,
      maxTokens: 128000,
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    },
    {
      id: 'grok-4.5',
      name: 'Grok 4.5',
      contextWindow: 500000,
      maxTokens: 128000,
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    },
  ]),
})

export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV

  const resolveApiKey = async (): Promise<string> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(apiKeyEnv as never)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    const ambient = process.env[apiKeyEnv]
    if (ambient !== undefined && ambient.length > 0) return ambient
    throw new Error(`dsh-llm-grok: missing credential ${apiKeyEnv}`)
  }

  const adapter = new GrokAdapter({
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    apiKeyEnv,
    proxy: config.proxy,
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
    models: config.models,
    resolveApiKey,
  })

  ctx.llm.registerAdapter([PROVIDER], adapter)
}
