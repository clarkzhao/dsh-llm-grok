import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { grokHeaders, httpErrorCode } from '../src/http.ts'
import { resolveAdapterOptions } from '../src/options.ts'

test('httpErrorCode maps provider statuses onto the harness taxonomy', () => {
  assert.equal(httpErrorCode(401), 'AUTH')
  assert.equal(httpErrorCode(403), 'AUTH')
  assert.equal(httpErrorCode(429), 'RATE_LIMIT')
  assert.equal(httpErrorCode(413), 'INVALID_REQUEST')
  assert.equal(httpErrorCode(400, 'maximum context length exceeded'), CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.equal(httpErrorCode(400, 'bad json'), 'INVALID_REQUEST')
  assert.equal(httpErrorCode(402, 'insufficient quota'), QUOTA_EXCEEDED_CODE)
  assert.equal(httpErrorCode(500), 'SERVER')
  assert.equal(httpErrorCode(418), 'HTTP_418')
})

test('grokHeaders include attribution and subscription identity', () => {
  const headers = grokHeaders('tok', 'grok-4.6')
  assert.equal(headers.Authorization, 'Bearer tok')
  assert.equal(headers['X-XAI-Token-Auth'], 'xai-grok-cli')
  assert.equal(headers['x-grok-client-version'], '1.0.13')
  assert.equal(headers['x-grok-model-override'], 'grok-4.6')
  assert.equal(headers['x-grok-client-identifier'], 'dsh-llm-grok')
  assert.ok(typeof headers['user-agent'] === 'string' && headers['user-agent'].length > 0)
})

test('resolveAdapterOptions fills defaults and detaches the catalog', () => {
  const resolved = resolveAdapterOptions({})
  assert.equal(resolved.baseURL, 'https://cli-chat-proxy.grok.com/v1')
  assert.equal(resolved.proxy, 'http://127.0.0.1:7890')
  assert.equal(resolved.apiKeyEnv, 'GROK_SESSION_TOKEN')
  assert.equal(resolved.models[0]?.id, 'grok-4.6')
  assert.equal(resolved.retryPolicy.mode, 'normal')
  assert.equal(resolveAdapterOptions({ proxy: '' }).proxy, undefined)
})
