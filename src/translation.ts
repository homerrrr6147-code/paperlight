import { invoke } from '@tauri-apps/api/core'
import { INVALID_TEXT_CHARS } from './pdf'
import type { ExtractedBlock, ExtractedPage } from './pdf'
import { getTranslation, saveTranslation, sha256 } from './storage'
import type { PageTranslation, Paper } from './storage'

type TranslationResult = {
  translations: { id: string; text: string }[]
  model: string
  usage?: PageTranslation['usage']
  validationError?: string
}

export type PageTranslationOutcome = {
  state: 'translated' | 'cached' | 'skipped' | 'stale' | 'paused'
  translation?: PageTranslation
}

export const reliableCaption = (block: ExtractedBlock) => block.kind === 'caption'
  && block.text.length >= 20 && !INVALID_TEXT_CHARS.test(block.text)
export const canAutoTranslate = (page: ExtractedPage) => page.quality === 'ok'
  || (page.quality === 'review' && page.blocks.some(reliableCaption))

function looksLikeTable(block: ExtractedBlock): boolean {
  if (block.kind === 'caption') return false
  const tokens = block.text.match(/\S+/g) || []
  return tokens.length >= 18 && tokens.filter(token => /\d/.test(token)).length / tokens.length > 0.34
}

export function canTranslateBlock(page: ExtractedPage, block: ExtractedBlock): boolean {
  return (page.quality === 'ok' || reliableCaption(block))
    && block.kind !== 'reference' && block.kind !== 'equation' && !looksLikeTable(block)
}

export function referenceOnlyPages(pages: ExtractedPage[]): Set<number> {
  const skipped = new Set<number>()
  let insideReferences = false
  for (const page of pages) {
    const hasAppendix = page.blocks.some(block => /^(?:Appendix|Supplementary(?: Material| Information)?)\b/i.test(block.text))
    const hasReferences = page.blocks.some(block => /^(?:References|Bibliography)\b/i.test(block.text))
    if (hasAppendix) insideReferences = false
    if (insideReferences && !hasAppendix) skipped.add(page.page)
    if (hasReferences) insideReferences = true
  }
  return skipped
}

function makeBatches(blocks: ExtractedBlock[]): ExtractedBlock[][] {
  const batches: ExtractedBlock[][] = []
  let batch: ExtractedBlock[] = []
  let words = 0
  for (const block of blocks) {
    const count = block.text.trim().split(/\s+/).length
    if (batch.length && (words + count > 800 || batch.length >= 60)) {
      batches.push(batch); batch = []; words = 0
    }
    batch.push(block); words += count
  }
  if (batch.length) batches.push(batch)
  return batches
}

function addUsage(previous: PageTranslation['usage'], next: PageTranslation['usage']): PageTranslation['usage'] {
  if (!next) return previous
  return {
    prompt_tokens: (previous?.prompt_tokens || 0) + next.prompt_tokens,
    completion_tokens: (previous?.completion_tokens || 0) + next.completion_tokens,
    prompt_cache_hit_tokens: (previous?.prompt_cache_hit_tokens || 0) + (next.prompt_cache_hit_tokens || 0),
    prompt_cache_miss_tokens: (previous?.prompt_cache_miss_tokens || 0) + (next.prompt_cache_miss_tokens || 0),
  }
}

export async function translateExtractedPage(options: {
  paper: Paper
  page: ExtractedPage
  baseUrl: string
  model: string
  blockId?: string
  shouldStop?: () => boolean
  onSaved?: (translation: PageTranslation) => void
  request?: (blocks: { id: string; text: string }[]) => Promise<TranslationResult>
}): Promise<PageTranslationOutcome> {
  const { paper, page } = options
  if (!canAutoTranslate(page)) return { state: 'skipped' }
  const encoded = new TextEncoder().encode(page.blocks.map(block => `${block.id}:${block.text}`).join('\n'))
  const sourceHash = await sha256(encoded.buffer as ArrayBuffer)
  const existing = await getTranslation(paper.id, page.page)
  if (existing && existing.sourceHash !== sourceHash) return { state: 'stale', translation: existing }
  const candidates = page.blocks.filter(block => canTranslateBlock(page, block)
    && (!options.blockId || block.id === options.blockId))
  if (!candidates.length) return { state: 'skipped', translation: existing }
  const eligible = candidates.filter(block => !existing?.manualBlockIds?.includes(block.id)
    && (options.blockId === block.id || !existing?.textByBlock[block.id]?.trim()))
  if (!eligible.length) return { state: 'cached', translation: existing }

  let savedAny = false
  let last = existing
  for (const group of makeBatches(eligible)) {
    if (options.shouldStop?.()) return { state: 'paused', translation: last }
    const latest = await getTranslation(paper.id, page.page)
    if (latest && latest.sourceHash !== sourceHash) return { state: 'stale', translation: latest }
    const pending = group.filter(block => !latest?.manualBlockIds?.includes(block.id)
      && (options.blockId === block.id || !latest?.textByBlock[block.id]?.trim()))
    if (!pending.length) continue
    const result = await (options.request
      ? options.request(pending.map(block => ({ id: block.id, text: block.text })))
      : invoke<TranslationResult>('translate_blocks', {
        baseUrl: options.baseUrl, model: options.model, paperTitle: paper.title, page: page.page,
        blocks: pending.map(block => ({ id: block.id, text: block.text })),
      }))
    const afterRequest = await getTranslation(paper.id, page.page)
    if (afterRequest && afterRequest.sourceHash !== sourceHash) return { state: 'stale', translation: afterRequest }
    const byBlock: Record<string, string> = {}
    for (const item of result.translations) {
      if (!afterRequest?.manualBlockIds?.includes(item.id)
        && (options.blockId === item.id || !afterRequest?.textByBlock[item.id]?.trim()))
        byBlock[item.id] = item.text
    }
    if (Object.keys(byBlock).length || result.usage) {
      last = await saveTranslation({
        paperId: paper.id, page: page.page, sourceHash,
        textByBlock: byBlock, editedAt: Date.now(), origin: 'api', model: result.model,
        manualBlockIds: afterRequest?.manualBlockIds || [],
        usage: addUsage(afterRequest?.usage, result.usage),
      }, options.blockId)
      savedAny = true
      options.onSaved?.(last)
    }
    if (result.validationError) throw new Error(result.validationError)
  }
  return { state: savedAny ? 'translated' : 'cached', translation: last }
}
