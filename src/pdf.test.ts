import { describe, expect, it } from 'vitest'
import { blockViewportRect, extractFromFragments, extractPage } from './pdf'
import { existsSync, readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const twoColumnFixture = 'work/samples/deep-residual-learning.pdf'
const cruFixture = 'work/samples/cru.pdf'
const bertFixture = 'work/samples/user/09_BERT.pdf'
const vitFixture = 'work/samples/user/10_Vision_Transformer_ViT.pdf'

describe('PDF reading order', () => {
  it('detects two columns when every word is a separate PDF item', () => {
    const raw = []
    for (let row = 0; row < 22; row++) {
      for (const start of [50, 320]) {
        for (let word = 0; word < 6; word++) raw.push({
          text: start === 50 ? 'left' : 'right', x: start + word * 35,
          y: 710 - row * 12, width: 32, height: 10,
        })
      }
    }
    const page = extractFromFragments('word-items', 1, 612, 792, 0, raw)
    expect(page.columns).toBe(2)
    expect(page.blocks.every(block => !(block.text.includes('left') && block.text.includes('right')))).toBe(true)
    expect(page.blocks[0].text).toContain('left left')
  })
  it.skipIf(!existsSync('work/samples/user/RigL.pdf'))('keeps RigL word-fragmented columns separate', async () => {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync('work/samples/user/RigL.pdf')), useSystemFonts: true }).promise
    for (const number of [1, 2]) {
      const page = await extractPage('rigl', number, await pdf.getPage(number))
      expect(page.columns).toBe(2)
      if (number === 1) {
        const intro = page.blocks.find(b => b.text.startsWith('The parameter and floating'))
        expect(intro).toBeDefined()
        expect(intro!.bbox[2]).toBeLessThan(306)
        expect(intro!.text).not.toContain('largest possible dense')
        expect(intro!.text).toContain('sparse neural networks')
      }
    }
  })
  it.skipIf(!existsSync(bertFixture))('maps a real text block into scaled and rotated PDF viewports', async () => {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync(bertFixture)) }).promise
    const source = await pdf.getPage(1)
    const extracted = await extractPage('bert', 1, source)
    const bbox = extracted.blocks[0].bbox
    const upright = source.getViewport({ scale: 1 })
    const rotated = source.getViewport({ scale: 1.5, rotation: 90 })
    const a = blockViewportRect(bbox, upright)
    const b = blockViewportRect(bbox, rotated)
    expect(a.left).toBeGreaterThanOrEqual(0)
    expect(a.top).toBeGreaterThanOrEqual(0)
    expect(a.left + a.width).toBeLessThanOrEqual(upright.width + 1)
    expect(a.top + a.height).toBeLessThanOrEqual(upright.height + 1)
    expect(b.left).toBeGreaterThanOrEqual(0)
    expect(b.top).toBeGreaterThanOrEqual(0)
    expect(b.left + b.width).toBeLessThanOrEqual(rotated.width + 1)
    expect(b.top + b.height).toBeLessThanOrEqual(rotated.height + 1)
    expect(b.width).toBeCloseTo(a.height * 1.5, 2)
    expect(b.height).toBeCloseTo(a.width * 1.5, 2)
  })

  it('keeps two columns in reading order instead of mixing same-height lines', () => {
    const raw = [{ text: 'Deep Residual Learning for Image Recognition', x: 115, y: 760, width: 390, height: 18 }]
    for (let n = 0; n < 20; n++) {
      raw.push({ text: `Left column sentence number ${n} with enough words.`, x: 50, y: 710 - n * 12, width: 226, height: 10 })
      raw.push({ text: `Right column sentence number ${n} with enough words.`, x: 320, y: 710 - n * 12, width: 225, height: 10 })
    }
    const page = extractFromFragments('sample-sha', 2, 612, 792, 0, raw)
    const text = page.blocks.map(block => block.text).join('\n')
    expect(page.columns).toBe(2)
    expect(text.indexOf('Left column sentence number 19')).toBeLessThan(text.indexOf('Right column sentence number 0'))
    expect(page.blocks[0].bbox).toEqual([115, 742, 505, 760])
  })

  it('flags a page with no reliable text', () => {
    const page = extractFromFragments('sample-sha', 1, 612, 792, 0, [])
    expect(page.quality).toBe('empty')
    expect(page.blocks).toHaveLength(0)
  })

  it('flags control characters produced by a broken PDF font mapping', () => {
    const page = extractFromFragments('bad-font', 1, 612, 792, 0, [{
      text: 'Readable text '.repeat(70) + '\u000f', x: 90, y: 650, width: 400, height: 10,
    }])
    expect(page.quality).toBe('review')
  })

  it('keeps rotated chart labels out of the translation source and warns about them', () => {
    const raw = [{ text: 'Horizontal body text with enough words to be useful. '.repeat(18), x: 90, y: 650, width: 400, height: 10 },
      { text: 'Vertical chart label', x: 20, y: 200, width: 300, height: 15, angle: 90 }]
    const page = extractFromFragments('rotated', 1, 612, 792, 0, raw)
    expect(page.quality).toBe('ok')
    expect(page.warning).toContain('竖排图表文字')
    expect(page.blocks.map(block => block.text).join(' ')).not.toContain('Vertical chart label')
  })

  it.skipIf(!existsSync(bertFixture))('reads the user BERT first page left column before right, excluding its arXiv stamp', async () => {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync(bertFixture)), useSystemFonts: true }).promise
    const page = await extractPage('bert', 1, await pdf.getPage(1))
    const text = page.blocks.map(block => block.text).join(' ')
    expect(page.columns).toBe(2)
    expect(page.quality).toBe('ok')
    expect(text.indexOf('processing tasks (Dai and Le')).toBeLessThan(text.indexOf('There are two existing strategies'))
    expect(text).not.toContain('arXiv:1810.04805v2')
    expect(page.blocks.every(block => block.bbox[0] >= 70)).toBe(true)
  })

  it.skipIf(!existsSync(vitFixture))('reads the user ViT first page without its arXiv stamp and flags the figure page', async () => {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync(vitFixture)), useSystemFonts: true }).promise
    const first = await extractPage('vit', 1, await pdf.getPage(1))
    const figurePage = await extractPage('vit', 21, await pdf.getPage(21))
    expect(first.columns).toBe(1)
    expect(first.quality).toBe('ok')
    const text = first.blocks.map(block => block.text).join(' ')
    expect(text).not.toContain('arXiv:2010.11929v2')
    expect(text).not.toContain('Published as a conference paper at ICLR 2021')
    expect(text).toContain('requiring substantially fewer computational resources')
    expect(figurePage.quality).toBe('review')
  })

  it.skipIf(!existsSync(twoColumnFixture))('detects two columns in a real ResNet PDF', async () => {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync(twoColumnFixture)), useSystemFonts: true }).promise
    const pdfPage = await pdf.getPage(1)
    const text = await pdfPage.getTextContent()
    const raw = text.items.filter(item => 'str' in item).map(item => ({
      text: item.str, x: item.transform[4], y: item.transform[5], width: item.width,
      height: Math.max(item.height, Math.hypot(item.transform[2], item.transform[3])),
    }))
    const page = extractFromFragments('resnet', 1, 612, 792, 0, raw)
    expect(page.columns).toBe(2)
    const ordered = page.blocks.map(b => b.text).join(' ')
    expect(ordered).toContain('Deeper neural networks')
    expect(ordered).toContain('Driven by')
    expect(ordered.indexOf('1. Introduction')).toBeLessThan(ordered.indexOf('Driven by'))
  })

  it.skipIf(!existsSync(cruFixture))('keeps the ICML two-column abstract separate from the right column', async () => {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync(cruFixture)), useSystemFonts: true }).promise
    const pdfPage = await pdf.getPage(1)
    const text = await pdfPage.getTextContent()
    const raw = text.items.filter(item => 'str' in item).map(item => ({
      text: item.str, x: item.transform[4], y: item.transform[5], width: item.width,
      height: Math.max(item.height, Math.hypot(item.transform[2], item.transform[3])),
    }))
    const page = extractFromFragments('cru', 1, 612, 792, 0, raw)
    const ordered = page.blocks.map(b => b.text).join(' ')
    expect(page.columns).toBe(2)
    expect(ordered).not.toContain('Modern Although')
    expect(ordered.indexOf('ordinary differential equations.')).toBeLessThan(ordered.indexOf('Although continuous'))
    expect(page.blocks.some(b => b.text.includes('Recurrent neural networks (RNNs) are a popular choice') && b.text.includes('RNN architectures assume'))).toBe(true)
  })
})
