import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { del, get, list, put } from '@vercel/blob'
import {
  MAX_CHAT_ASSETS, MAX_DAILY_ASSETS, finishDesignAssetCleanup, pendingDesignAssetCleanups,
  queueDesignAssetCleanup, readDesignAssets, recordDesignAssets, reserveDesignAssets,
  type DesignAssetCleanup,
} from './journal'
import type { PromptImage } from './prompt-images'

// Images a message attached, kept in fx0's private Blob store so a design can show them
// (as fx0-asset:<handle>). The chat's manifest in Redis is the access check: only a
// handle recorded for the chat is ever read, and deleting the chat removes it.

export interface DesignAssetStore {
  put: typeof put
  get: typeof get
  del: typeof del
  list: typeof list
}

// @vercel/blob carries its own undici, jose and the Vercel OIDC client (~0.6 MB), so it
// loads on the first Blob call: routes that import this module cold-start without it.
let blob: Promise<typeof import('@vercel/blob')> | undefined
const loadBlob = () => blob ??= import('@vercel/blob')
// FX0_ASSETS_DIR keeps the images in a local directory instead (self-hosting, where
// there is no Blob store): one file per pathname, which is `chats/<chat>/<handle>`.
function fileStore(root: string): DesignAssetStore {
  const file = (name: string) => {
    const resolved = path.resolve(root, name)
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid asset path')
    return resolved
  }
  const store = {
    async put(name: string, body: Buffer) {
      await mkdir(path.dirname(file(name)), { recursive: true })
      await writeFile(file(name), body)
      return { pathname: name }
    },
    async get(name: string) {
      try {
        const bytes = await readFile(file(name))
        return { statusCode: 200, stream: new Blob([new Uint8Array(bytes)]).stream() }
      } catch { return null }
    },
    async del(names: string | string[]) {
      await Promise.all([names].flat().map((name) => rm(file(name), { force: true })))
    },
    async list({ prefix = '' }: { prefix?: string } = {}) {
      const names = await readdir(file(prefix)).catch(() => [] as string[])
      return { blobs: names.map((name) => ({ pathname: `${prefix}${name}` })), hasMore: false }
    },
  }
  // Only the calls and fields this module uses.
  return store as unknown as DesignAssetStore
}

let files: DesignAssetStore | undefined
async function backend(): Promise<DesignAssetStore> {
  const root = process.env.FX0_ASSETS_DIR?.trim()
  return root ? files ??= fileStore(root) : loadBlob()
}

const BLOB: DesignAssetStore = {
  put: async (...args) => (await backend()).put(...args),
  get: async (...args) => (await backend()).get(...args),
  del: async (...args) => (await backend()).del(...args),
  list: async (...args) => (await backend()).list(...args),
}

/** A message that would pass the per-chat or per-day image cap. Nothing was stored. */
export class DesignAssetLimitError extends Error {
  constructor(limit: 'chat' | 'daily') {
    super(limit === 'chat'
      ? `This chat already has its ${MAX_CHAT_ASSETS} attached images. Start a new design to attach more.`
      : `You can attach up to ${MAX_DAILY_ASSETS} images a day. Try again tomorrow.`)
  }
}

const pathname = (sessionId: string, handle: string) => `chats/${sessionId}/${handle}`

export interface PendingDesignAssets {
  /** Usable at once, in order: what the model is told. */
  handles: string[]
  /** Settles when the files and the chat's manifest are in place; rejects after cleaning up. */
  stored: Promise<void>
}

/**
 * Takes the chat's and the user's caps for a message's images and starts storing them,
 * so the prompt can go to libfx while the files upload. The handles are final now; a
 * design can name them once `stored` settles. Throws DesignAssetLimitError before
 * anything is stored when a cap would be passed.
 */
export async function startDesignAssets(sessionId: string, userId: string, images: PromptImage[], store = BLOB): Promise<PendingDesignAssets> {
  if (!images.length) return { handles: [], stored: Promise.resolve() }
  const reservedAt = Date.now()
  const reserved = await reserveDesignAssets(sessionId, userId, images.length, reservedAt)
  if (reserved !== 'ok') throw new DesignAssetLimitError(reserved)
  const assets = images.map((image) => ({
    handle: randomBytes(18).toString('base64url'),
    mimeType: image.mimeType,
    bytes: Buffer.from(image.data, 'base64'),
  }))
  const handles = assets.map(({ handle }) => handle)
  const stored = (async () => {
    try {
      // Wait for every put before rolling back: a sibling can still be in flight when
      // another fails. Delete every attempted path, including an ambiguous timeout.
      const results = await Promise.allSettled(assets.map(({ handle, mimeType, bytes }) =>
        store.put(pathname(sessionId, handle), bytes, { access: 'private', contentType: mimeType, addRandomSuffix: false })))
      if (results.some((result) => result.status === 'rejected')) throw new Error('Unable to store the attached images')
      await recordDesignAssets(sessionId, assets.map(({ handle, mimeType, bytes }) => ({ handle, mimeType, bytes: bytes.length })))
    } catch (error) {
      const cleanup = { sessionId, userId, handles, reservedAt }
      try {
        await queueDesignAssetCleanup(cleanup)
      } catch {
        console.error('[fx0] asset cleanup persistence failed', { sessionId })
      }
      try {
        await store.del(handles.map((handle) => pathname(sessionId, handle)))
        // Complete atomically even if the enqueue response was lost. The receipt
        // prevents a delayed enqueue or another worker from refunding this twice.
        await finishDesignAssetCleanup(cleanup)
      } catch {
        console.error('[fx0] asset cleanup pending', { sessionId })
      }
      throw error
    }
  })()
  // The caller awaits it; this only keeps an early failure from being unhandled.
  stored.catch(() => {})
  return { handles, stored }
}

/** Stores a message's images, all or none, within the caps. Returns their handles in order. */
export async function storeDesignAssets(sessionId: string, userId: string, images: PromptImage[], store = BLOB): Promise<string[]> {
  const pending = await startDesignAssets(sessionId, userId, images, store)
  await pending.stored
  return pending.handles
}

/** Retry failed rollbacks without losing their records or refunding quota twice. */
export async function retryDesignAssetCleanup(store = BLOB): Promise<void> {
  const pending = await pendingDesignAssetCleanups()
  await Promise.all(pending.map(async (cleanup: DesignAssetCleanup) => {
    try {
      await store.del(cleanup.handles.map((handle) => pathname(cleanup.sessionId, handle)))
      await finishDesignAssetCleanup(cleanup)
    } catch {
      console.error('[fx0] asset cleanup pending', { sessionId: cleanup.sessionId })
    }
  }))
}

/** One of the chat's images, or null when the chat never received that handle. */
export async function readDesignAsset(sessionId: string, handle: string, store = BLOB): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const asset = (await readDesignAssets(sessionId, [handle])).get(handle)
  if (!asset) return null
  const result = await store.get(pathname(sessionId, handle), { access: 'private' })
  if (!result || result.statusCode !== 200) return null
  return { bytes: Buffer.from(await new Response(result.stream).arrayBuffer()), mimeType: asset.mimeType }
}

/** Removes every stored image of a deleted chat. */
export async function deleteDesignAssets(sessionId: string, store = BLOB): Promise<void> {
  // Listed whole before deleting: deleting while paging would move the cursor past files.
  const pathnames: string[] = []
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix: `chats/${sessionId}/`, cursor, limit: 1000 })
    pathnames.push(...page.blobs.map((blob) => blob.pathname))
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  for (let index = 0; index < pathnames.length; index += 1000) await store.del(pathnames.slice(index, index + 1000))
}
