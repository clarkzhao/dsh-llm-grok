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
import { isVolatile } from '@deepseek-ai/cosmokit'
import type { Volatile } from '@deepseek-ai/cosmokit'
// Type-only: brings the `loader/volatile-update` event declaration into the
// program. The loader dispatches it to the owning fiber when a volatile field
// is committed without a remount.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { GrokAdapter } from './adapter.js'
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_PROXY,
  resolveAdapterOptions,
  type Config as GrokPluginConfig,
  type GrokConnectionOptions,
} from './options.js'

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

// Every field is marked `.volatile()`. In DSH 0.2.0 the settings page is
// derived from this schema by `SettingsForms.describe()`, which keeps only
// fields under a `volatile` node (`volatileForm()`) and returns no descriptor
// at all when none is marked — the `llm-grok` page silently disappears without
// them. The marker also changes what `apply` receives: a volatile field
// arrives as a live `Volatile<T>` reference, so reads go through `configValue`.
export const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  proxy: z.string().default(DEFAULT_PROXY).volatile(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  models: z.array(catalogModel).default(DEFAULT_MODELS as never).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
})

/**
 * Read the current value behind one config field. Validated config hands a
 * volatile field over as a stable reference whose value the owning runtime
 * updates, so the value is taken per read; an ordinary field passes through.
 */
function configValue<T>(field: T | Volatile<T> | undefined): T | undefined {
  if (field === undefined) return undefined
  return isVolatile(field) ? field.get() as T : field as T
}

/** Detach every field of a validated config into plain values. */
function plainConfig(config: GrokPluginConfig): GrokPluginConfig {
  return {
    baseURL: configValue(config.baseURL),
    apiKeyEnv: configValue(config.apiKeyEnv),
    proxy: configValue(config.proxy),
    defaultContextWindow: configValue(config.defaultContextWindow),
    defaultMaxTokens: configValue(config.defaultMaxTokens),
    models: configValue(config.models),
    retryPolicy: configValue(config.retryPolicy),
  }
}

function retryPolicyEquals(
  left: GrokConnectionOptions['retryPolicy'],
  right: GrokConnectionOptions['retryPolicy'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function apply(ctx: Context, config: GrokPluginConfig): void {
  const current = (): GrokPluginConfig => config
  let lastKey: string | undefined
  let lastGood: ReturnType<typeof resolveAdapterOptions> | undefined

  // Volatile fields are live references, so the values are read on every call.
  // The cache therefore keys on the resolved values, not on the config object's
  // identity — that identity stays stable while its contents change.
  const options = (): ReturnType<typeof resolveAdapterOptions> => {
    const raw = plainConfig(current())
    const key = JSON.stringify(raw)
    if (key === lastKey && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastKey = key
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastKey = key
      ctx.logger.error('dsh-llm-grok: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }

  options()

  const resolveApiKey = async (connection: GrokConnectionOptions): Promise<string> => {
    const ref = credentialRef(connection.apiKeyEnv)
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
  // Reading the policy after registration, never from inside it:
  // `registerAdapter` calls `providerRetryPolicy` synchronously while it is
  // still building the route, so touching `registeredPolicy` before this point
  // is a temporal-dead-zone error.
  let registeredPolicy = options().retryPolicy

  // The retry policy is the one registration-captured fact. DSH has no settings
  // section callback any more; the loader publishes `loader/volatile-update`
  // when a volatile field changes, which is the supported hook. Every other
  // connection fact is read per operation, so it needs no notification.
  ctx.on('loader/volatile-update', () => {
    let policy: GrokConnectionOptions['retryPolicy']
    try {
      policy = options().retryPolicy
    } catch (error) {
      ctx.logger.warn(error)
      return
    }
    if (retryPolicyEquals(policy, registeredPolicy)) return
    // Record the new policy *before* swapping the route: `replace` re-reads it
    // through `providerRetryPolicy`, so a re-entrant call must already observe
    // the new value instead of replacing forever.
    registeredPolicy = policy
    registration.replace([PROVIDER])
  })
}
