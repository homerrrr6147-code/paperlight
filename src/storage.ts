import { EXTRACTOR_VERSION } from './pdf'
import type { ExtractedPage } from './pdf'

export type Paper = {
  id: string // SHA-256 of this file version
  name: string
  title: string
  size: number
  pages: number
  addedAt: number
  lastReadAt: number
  lastPage: number
  starred: boolean
  tags?: string[]
}
export type PageTranslation = {
  paperId: string
  page: number
  sourceHash: string
  textByBlock: Record<string, string>
  editedAt: number
  origin: 'manual' | 'api'
  model?: string
  manualBlockIds?: string[]
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }
}
export type FullTranslationJob = {
  paperId: string
  totalPages: number
  completedPages: number[]
  skippedPages: number[]
  status: 'running' | 'paused' | 'failed' | 'complete'
  baseUrl: string
  model: string
  updatedAt: number
  currentPage?: number
  lastError?: string
}

const DB_NAME = 'paperlight-prototype-v1'
const DB_VERSION = 3

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, DB_VERSION)
    opening.onupgradeneeded = event => {
      const database = opening.result
      if (event.oldVersion < 1) {
        database.createObjectStore('papers', { keyPath: 'id' })
        database.createObjectStore('files')
        database.createObjectStore('pages')
        database.createObjectStore('translations')
      }
      if (event.oldVersion < 2) database.createObjectStore('translation_versions')
      if (event.oldVersion < 3) database.createObjectStore('translation_jobs', { keyPath: 'paperId' })
    }
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
}

async function transaction<T>(store: string, mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(store, mode)
      const req = action(tx.objectStore(store))
      let result: T
      req.onsuccess = () => { result = req.result }
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { database.close() }
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function listPapers(): Promise<Paper[]> {
  const papers = await transaction<Paper[]>('papers', 'readonly', store => store.getAll())
  return papers.sort((a, b) => b.lastReadAt - a.lastReadAt || b.addedAt - a.addedAt)
}

export async function getPaper(id: string): Promise<Paper | undefined> {
  return transaction('papers', 'readonly', store => store.get(id))
}

export async function savePaper(paper: Paper): Promise<void> {
  await transaction('papers', 'readwrite', store => store.put(paper))
}

export function normalizeTags(input: string | string[]): string[] {
  const source = Array.isArray(input) ? input : input.split(/[,，;；\n]/)
  const seen = new Set<string>()
  const tags: string[] = []
  for (const value of source) {
    const tag = value.trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 30)
    const key = tag.toLocaleLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length === 12) break
  }
  return tags
}

export async function updatePaperMetadata(id: string, title: string, tags: string | string[]): Promise<Paper> {
  const current = await getPaper(id)
  if (!current) throw new Error('找不到论文条目')
  const cleanTitle = title.trim().replace(/\s+/g, ' ').slice(0, 200)
  if (!cleanTitle) throw new Error('显示名称不能为空')
  const updated = { ...current, title: cleanTitle, tags: normalizeTags(tags) }
  await savePaper(updated)
  return updated
}

export async function importPaper(file: File, pages: number, bytes: ArrayBuffer): Promise<{ paper: Paper; duplicate: boolean }> {
  const id = await sha256(bytes)
  const existing = await getPaper(id)
  if (existing) return { paper: existing, duplicate: true }
  const paper: Paper = {
    id, name: file.name, title: file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
    size: file.size, pages, addedAt: Date.now(), lastReadAt: Date.now(), lastPage: 1, starred: false, tags: [],
  }
  const database = await db()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['papers', 'files'], 'readwrite')
      tx.objectStore('papers').put(paper)
      tx.objectStore('files').put(new Blob([bytes], { type: 'application/pdf' }), id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { database.close() }
  return { paper, duplicate: false }
}

export async function getPdfBytes(id: string): Promise<ArrayBuffer> {
  const blob = await transaction<Blob | undefined>('files', 'readonly', store => store.get(id))
  if (!blob) throw new Error('找不到论文附件；资料库可能不完整。')
  return blob.arrayBuffer()
}

function pageKey(id: string, page: number): string { return `${id}:${page}` }

export async function getPage(id: string, page: number): Promise<ExtractedPage | undefined> {
  const result = await transaction<ExtractedPage | undefined>('pages', 'readonly', store => store.get(pageKey(id, page)))
  return result?.extractorVersion === EXTRACTOR_VERSION ? result : undefined
}

