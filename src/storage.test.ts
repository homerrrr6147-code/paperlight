import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import {
  getFullTranslationJob, getTranslation, getTranslationHistory, importPaper, listPapers,
  normalizeTags, saveFullTranslationJob, saveManualBlock, saveTranslation, updateFullTranslationJob,
  updatePaperMetadata,
  savePage, getPage,
} from './storage'
import { EXTRACTOR_VERSION, extractFromFragments } from './pdf'

describe('local data integrity', () => {
  it('archives incompatible translations and reopens task pages after extractor upgrades', async () => {
    const oldPage = extractFromFragments('layout-upgrade', 1, 612, 792, 0, [])
    oldPage.extractorVersion = EXTRACTOR_VERSION - 1
    await savePage(oldPage)
    await saveTranslation({ paperId: oldPage.paperId, page: 1, sourceHash: 'old-layout',
      textByBlock: { '1:1': '需保留的人工修改' }, manualBlockIds: ['1:1'], origin: 'manual', editedAt: 1 })
    await saveFullTranslationJob({ paperId: oldPage.paperId, totalPages: 2, completedPages: [1, 2],
      skippedPages: [], status: 'complete', baseUrl: 'https://api.deepseek.com', model: 'test', updatedAt: 1 })
    await savePage({ ...oldPage, extractorVersion: EXTRACTOR_VERSION })
    expect(await getTranslation(oldPage.paperId, 1)).toBeUndefined()
    expect((await getTranslationHistory(oldPage.paperId, 1))[0].textByBlock['1:1']).toBe('需保留的人工修改')
    expect((await getFullTranslationJob(oldPage.paperId))?.completedPages).toEqual([2])
    expect((await getPage(oldPage.paperId, 1))?.extractorVersion).toBe(EXTRACTOR_VERSION)
  })
  it('renames a library entry and normalizes its tags without changing the attachment identity', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nmetadata').buffer as ArrayBuffer
    const file = new File([bytes], '2508.08382v1.pdf', { type: 'application/pdf' })
    const imported = await importPaper(file, 11, bytes)
    const updated = await updatePaperMetadata(imported.paper.id, '  My Paper Title  ', 'LLM, 复现，llm; 2025')
    expect(updated.id).toBe(imported.paper.id)
    expect(updated.name).toBe('2508.08382v1.pdf')
    expect(updated.title).toBe('My Paper Title')
    expect(updated.tags).toEqual(['LLM', '复现', '2025'])
  })

  it('limits and cleans tags consistently', () => {
    expect(normalizeTags(['#Vision', ' vision ', '', 'Long   Tag'])).toEqual(['Vision', 'Long Tag'])
  })

  it('deduplicates identical PDF bytes without creating another paper', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nsample').buffer as ArrayBuffer
    const file = new File([bytes], 'test.pdf', { type: 'application/pdf' })
    const first = await importPaper(file, 2, bytes)
    const second = await importPaper(file, 2, bytes)
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect((await listPapers()).filter(p => p.id === first.paper.id)).toHaveLength(1)
  })

  it('archives an older translation when extraction source changes', async () => {
    const old = { paperId: 'paper-1', page: 1, sourceHash: 'old', textByBlock: { '1:1': '人工修改' }, editedAt: 1, origin: 'manual' as const }
    const updated = { ...old, sourceHash: 'new', textByBlock: { '1:1': '新译文' }, editedAt: 2 }
    await saveTranslation(old)
    await saveTranslation(updated)
    expect((await getTranslation('paper-1', 1))?.textByBlock['1:1']).toBe('新译文')
    expect((await getTranslationHistory('paper-1', 1))[0].textByBlock['1:1']).toBe('人工修改')
  })

  it('keeps a manual edit made while an API batch is in flight', async () => {
    const base = { paperId: 'paper-concurrent', page: 1, sourceHash: 'same', editedAt: 1, origin: 'api' as const }
    await saveTranslation({ ...base, textByBlock: { '1:1': '先前译文' } })
    await saveManualBlock(base.paperId, 1, base.sourceHash, '1:2', '人工译文')
    const saved = await saveTranslation({ ...base, editedAt: 3,
      textByBlock: { '1:1': '新译文', '1:2': '模型译文', '1:3': '第三块' }, manualBlockIds: [] })
    expect(saved.textByBlock).toEqual({ '1:1': '新译文', '1:2': '人工译文', '1:3': '第三块' })
    expect(saved.manualBlockIds).toContain('1:2')
    expect((await getTranslation(base.paperId, 1))?.textByBlock['1:2']).toBe('人工译文')
  })

  it('saves a manual edit without losing an API block saved just before it', async () => {
    const base = { paperId: 'paper-manual', page: 2, sourceHash: 'same', editedAt: 1, origin: 'api' as const }
    await saveTranslation({ ...base, textByBlock: { '2:1': '自动译文' }, model: 'test-model' })
    const saved = await saveManualBlock(base.paperId, 2, base.sourceHash, '2:2', '人工译文')
    expect(saved.textByBlock).toEqual({ '2:1': '自动译文', '2:2': '人工译文' })
    expect(saved.model).toBe('test-model')
  })

  it('persists two workers progress so a restarted job can skip completed pages', async () => {
    await saveFullTranslationJob({
      paperId: 'resume-paper', totalPages: 4, completedPages: [], skippedPages: [],
      status: 'running', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', updatedAt: 1,
    })
    await Promise.all([1, 2].map(number => updateFullTranslationJob('resume-paper', current => ({
      ...current, completedPages: [...new Set([...current.completedPages, number])], updatedAt: number + 1,
    }))))
    const restored = await getFullTranslationJob('resume-paper')
    expect(restored?.completedPages.sort()).toEqual([1, 2])
    expect([1, 2, 3, 4].filter(number => !restored?.completedPages.includes(number))).toEqual([3, 4])
  })
})
