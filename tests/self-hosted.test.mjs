import assert from 'node:assert/strict'
import test from 'node:test'
import { providerFetch, sessionMarker, takeSessionMarker } from '../lib/provider-session.ts'
import { localSession, PROVIDER_PLACEHOLDER_URL, selfHosted, selfHostedProvider } from '../lib/self-hosted.ts'
import { isAuthenticatedSession } from '../lib/secure-session.ts'
import { assertSameOrigin } from '../lib/auth-protocol.ts'

const CHAT_URL = `${PROVIDER_PLACEHOLDER_URL}/chat/completions`

function withProvider(t, env = {}) {
  const names = ['FX0_PROVIDER_REASONING_EFFORT', 'FX0_PROVIDER_BASE_URL', 'FX0_PROVIDER_API_KEY', 'FX0_PROVIDER_MODELS', 'FX0_MODEL', 'NODE_ENV']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  Object.assign(process.env, { FX0_PROVIDER_BASE_URL: 'http://provider.internal:4000/v1/', FX0_PROVIDER_API_KEY: 'sk-provider-key', ...env })
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name] })
}

const sse = (chunks) => new Response(chunks.map((chunk) => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } })
const toolChunk = (call, finish) => ({ choices: [{ index: 0, delta: call ? { tool_calls: [call] } : {}, ...(finish ? { finish_reason: finish } : {}) }] })

test('self-hosted mode is off without a provider URL, and reads its settings when on', (t) => {
  withProvider(t, { FX0_PROVIDER_MODELS: ' a , b,' })
  assert.equal(selfHosted(), true)
  assert.deepEqual({ ...selfHostedProvider(), contextWindow: null, maxOutputTokens: null }, {
    baseUrl: 'http://provider.internal:4000/v1', apiKey: 'sk-provider-key', models: ['a', 'b'], contextWindow: null, maxOutputTokens: null, vision: false, reasoningEffort: null,
  })
  delete process.env.FX0_PROVIDER_BASE_URL
  assert.equal(selfHosted(), false)
  assert.equal(selfHostedProvider(), null)
  process.env.FX0_PROVIDER_BASE_URL = 'http://user:pass@provider.internal/v1'
  assert.throws(() => selfHostedProvider(), /without credentials/)
})

test('the local account is a complete session, and plain-HTTP APP_URL is trusted only when self-hosted', (t) => {
  withProvider(t, { NODE_ENV: 'production' })
  assert.equal(isAuthenticatedSession(localSession()), true)
  assert.match(localSession().teamId, /^team_/)
  const request = { headers: new Headers({ origin: 'http://fx0.lan:3000' }) }
  assert.doesNotThrow(() => assertSameOrigin(request, 'http://fx0.lan:3000'))
  assert.throws(() => assertSameOrigin({ headers: new Headers({ origin: 'http://evil.lan' }) }, 'http://fx0.lan:3000'), /Cross-origin/)
  delete process.env.FX0_PROVIDER_BASE_URL
  assert.throws(() => assertSameOrigin(request, 'http://fx0.lan:3000'), /trusted HTTP\(S\) origin/)
})

test('the session marker names the chat to fx0 and never reaches the provider', () => {
  const body = { model: 'm', messages: [{ role: 'system', content: `Be brief.${sessionMarker('wrun_ABC123')}` }, { role: 'user', content: 'hi' }] }
  const taken = takeSessionMarker({ method: 'POST', body: Buffer.from(JSON.stringify(body)) })
  assert.equal(taken.sessionId, 'wrun_ABC123')
  assert.deepEqual(JSON.parse(taken.init.body).messages[0], { role: 'system', content: 'Be brief.' })
  assert.equal(taken.init.method, 'POST')
  // A request without one (a subagent's, or libfx's own) passes through untouched.
  const plain = { method: 'POST', body: JSON.stringify({ messages: [{ role: 'system', content: 'Be brief.' }] }) }
  assert.deepEqual(takeSessionMarker(plain), { sessionId: null, init: plain })
  // A marker a user typed into a message is not the chat's.
  const typed = { body: JSON.stringify({ messages: [{ role: 'user', content: sessionMarker('wrun_other') }] }) }
  assert.equal(takeSessionMarker(typed).sessionId, null)
})