export async function savePage(data: ExtractedPage): Promise<void> {
  const sourceHash = await sha256(new TextEncoder().encode(
    data.blocks.map(block => `${block.id}:${block.text}`).join('\n'),
  ).buffer as ArrayBuffer)
  const database = await db()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['pages', 'translations', 'translation_versions', 'translation_jobs'], 'readwrite')
      const key = pageKey(data.paperId, data.page)
      const translations = tx.objectStore('translations')
      const request = translations.get(key)
      request.onsuccess = () => {
        const old = request.result as PageTranslation | undefined
        if (old && old.sourceHash !== sourceHash) {
          // Archive and detach as one transaction: old block IDs cannot be safely
          // assigned to a new reading order, especially for manual corrections.
          tx.objectStore('translation_versions').put(old, `${key}:${old.sourceHash}`)
          translations.delete(key)
        }
      }
      const previous = tx.objectStore('pages').get(key)
      previous.onsuccess = () => {
        const oldPage = previous.result as ExtractedPage | undefined
        if (oldPage && oldPage.extractorVersion !== data.extractorVersion) {
          const jobs = tx.objectStore('translation_jobs')
          const jobRequest = jobs.get(data.paperId)
          jobRequest.onsuccess = () => {
            const job = jobRequest.result as FullTranslationJob | undefined
            if (job) jobs.put({ ...job,
              completedPages: job.completedPages.filter(page => page !== data.page),
              skippedPages: job.skippedPages.filter(page => page !== data.page),
              status: job.status === 'running' ? 'running' : 'paused',
              lastError: undefined, updatedAt: Date.now(),
            })
          }
        }
        tx.objectStore('pages').put(data, key)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('保存新版解析失败'))
    })
  } finally { database.close() }
}

export async function getTranslation(id: string, page: number): Promise<PageTranslation | undefined> {
  return transaction('translations', 'readonly', store => store.get(pageKey(id, page)))
}

export async function getFullTranslationJob(paperId: string): Promise<FullTranslationJob | undefined> {
  return transaction('translation_jobs', 'readonly', store => store.get(paperId))
}

export async function saveFullTranslationJob(job: FullTranslationJob): Promise<void> {
  await transaction('translation_jobs', 'readwrite', store => store.put(job))
}

export async function updateFullTranslationJob(
  paperId: string, update: (current: FullTranslationJob) => FullTranslationJob,
): Promise<FullTranslationJob> {
  const database = await db()
  try {
    return await new Promise<FullTranslationJob>((resolve, reject) => {
      const tx = database.transaction('translation_jobs', 'readwrite')
      const store = tx.objectStore('translation_jobs')
      const request = store.get(paperId)
      let saved: FullTranslationJob
      request.onsuccess = () => {
        const current = request.result as FullTranslationJob | undefined
        if (!current) { tx.abort(); return }
        saved = update(current)
        store.put(saved)
      }
      tx.oncomplete = () => resolve(saved)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('全文翻译任务不存在'))
    })
  } finally { database.close() }
}

export async function getTranslationHistory(id: string, page: number): Promise<PageTranslation[]> {
  const versions = await transaction<PageTranslation[]>('translation_versions', 'readonly', store => store.getAll())
  return versions.filter(item => item.paperId === id && item.page === page)
    .sort((a, b) => b.editedAt - a.editedAt)
}

async function updateTranslation(
  paperId: string, page: number, sourceHash: string,
  update: (current?: PageTranslation) => PageTranslation,
  archiveCurrent?: (current: PageTranslation) => boolean,
): Promise<PageTranslation> {
  const database = await db()
  try {
    return await new Promise<PageTranslation>((resolve, reject) => {
      const tx = database.transaction(['translations', 'translation_versions'], 'readwrite')
      const key = pageKey(paperId, page)
      const current = tx.objectStore('translations').get(key)
      let saved: PageTranslation
      current.onsuccess = () => {
        const old = current.result as PageTranslation | undefined
        if (old && old.sourceHash !== sourceHash) {
          tx.objectStore('translation_versions').put(old, `${key}:${old.sourceHash}`)
        } else if (old && archiveCurrent?.(old)) {
          tx.objectStore('translation_versions').put(old,
            `${key}:${sourceHash}:retry:${Date.now()}:${crypto.randomUUID()}`)
        }
        saved = update(old?.sourceHash === sourceHash ? old : undefined)
        tx.objectStore('translations').put(saved, key)
      }
      tx.oncomplete = () => resolve(saved)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { database.close() }
}

export async function saveTranslation(data: PageTranslation, overwriteBlockId?: string): Promise<PageTranslation> {
  return updateTranslation(data.paperId, data.page, data.sourceHash, current => {
    if (data.origin !== 'api' || !current) return data
    const textByBlock = { ...current.textByBlock, ...data.textByBlock }
    const manualBlockIds = [...new Set([...(current.manualBlockIds || []), ...(data.manualBlockIds || [])])]
    for (const id of current.manualBlockIds || []) {
      if (id in current.textByBlock) textByBlock[id] = current.textByBlock[id]
    }
    return { ...data, textByBlock, manualBlockIds }
  }, current => !!overwriteBlockId && overwriteBlockId in data.textByBlock
    && !!current.textByBlock[overwriteBlockId]
    && current.textByBlock[overwriteBlockId] !== data.textByBlock[overwriteBlockId]
    && !current.manualBlockIds?.includes(overwriteBlockId))
}

export async function saveManualBlock(
  paperId: string, page: number, sourceHash: string, blockId: string, text: string,
): Promise<PageTranslation> {
  return updateTranslation(paperId, page, sourceHash, current => ({
    paperId, page, sourceHash,
    textByBlock: { ...current?.textByBlock, [blockId]: text },
    editedAt: Date.now(), origin: 'manual',
    manualBlockIds: [...new Set([...(current?.manualBlockIds || []), blockId])],
    model: current?.model, usage: current?.usage,
  }))
}
