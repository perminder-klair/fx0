// Self-hosted mode: fx0 off Vercel, on your own OpenAI-compatible provider, with no
// sign-in. Setting FX0_PROVIDER_BASE_URL turns it on. Everyone who can reach the app
// is then one local user, and every model request is paid with FX0_PROVIDER_API_KEY,
// so put the app behind your own access control before exposing it to a network.

export interface SelfHostedProvider {
  /** `{baseUrl}/chat/completions` and `{baseUrl}/models`, with no trailing slash. */
  baseUrl: string
  apiKey: string | null
  /** The picker's models, when the server's own /models listing should not be used. */
  models: string[]
  contextWindow: number | null
  maxOutputTokens: number | null
  vision: boolean
  /** Sent as `reasoning_effort` with every request, when set. */
  reasoningEffort: string | null
}

export function selfHosted(): boolean {
  return !!process.env.FX0_PROVIDER_BASE_URL?.trim()
}

function positiveInteger(value: string | undefined): number | null {
  const number = Number(value)
  return value?.trim() && Number.isSafeInteger(number) && number > 0 ? number : null
}

// Providers name their own levels (low, medium, high, xhigh, none, ...), so any single
// word passes and the provider rejects one it does not know.
function reasoningEffort(value: string | undefined): string | null {
  const effort = value?.trim().toLowerCase()
  if (!effort) return null
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) throw new Error('FX0_PROVIDER_REASONING_EFFORT must be a single word, such as low')
  return effort
}

export function selfHostedProvider(): SelfHostedProvider | null {
  const raw = process.env.FX0_PROVIDER_BASE_URL?.trim()
  if (!raw) return null
  const url = new URL(raw)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('FX0_PROVIDER_BASE_URL must be an http(s) URL without credentials, query or fragment')
  }
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    apiKey: process.env.FX0_PROVIDER_API_KEY?.trim() || null,
    models: (process.env.FX0_PROVIDER_MODELS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
    contextWindow: positiveInteger(process.env.FX0_PROVIDER_CONTEXT_WINDOW),
    maxOutputTokens: positiveInteger(process.env.FX0_PROVIDER_MAX_OUTPUT_TOKENS),
    vision: process.env.FX0_PROVIDER_VISION === '1',
    reasoningEffort: reasoningEffort(process.env.FX0_PROVIDER_REASONING_EFFORT),
  }
}

/** The model new chats start on. Self-hosted mode has no built-in default. */
export function selfHostedModel(): string {
  const model = process.env.FX0_MODEL?.trim()
  if (!model) throw new Error('Set FX0_MODEL to a model your provider serves')
  return model
}

// libfx only accepts a custom provider over HTTPS, or HTTP on localhost, which rules
// out a provider on the Docker network or the host. So libfx is given this fixed
// address, and fx0's fetch sends each request to the real one with the key. The key
// never reaches libfx or a saved session.
export const PROVIDER_PLACEHOLDER_URL = 'http://localhost/fx0-provider/v1'
export const PROVIDER_NAME = 'selfhosted'

// The one local account. It has the shape of a signed-in session so chat ownership,
// history and the per-turn records work unchanged; none of its values is a secret.
export const LOCAL_USER_ID = 'local'
export const LOCAL_TEAM_ID = 'team_local'
const LOCAL_LOGIN_ID = '0'.repeat(32)
const LOCAL_SESSION_MS = 30 * 24 * 3600_000

export function localSession() {
  return {
    loginId: LOCAL_LOGIN_ID,
    loginAt: 1,
    userId: LOCAL_USER_ID,
    email: 'local@localhost',
    name: process.env.FX0_LOCAL_USER_NAME?.trim() || 'You',
    accessToken: 'self-hosted',
    expiresAt: Date.now() + LOCAL_SESSION_MS,
    teamId: LOCAL_TEAM_ID,
    teamSlug: 'local',
    isLoggedIn: true,
    local: true as const,
  }
}
