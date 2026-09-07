/**
 * Subscription request headers and HTTP error mapping. Isolated so unit tests
 * can import them without loading the undici adapter (Node's strip-only
 * loader cannot follow `.js` specifiers into `src/`).
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'

/** Match the installed grok CLI so cli-chat-proxy version-gating stays happy. */
export const GROK_CLIENT_VERSION = '1.0.13'

export function grokHeaders(apiKey: string, model: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${apiKey}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-authenticateresponse': 'authenticate-response',
    'x-grok-client-version': GROK_CLIENT_VERSION,
    'x-grok-client-identifier': 'dsh-llm-grok',
    'x-grok-model-override': model,
    ...attributionHeaders(),
  }
}

export function sanitizeErrorBody(body: string): string {
  return body
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/(api[_-]?key|token|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi, '$1=<redacted>')
    .slice(0, 300)
}

export function httpErrorCode(status: number, detail = ''): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}
