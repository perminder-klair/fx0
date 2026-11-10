import { connection } from 'next/server.js'
import { featuredModels } from '../../../lib/featured-models'
import { DEFAULT_MODEL } from '../../../lib/session'
import { selfHostedProvider } from '../../../lib/self-hosted'

export const maxDuration = 60

export interface ModelCatalog {
  models: string[]
  defaultModel: string
  efforts: Record<string, string[]>
  fast: string[]
  // What the picker opens on, after the selected model.
  featured: string[]
}

// libfx's own catalog (/coding-agent/v1/models), as on main: /v1/models also lists
// image models libfx cannot run. It is public and rejects user OAuth tokens, so it
// is fetched without credentials and shared by guests and accounts alike. A
// failure here is never an auth failure: it must not flip the UI to signed out.
let cache: { at: number; catalog: Omit<ModelCatalog, 'defaultModel'> } | null = null

// The same for everyone, so the CDN serves it. This public route skips session
// auth and never sets session cookies. Failures are never cached.
const SHARED = { headers: { 'cache-control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400' } }
const FAILED = { status: 502, headers: { 'cache-control': 'no-store' } }

// A self-hosted provider's models: FX0_PROVIDER_MODELS when set, else the server's own
// /models listing. Chat Completions has no effort or fast mode for the picker to offer.
async function selfHostedCatalog(provider: NonNullable<ReturnType<typeof selfHostedProvider>>, defaultModel: string): Promise<Omit<ModelCatalog, 'defaultModel'>> {
  let listed = provider.models
  if (!listed.length) {
    try {
      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
        cache: 'no-store', signal: AbortSignal.timeout(15_000),
      })
      const payload = response.ok ? await response.json() as { data?: { id?: unknown }[] } : null
      listed = (payload?.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === 'string' && !!id)
    } catch { /* The default model below is still usable. */ }
  }
  const models = [...new Set([defaultModel, ...listed])]
  return { models, efforts: {}, fast: [], featured: models.slice(0, 8) }
}

export async function GET() {
  await connection()
  const defaultModel = process.env.FX0_MODEL ?? DEFAULT_MODEL
  const provider = selfHostedProvider()
  if (provider) {
    if (!cache || Date.now() - cache.at >= 60_000) cache = { at: Date.now(), catalog: await selfHostedCatalog(provider, defaultModel) }
    return Response.json({ ...cache.catalog, defaultModel }, { headers: { 'cache-control': 'no-store' } })
  }
  if (cache && Date.now() - cache.at < 5 * 60_000) {
    return Response.json({ ...cache.catalog, defaultModel }, SHARED)
  }
  try {
    const response = await fetch('https://ai-gateway.vercel.sh/coding-agent/v1/models', {
      cache: 'no-store', signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      return Response.json({ error: 'Unable to load model catalog', models: [], defaultModel, efforts: {}, fast: [], featured: [] }, FAILED)
    }
    const payload = await response.json() as {
      data?: { id?: string; type?: string; released?: number; tags?: string[]; reasoning_options?: { type?: string; values?: string[] }[] }[]
    }
    const catalog = { models: [] as string[], efforts: {} as Record<string, string[]>, fast: [] as string[], featured: [] as string[] }
    const entries: { id: string; released?: number }[] = []
    for (const model of payload.data ?? []) {
      if (typeof model.id !== 'string' || (typeof model.type === 'string' && model.type.toLowerCase() !== 'language')) continue
      entries.push({ id: model.id, released: typeof model.released === 'number' && Number.isFinite(model.released) ? model.released : undefined })
      const values = model.reasoning_options?.find((option) => option.type === 'effort')?.values
      if (values?.length) catalog.efforts[model.id] = values
      if (model.tags?.includes('fast')) catalog.fast.push(model.id)
    }
    // Search preserves this order among equally relevant matches: newest releases first.
    // Models without release metadata follow dated ones; ties are deterministic.
    catalog.models = [...new Set(entries
      .sort((a, b) => (b.released ?? 0) - (a.released ?? 0) || a.id.localeCompare(b.id))
      .map(({ id }) => id))]
    catalog.fast = [...new Set(catalog.fast)]
    catalog.featured = featuredModels(entries)
    cache = { at: Date.now(), catalog }
    return Response.json({ ...catalog, defaultModel }, SHARED)
  } catch {
    return Response.json({ error: 'Unable to load model catalog', models: [], defaultModel, efforts: {}, fast: [], featured: [] }, FAILED)
  }
}
