/**
 * dsh-llm-grok plugin entry.
 *
 * Registers a `grok` provider route on DSH's LLM seam. Connection facts are
 * resolved per request: the plugin layers its `cordis.yml` entry under the
 * optional `llm-grok` user-settings section and resolves the session token
 * through the credential seam, so a changed base URL, catalog, proxy, or key
 * reaches the next request without restarting. An in-flight stream keeps the
 * facts it started with. The one registration-captured fact — the retry
 * policy — re-registers the route in place when it changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  LlmError,
  RetryPolicySchema,
  assertUsableApiKey,
} from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import '@deepseek-ai/dsh-settings'
import { GrokAdapter } from './adapter.js'
import type { GrokConnectionOptions } from './catalog.ts'
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_PROXY,
  resolveAdapterOptions,
  type Config as GrokPluginConfig,
} from './options.js'

export { resolveAdapterOptions }

export const name = 'llm-grok'
export const inject = ['llm']

const PROVIDER = 'grok'
const NS = 'llm-grok'

const reasoningEfforts = z.dict(z.string())

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoningEfforts,
})

export const Config: z<GrokPluginConfig> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  proxy: z.string().default(DEFAULT_PROXY),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  models: z.array(catalogModel).default(DEFAULT_MODELS as never),
  retryPolicy: RetryPolicySchema,
})

function retryPolicyEquals(
  left: GrokConnectionOptions['retryPolicy'],
  right: GrokConnectionOptions['retryPolicy'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function apply(ctx: Context, config: GrokPluginConfig): void {
  let current = (): GrokPluginConfig => config
  let lastRaw: GrokPluginConfig | undefined
  let lastGood: ReturnType<typeof resolveAdapterOptions> | undefined

  const options = (): ReturnType<typeof resolveAdapterOptions> => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('dsh-llm-grok: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }

  options()

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(options().apiKeyEnv)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'dsh-llm-grok', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'dsh-llm-grok', ref)
      }
    }
    throw new LlmError(
      `dsh-llm-grok: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service, or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new GrokAdapter({
    options,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.effect(() => () => adapter.dispose())

  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'Grok (Subscription)',
    settingsNs: NS,
    settingsPath: [],
  }])

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (retryPolicyEquals(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source: () => GrokPluginConfig) => {
        current = source
      },
      onChange: ensureRegistrationFacts,
    })
  })
}
