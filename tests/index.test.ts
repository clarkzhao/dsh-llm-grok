/**
 * Activation regression tests for the plugin entry.
 *
 * They mount the built plugin the way DSH's loader does — a real Cordis
 * `Context` with the real `llm` service and the exported `name` / `inject` /
 * `Config` / `apply` — because the failure being guarded against lives in the
 * seam between `apply` and `LlmRuntime.registerAdapter`, not in any single
 * helper. `import` targets `lib/`, the artifact DSH actually loads; the
 * `pretest` script rebuilds it first.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Config, apply, inject, name } from '../lib/index.js'

/** Wait for the `llm` service to settle after mounting it. */
async function llmContext(): Promise<Context> {
  const ctx = new Context()
  ctx.plugin(LlmRuntime)
  for (let attempt = 0; attempt < 100 && ctx.get('llm') === undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.notEqual(ctx.get('llm'), undefined, 'the llm service did not mount')
  return ctx
}

/**
 * Mount the plugin exactly as the profile loader does and settle its fiber, so
 * a startup throw surfaces here instead of as a silent "entry did not activate".
 */
async function mount(ctx: Context, config: unknown) {
  const fiber = ctx.plugin({ name, inject, Config, apply, reusable: true }, config)
  assert.notEqual(fiber, undefined, 'the plugin fiber was not created')
  await fiber!.await()
  return fiber!
}

test('the plugin activates and registers the grok route', async () => {
  const ctx = await llmContext()
  await mount(ctx, {})
  assert.deepEqual(
    ctx.llm.listProviders().map(provider => provider.id),
    ['grok'],
  )
})

test('registerAdapter reads the retry policy without tripping the capture order', async () => {
  const ctx = await llmContext()
  // DSH 0.1.7 validates a route by calling `providerInfo` and then
  // `providerRetryPolicy` *during* `registerAdapter`. An explicit non-default
  // policy forces the adapter through the same capture path with values that
  // differ from the schema defaults.
  await mount(ctx, { retryPolicy: { mode: 'always', backoff: { maxDelayMs: 2000 } } })
  assert.deepEqual(
    ctx.llm.listProviders().map(provider => provider.id),
    ['grok'],
  )
})

test('the settings namespace is declared once for the grok provider', async () => {
  const ctx = await llmContext()
  await mount(ctx, {})
  const entries = ctx.llm.listConfigurableProviders()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.provider, 'grok')
  assert.equal(entries[0]?.settingsNs, 'llm-grok')
})

test('the configured catalog reaches the registered adapter', async () => {
  const ctx = await llmContext()
  await mount(ctx, { models: [{ id: 'grok-probe', name: 'Probe' }] })
  assert.deepEqual(
    (await ctx.llm.listModels('grok')).map(model => model.id),
    ['grok-probe'],
  )
  const info = await ctx.llm.resolveModelInfo('grok', 'grok-probe')
  assert.equal(info.id, 'grok-probe')
  assert.equal(info.name, 'Probe')
})
