import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { ExtractedPage } from './pdf'
import type { Paper } from './storage'
import { getTranslation, getTranslationHistory, saveManualBlock, saveTranslation, sha256 } from './storage'
import { referenceOnlyPages, translateExtractedPage } from './translation'

const paper = (id: string): Paper => ({
  id, name: 'paper.pdf', title: 'Paper', size: 100, pages: 3,
  addedAt: 1, lastReadAt: 1, lastPage: 1, starred: false,
})
const page = (paperId: string, number: number, texts: string[]): ExtractedPage => ({
  extractorVersion: 7, paperId, page: number, rotation: 0, width: 600, height: 800,
  columns: 1, quality: 'ok',
  blocks: texts.map((text, index) => ({
    id: `${number}:${index + 1}`, page: number, order: index + 1,
    kind: 'text', text, bbox: [0, 0, 100, 20],
  })),
})
const sourceHash = async (extracted: ExtractedPage) => {
  const bytes = new TextEncoder().encode(extracted.blocks.map(block => `${block.id}:${block.text}`).join('\n'))
  return sha256(bytes.buffer as ArrayBuffer)
}

describe('whole-paper translation reuse', () => {
  it('does not call the provider for a page with saved translations', async () => {
    const item = paper('cached-paper')
    const extracted = page(item.id, 1, ['First paragraph', 'Second paragraph'])
    await saveTranslation({
      paperId: item.id, page: 1, sourceHash: await sourceHash(extracted),
      textByBlock: { '1:1': '第一段', '1:2': '第二段' },
      editedAt: 1, origin: 'api',
    })
    const request = vi.fn()
    const outcome = await translateExtractedPage({
      paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', request,
    })
    expect(outcome.state).toBe('cached')
    expect(request).not.toHaveBeenCalled()
  })

  it('requests only missing blocks and preserves a manual correction', async () => {
    const item = paper('partial-paper')
    const extracted = page(item.id, 2, ['Model name', 'Missing paragraph'])
    await saveManualBlock(item.id, 2, await sourceHash(extracted), '2:1', '人工译名')
    const request = vi.fn(async (blocks: { id: string; text: string }[]) => ({
      translations: blocks.map(block => ({ id: block.id, text: '自动译文' })),
      model: 'deepseek-flash', usage: { prompt_tokens: 20, completion_tokens: 8 },
    }))
    const outcome = await translateExtractedPage({
      paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', request,
    })
    expect(request).toHaveBeenCalledWith([{ id: '2:2', text: 'Missing paragraph' }])
    expect(outcome.state).toBe('translated')
    expect((await getTranslation(item.id, 2))?.textByBlock).toEqual({
      '2:1': '人工译名', '2:2': '自动译文',
    })
  })

  it('retranslates only an explicitly selected API block and keeps adjacent text', async () => {
    const item = paper('retry-one-block')
    const extracted = page(item.id, 2, ['First paragraph', 'Second paragraph'])
    await saveTranslation({
      paperId: item.id, page: 2, sourceHash: await sourceHash(extracted),
      textByBlock: { '2:1': '旧译文', '2:2': '保留的译文' }, editedAt: 1, origin: 'api',
    })
    const request = vi.fn(async () => ({
      translations: [{ id: '2:1', text: '新译文' }], model: 'deepseek-flash',
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }))
    await translateExtractedPage({
      paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', blockId: '2:1', request,
    })
    expect(request).toHaveBeenCalledWith([{ id: '2:1', text: 'First paragraph' }])
    expect((await getTranslation(item.id, 2))?.textByBlock).toEqual({
      '2:1': '新译文', '2:2': '保留的译文',
    })
    expect((await getTranslationHistory(item.id, 2))[0].textByBlock['2:1']).toBe('旧译文')
  })

  it('translates only the selected missing block', async () => {
    const item = paper('retry-missing')
    const extracted = page(item.id, 1, ['Missing first', 'Missing second'])
    const request = vi.fn(async () => ({
      translations: [{ id: '1:2', text: '第二块' }], model: 'deepseek-flash',
    }))
    await translateExtractedPage({
      paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', blockId: '1:2', request,
    })
    expect(request).toHaveBeenCalledWith([{ id: '1:2', text: 'Missing second' }])
    expect((await getTranslation(item.id, 1))?.textByBlock).toEqual({ '1:2': '第二块' })
  })

  it('does not overwrite a manually edited block during explicit retry', async () => {
    const item = paper('retry-manual')
    const extracted = page(item.id, 2, ['First paragraph'])
    await saveManualBlock(item.id, 2, await sourceHash(extracted), '2:1', '人工译文')
    const request = vi.fn()
    const outcome = await translateExtractedPage({
      paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', blockId: '2:1', request,
    })
    expect(outcome.state).toBe('cached')
    expect(request).not.toHaveBeenCalled()
    expect((await getTranslation(item.id, 2))?.textByBlock['2:1']).toBe('人工译文')
  })

  it('keeps valid blocks when another block fails validation, then resumes only the missing block', async () => {
    const item = paper('validation-partial')
    const extracted = page(item.id, 1, ['First result 30', 'Second result 3'])
    const request = vi.fn()
      .mockResolvedValueOnce({
        translations: [{ id: '1:1', text: '结果为 30' }],
        model: 'deepseek-flash', usage: { prompt_tokens: 40, completion_tokens: 15 },
        validationError: '文本块 1:2 的数字 3 未保留',
      })
      .mockResolvedValueOnce({
        translations: [{ id: '1:2', text: '第二个结果为 3' }],
        model: 'deepseek-flash', usage: { prompt_tokens: 18, completion_tokens: 7 },
      })
    const options = { paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', request }
    await expect(translateExtractedPage(options)).rejects.toThrow('数字 3')
    expect((await getTranslation(item.id, 1))?.textByBlock).toEqual({ '1:1': '结果为 30' })
    await translateExtractedPage(options)
    expect(request.mock.calls[1][0]).toEqual([{ id: '1:2', text: 'Second result 3' }])
    expect((await getTranslation(item.id, 1))?.textByBlock).toEqual({
      '1:1': '结果为 30', '1:2': '第二个结果为 3',
    })
  })

  it('skips reference continuation and resumes at an appendix', () => {
    const pages = [
      page('refs', 1, ['Main text', 'References']),
      page('refs', 2, ['Smith et al. 2020']),
      page('refs', 3, ['Appendix A', 'Additional experiment']),
    ]
    expect([...referenceOnlyPages(pages)]).toEqual([2])
  })

  it('keeps a dense experimental table on the PDF instead of sending it to the model', async () => {
    const item = paper('table-paper')
    const extracted = page(item.id, 3, [
      'Model Dataset Epochs LR Dropout ViT-B/16 JFT-300M 7 8e-4 0.0 ViT-L/16 JFT-300M 14 4e-4 0.0 ViT-H/14 ImageNet 300 3e-3 0.1',
      'Table 3 summarizes our training setups and compares the selected models.',
    ])
    const request = vi.fn(async (blocks: { id: string; text: string }[]) => ({
      translations: blocks.map(block => ({ id: block.id, text: '译文' })),
      model: 'deepseek-flash',
    }))
    await translateExtractedPage({
      paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', request,
    })
    expect(request).toHaveBeenCalledWith([{ id: '3:2', text: extracted.blocks[1].text }])
  })

  it('marks a table-only page as skipped without an API call', async () => {
    const item = paper('table-only')
    const extracted = page(item.id, 1, [
      'Model Dataset Epochs LR Dropout ViT-B/16 JFT-300M 7 8e-4 0.0 ViT-L/16 JFT-300M 14 4e-4 0.0 ViT-H/14 ImageNet 300 3e-3 0.1',
    ])
    const request = vi.fn()
    const outcome = await translateExtractedPage({
      paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', request,
    })
    expect(outcome.state).toBe('skipped')
    expect(request).not.toHaveBeenCalled()
  })

  it('continues a paused page without resending the saved batch', async () => {
    const item = paper('paused-page')
    const extracted = page(item.id, 1, ['word '.repeat(500), 'next '.repeat(500)])
    let stop = false
    const request = vi.fn(async (blocks: { id: string; text: string }[]) => {
      stop = true
      return { translations: blocks.map(block => ({ id: block.id, text: '已译' })), model: 'deepseek-flash' }
    })
    const options = { paper: item, page: extracted, baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash', request }
    const paused = await translateExtractedPage({ ...options, shouldStop: () => stop })
    expect(paused.state).toBe('paused')
    expect(request).toHaveBeenCalledTimes(1)
    stop = false
    const resumed = await translateExtractedPage({ ...options, shouldStop: () => stop })
    expect(resumed.state).toBe('translated')
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][0][0].id).toBe('1:1')
    expect(request.mock.calls[1][0][0].id).toBe('1:2')
  })
})