test('requests go to the configured provider with its key, and nowhere else', async (t) => {
  withProvider(t)
  const calls = []
  const request = providerFetch({}, async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ ok: true }) })
  assert.equal((await request(CHAT_URL, { method: 'POST', body: '{}', headers: { authorization: 'Bearer from-libfx', 'content-type': 'application/json' } })).status, 200)
  assert.equal(calls[0].url, 'http://provider.internal:4000/v1/chat/completions')
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer sk-provider-key')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal((await request('https://elsewhere.example/v1/chat/completions', { method: 'POST', body: '{}' })).status, 400)
  assert.equal((await request(`${PROVIDER_PLACEHOLDER_URL}/models`)).status, 400)
  assert.equal(calls.length, 1)
  delete process.env.FX0_PROVIDER_API_KEY
  await request(CHAT_URL, { method: 'POST', body: '{}', headers: { authorization: 'Bearer from-libfx' } })
  assert.equal(calls[1].init.headers.has('authorization'), false)
})

test('a provider error keeps its message but not the key, and repeated 429s end the turn', async (t) => {
  withProvider(t)
  const host = {}
  const failing = providerFetch(host, async () => Response.json({ error: { message: 'bad key sk-provider-key', type: 'auth', code: 'invalid_api_key' } }, { status: 401 }))
  const refused = await failing(CHAT_URL, { method: 'POST', body: '{}' })
  assert.equal(refused.status, 401)
  assert.deepEqual(await refused.json(), { error: { message: 'bad key [redacted]', type: 'auth', code: 'invalid_api_key' } })
  const limited = providerFetch(host, async () => Response.json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } }))
  assert.equal((await limited(CHAT_URL, { method: 'POST', body: '{}' })).status, 429)
  assert.equal((await limited(CHAT_URL, { method: 'POST', body: '{}' })).status, 429)
  const last = await limited(CHAT_URL, { method: 'POST', body: '{}' })
  assert.equal(last.status, 400)
  assert.deepEqual(await last.json(), { error: { message: 'slow down' } })
})

test('a streamed publish_design call is observed as it is written; other tools are not', async (t) => {
  withProvider(t)
  const seen = []
  const observer = { delta: (id, chunk) => seen.push(['delta', id, chunk]), end: (id) => { seen.push(['end', id]) }, abort: () => { seen.push(['abort']) } }
  const args = JSON.stringify({ html: '<h1>Hi "you"</h1>\n' })
  const response = await providerFetch({}, async () => sse([
    toolChunk({ index: 0, id: 'call_read', type: 'function', function: { name: 'read_design', arguments: '{"html":"no"}' } }),
    toolChunk({ index: 1, id: 'call_pub', type: 'function', function: { name: 'publish_design', arguments: '' } }),
    toolChunk({ index: 1, function: { arguments: args.slice(0, 14) } }),
    toolChunk({ index: 1, function: { arguments: args.slice(14) } }),
    toolChunk(null, 'tool_calls'),
    '[DONE]',
  ]), observer)(CHAT_URL, { method: 'POST', body: '{}' })
  const text = await response.text()
  assert.match(text, /call_pub/)
  assert.equal(seen.filter(([kind]) => kind === 'delta').map(([, id, chunk]) => { assert.equal(id, 'call_pub'); return chunk }).join(''), '<h1>Hi "you"</h1>\n')
  assert.deepEqual(seen.filter(([kind]) => kind !== 'delta'), [['end', 'call_pub']])
})

test('a stream that ends mid-design aborts its draft', async (t) => {
  withProvider(t)
  const seen = []
  const observer = { delta: () => {}, end: () => { seen.push('end') }, abort: () => { seen.push('abort') } }
  const response = await providerFetch({}, async () => sse([
    toolChunk({ index: 0, id: 'call_pub', type: 'function', function: { name: 'publish_design', arguments: '{"html":"<p>' } }),
  ]), observer)(CHAT_URL, { method: 'POST', body: '{}' })
  await response.text()
  assert.deepEqual(seen, ['abort'])
})

test('the configured reasoning effort is added to each provider request, and only then', async (t) => {
  withProvider(t)
  const sent = []
  const fetcher = async (_url, init) => { sent.push(JSON.parse(init.body)); return Response.json({}) }
  const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }))
  await providerFetch({}, fetcher)(CHAT_URL, { method: 'POST', body })
  process.env.FX0_PROVIDER_REASONING_EFFORT = ' Low '
  await providerFetch({}, fetcher)(CHAT_URL, { method: 'POST', body })
  assert.deepEqual(sent, [{ model: 'm', messages: [] }, { model: 'm', messages: [], reasoning_effort: 'low' }])
  process.env.FX0_PROVIDER_REASONING_EFFORT = 'low; drop'
  assert.throws(() => selfHostedProvider(), /single word/)
})
