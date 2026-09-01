/**
 * IndexedDB persistence via idb: books, per-book voice config, progress, settings.
 * Book bodies (sentences/paragraphs) can be several MB — stored in a separate store
 * so the library listing stays fast.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Book, BookMeta, Progress, ReaderSettings, VoiceConfig } from '../types'

interface KokoroDB extends DBSchema {
  books: { key: string; value: BookMeta; indexes: { addedAt: number } }
  bodies: { key: string; value: Pick<Book, 'id' | 'chapters' | 'paragraphs' | 'sentences'> }
  voices: { key: string; value: VoiceConfig & { bookId: string } }
  progress: { key: string; value: Progress }
  settings: { key: string; value: { key: string; value: unknown } }
}

let dbPromise: Promise<IDBPDatabase<KokoroDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<KokoroDB>('kokoro-reader', 1, {
      upgrade(d) {
        const books = d.createObjectStore('books', { keyPath: 'id' })
        books.createIndex('addedAt', 'addedAt')
        d.createObjectStore('bodies', { keyPath: 'id' })
        d.createObjectStore('voices', { keyPath: 'bookId' })
        d.createObjectStore('progress', { keyPath: 'bookId' })
        d.createObjectStore('settings', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

export async function saveBook(book: Book): Promise<void> {
  const d = await db()
  const { chapters, paragraphs, sentences, ...meta } = book
  const tx = d.transaction(['books', 'bodies'], 'readwrite')
  await Promise.all([
    tx.objectStore('books').put(meta),
    tx.objectStore('bodies').put({ id: book.id, chapters, paragraphs, sentences }),
    tx.done,
  ])
}

export async function listBooks(): Promise<BookMeta[]> {
  const d = await db()
  const all = await d.getAllFromIndex('books', 'addedAt')
  return all.reverse()
}

export async function loadBook(id: string): Promise<Book | undefined> {
  const d = await db()
  const [meta, body] = await Promise.all([d.get('books', id), d.get('bodies', id)])
  if (!meta || !body) return undefined
  return { ...meta, ...body }
}

export async function deleteBook(id: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(['books', 'bodies', 'voices', 'progress'], 'readwrite')
  await Promise.all([
    tx.objectStore('books').delete(id),
    tx.objectStore('bodies').delete(id),
    tx.objectStore('voices').delete(id),
    tx.objectStore('progress').delete(id),
    tx.done,
  ])
}

export async function getVoices(bookId: string): Promise<VoiceConfig | undefined> {
  const v = await (await db()).get('voices', bookId)
  if (!v) return undefined
  const { bookId: _b, ...cfg } = v
  void _b
  return cfg
}
export async function setVoices(bookId: string, cfg: VoiceConfig) {
  await (await db()).put('voices', { ...cfg, bookId })
}

export async function getProgress(bookId: string): Promise<Progress | undefined> {
  return (await db()).get('progress', bookId)
}
export async function setProgress(bookId: string, sentenceId: number) {
  await (await db()).put('progress', { bookId, sentenceId, updatedAt: Date.now() })
}
export async function getAllProgress(): Promise<Record<string, Progress>> {
  const all = await (await db()).getAll('progress')
  return Object.fromEntries(all.map(p => [p.bookId, p]))
}

const DEFAULT_SETTINGS: ReaderSettings = { theme: 'black', font: 'literata', fontSize: 19, lineHeight: 1.65 }
export async function getSettings(): Promise<ReaderSettings> {
  const s = await (await db()).get('settings', 'reader')
  return { ...DEFAULT_SETTINGS, ...((s?.value as Partial<ReaderSettings>) ?? {}) }
}
export async function setSettings(s: ReaderSettings) {
  await (await db()).put('settings', { key: 'reader', value: s })
}

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const e = await navigator.storage.estimate()
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
}

/** Ask iOS/Safari not to evict our model + books under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false } catch { return false }
}
