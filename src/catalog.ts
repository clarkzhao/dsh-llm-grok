/** Catalog and connection-fact types shared by the adapter and option resolver. */

import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'

export interface GrokCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: Record<string, string>
}

/** Validated connection facts for one operation. */
export interface GrokConnectionOptions {
  baseURL: string
  proxy?: string
  defaultContextWindow: number
  defaultMaxTokens: number
  models: readonly GrokCatalogModel[]
  retryPolicy: ResolvedRetryPolicy
}
