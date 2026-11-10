// A namespace import: tests replace gateway-session with stubs that lack these helpers.
// @ts-expect-error Node strip-types tests require the source extension.
import * as gateway from './gateway-session.ts'
import type { DesignDraftObserver, GatewayError } from './gateway-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { PROVIDER_PLACEHOLDER_URL, selfHostedProvider } from './self-hosted.ts'

// The transport for self-hosted mode (lib/self-hosted.ts): libfx's Chat Completions
// requests, addressed to a placeholder, go to the configured provider with its key.
// It is gateway-session.ts's counterpart, without a per-user credential to bind.

// libfx sends the body as bytes (a Buffer), not a string.
function requestJson(body: unknown): unknown {
  try {
    if (typeof body === 'string') return JSON.parse(body)
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body as ArrayBuffer))
  } catch { /* libfx validates its own body */ }
  return null
}

// A Chat Completions request carries no session header, so in self-hosted mode each
// chat's instructions end with a line naming its libfx session. The agent's fetch
// reads the line to find the chat, and removes it before the provider sees it.
const SESSION_MARKER = /\n*<!-- fx0-session:([A-Za-z0-9_.-]{1,128}) -->/
export const sessionMarker = (libfxSessionId: string) => `\n\n<!-- fx0-session:${libfxSessionId} -->`

export function takeSessionMarker(init: RequestInit | undefined): { sessionId: string | null; init: RequestInit | undefined } {
  const body = requestJson(init?.body) as { messages?: { role?: unknown; content?: unknown }[] } | null
  if (!Array.isArray(body?.messages)) return { sessionId: null, init }
  let sessionId: string | null = null
  const strip = (text: string) => text.replace(SESSION_MARKER, (_match, id: string) => {
    sessionId = id
    return ''
  })
  for (const message of body.messages) {
    if (message?.role !== 'system' && message?.role !== 'developer') continue
    if (typeof message.content === 'string') message.content = strip(message.content)
    else if (Array.isArray(message.content)) {
      for (const part of message.content as { text?: unknown }[]) if (typeof part?.text === 'string') part.text = strip(part.text)
    }
    if (sessionId) break
  }
  return sessionId ? { sessionId, init: { ...init, body: JSON.stringify(body) } } : { sessionId: null, init }
}

// A publish_design call's arguments as OpenAI streams them: the call's id and name come
// with its first chunk, and later chunks name it only by its index in the response.
function watchDesignDrafts(body: ReadableStream<Uint8Array>, observer: DesignDraftObserver): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const designs = new Map<number, { id: string; push: (delta: string) => void }>()
  let buffer = ''
  const endAll = async () => {
    for (const { id } of designs.values()) await observer.end?.(id)
    designs.clear()
  }
  const parse = async () => {
    let boundary = buffer.indexOf('\n')
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 1)
      boundary = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') { await endAll(); continue }
      let chunk: { error?: unknown; choices?: { finish_reason?: string | null; delta?: { tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] }
      try { chunk = JSON.parse(data) } catch { continue }
      if (chunk.error) {
        await observer.abort?.()
        designs.clear()
        continue
      }
      for (const choice of chunk.choices ?? []) {
        for (const call of choice.delta?.tool_calls ?? []) {
          const index = call.index ?? 0
          if (call.id && call.function?.name === 'publish_design' && !designs.has(index)) {
            const id = call.id
            designs.set(index, { id, push: gateway.htmlFieldExtractor((piece) => observer.delta(id, piece)) })
          }
          if (typeof call.function?.arguments === 'string' && call.function.arguments) designs.get(index)?.push(call.function.arguments)
        }
        if (choice.finish_reason) await endAll()
      }
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          buffer += decoder.decode() + '\n'
          await parse()
          // A stream that ended mid-call never finished its design.
          if (designs.size) await observer.abort?.()
          reader.releaseLock()
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        await parse()
        controller.enqueue(value)
      } catch (error) {
        await observer.abort?.()
        reader.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally {
        reader.releaseLock()
        await observer.abort?.()
      }
    },
  })
}

// libfx refuses a reasoning effort for a custom provider, so fx0 adds the configured
// one to the request itself. A body fx0 cannot read is sent as libfx wrote it.
function withReasoningEffort(init: RequestInit | undefined, effort: string | null): RequestInit | undefined {
  if (!effort) return init
  const body = requestJson(init?.body)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return init
  return { ...init, body: JSON.stringify({ ...body, reasoning_effort: effort }) }
}

export function providerFetch(
  host: { rateLimitStreak?: number; lastGatewayError?: GatewayError | null },
  fetcher: typeof fetch = fetch,
  onDraft?: DesignDraftObserver,
): typeof fetch {
  return async (input, init) => {
    const provider = selfHostedProvider()
    const url = new URL(input instanceof Request ? input.url : String(input))
    // libfx only ever asks for the chat URL; nothing else may carry the key.
    if (!provider || `${url.origin}${url.pathname}` !== `${PROVIDER_PLACEHOLDER_URL}/chat/completions`) {
      return new Response(JSON.stringify({ error: { message: 'Unexpected model provider request' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    if (provider.apiKey) headers.set('authorization', `Bearer ${provider.apiKey}`)
    else headers.delete('authorization')
    const response = await fetcher(`${provider.baseUrl}/chat/completions`, { ...withReasoningEffort(init, provider.reasoningEffort), headers, cache: 'no-store', redirect: 'error' })
    if (response.ok) {
      host.rateLimitStreak = 0
      if (!onDraft || !response.body) return response
      return new Response(watchDesignDrafts(response.body, onDraft), { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    // Error bodies are untrusted and can echo the key: only the scrubbed type, code
    // and message pass through, as for AI Gateway.
    const error = await gateway.readGatewayError(response, provider.apiKey ?? '\u0000')
    host.lastGatewayError = error
    const message = error.message ?? `The model provider returned ${response.status}`
    host.rateLimitStreak = response.status === 429 ? (host.rateLimitStreak ?? 0) + 1 : 0
    // A non-retryable status ends the turn instead of backing off for minutes.
    const status = response.status === 429 && host.rateLimitStreak >= gateway.RATE_LIMIT_ATTEMPTS ? 400 : response.status
    const safeHeaders = new Headers({ 'content-type': 'application/json' })
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter && status === response.status) safeHeaders.set('retry-after', retryAfter)
    return new Response(JSON.stringify({ error: { message, ...(error.type ? { type: error.type } : {}), ...(error.code ? { code: error.code } : {}) } }), {
      status, headers: safeHeaders,
    })
  }
}
