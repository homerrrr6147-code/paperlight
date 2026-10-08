import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type BlockKind = 'text' | 'heading' | 'caption' | 'equation' | 'reference'
export type ExtractedBlock = {
  id: string
  page: number
  order: number
  kind: BlockKind
  text: string
  bbox: [number, number, number, number] // PDF points; origin at bottom left
}
export type ExtractedPage = {
  extractorVersion: number
  paperId: string
  page: number
  rotation: number
  width: number
  height: number
  columns: 1 | 2
  quality: 'ok' | 'review' | 'empty'
  warning?: string
  blocks: ExtractedBlock[]
}
export const EXTRACTOR_VERSION = 8
export const INVALID_TEXT_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/

export function blockViewportRect(
  bbox: ExtractedBlock['bbox'], viewport: ReturnType<PDFPageProxy['getViewport']>,
): { left: number; top: number; width: number; height: number } {
  const [a, b, c, d, e, f] = viewport.transform
  const corners = [
    [bbox[0], bbox[1]], [bbox[0], bbox[3]],
    [bbox[2], bbox[1]], [bbox[2], bbox[3]],
  ]
  const xs = corners.map(([x, y]) => a * x + c * y + e)
  const ys = corners.map(([x, y]) => b * x + d * y + f)
  return {
    left: Math.min(...xs), top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
  }
}

type Fragment = { text: string; x: number; y: number; width: number; height: number; angle?: number }
type Line = { text: string; x: number; y: number; x2: number; y2: number; height: number }

export async function openPdf(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
}

function lineFromFragments(items: Fragment[]): Line {
  const sorted = [...items].sort((a, b) => a.x - b.x)
  let text = ''
  let previousEnd = -Infinity
  for (const item of sorted) {
    const gap = item.x - previousEnd
    const part = item.text.replace(/\u00ad/g, '')
    if (text && gap > Math.max(0.5, item.height * 0.12) && !/^[,.;:!?)}\]]/.test(part)) text += ' '
    text += part
    previousEnd = Math.max(previousEnd, item.x + item.width)
  }
  return {
    text: text.trim().replace(/\s+/g, ' '),
    x: Math.min(...items.map(i => i.x)),
    y: Math.max(...items.map(i => i.y)),
    x2: Math.max(...items.map(i => i.x + i.width)),
    y2: Math.min(...items.map(i => i.y - i.height)),
    height: Math.max(...items.map(i => i.height)),
  }
}

function makeLines(items: Fragment[]): Line[] {
  const ordered = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: Fragment[][] = []
  for (const item of ordered) {
    const row = rows.find(r => Math.abs(r[0].y - item.y) <= Math.max(2, item.height * 0.28))
    if (row) row.push(item)
    else rows.push([item])
  }
  // Some PDFs expose individual words, others expose entire lines. Detect the
  // gutter before joining words so a shared baseline cannot merge two columns.
  const segments: Fragment[][] = []
  for (const row of rows) {
    let segment: Fragment[] = []
    let end = -Infinity
    for (const item of row.sort((a, b) => a.x - b.x)) {
      if (segment.length && item.x - end > Math.max(12, item.height * 1.4)) {
        segments.push(segment)
        segment = []
      }
      segment.push(item)
      end = Math.max(end, item.x + item.width)
    }
    if (segment.length) segments.push(segment)
  }
  return segments.map(lineFromFragments).filter(line => line.text)
    .sort((a, b) => b.y - a.y || a.x - b.x)
}

function combineText(previous: string, next: string): string {
  // A superscript footnote marker can land between the halves of a wrapped word.
  if (previous.endsWith('-') && /^\d{1,2}\s+[a-z]/.test(next))
    return previous.slice(0, -1) + next.replace(/^\d{1,2}\s+/, '')
  if (previous.endsWith('-') && /^[a-z]/.test(next)) return previous.slice(0, -1) + next
  return previous + ' ' + next
}

function blockKind(text: string): BlockKind {
  if (/^(Figure|Fig\.|Table)\s*\d+[.:]/i.test(text)) return 'caption'
  if (/^References\b/i.test(text)) return 'heading'
  const headingWords = text.replace(/^\d+(?:\.\d+)*\.?\s+/, '').split(/\s+/)
  if (headingWords.length <= 8 && headingWords.every(word =>
    /^(?:[A-Z][A-Za-z0-9/-]*|and|of|the|for|with|in|to|a|an|on|vs\.?|&)$/.test(word)
  ) && !/[.!?]$/.test(text)) return 'heading'
  const symbols = (text.match(/[=∑∏∫√≤≥±×÷{}_^]/g) || []).length
  if (symbols >= 3 && symbols / Math.max(1, text.length) > 0.08) return 'equation'
  if (/^\[\d+\]\s/.test(text)) return 'reference'
  return 'text'
}

function paragraphs(lines: Line[], page: number, offset: number, referenceMode: boolean): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  let current: Line[] = []
  const flush = () => {
    if (!current.length) return
    const text = current.reduce((out, line, index) => index ? combineText(out, line.text) : line.text, '')
    const inferred = blockKind(text)
    blocks.push({
      id: `${page}:${offset + blocks.length + 1}`,
      page,
      order: offset + blocks.length + 1,
      kind: referenceMode && inferred === 'text' ? 'reference' : inferred,
      text,
      bbox: [Math.min(...current.map(x => x.x)), Math.min(...current.map(x => x.y2)),
        Math.max(...current.map(x => x.x2)), Math.max(...current.map(x => x.y))],
    })
    current = []
  }
  for (const line of lines) {
    const kind = blockKind(line.text)
    const prev = current.at(-1)
    const gap = prev ? prev.y - line.y : 0
    const indent = prev ? Math.abs(prev.x - line.x) : 0
    const boundary = prev && (gap < -10 || gap > Math.max(5, prev.height * 1.4)
      || (indent > 8 && /[.!?:;]$/.test(prev.text))
      || kind === 'heading' || kind === 'caption' || kind === 'reference')
    if (boundary) flush()
    current.push(line)
    if (kind === 'heading' || kind === 'caption' || kind === 'reference') flush()
  }
  flush()
  return blocks
}

export function extractFromFragments(
  paperId: string, page: number, width: number, height: number, rotation: number,
  raw: Fragment[],
): ExtractedPage {
  // PDF.js reports the arXiv margin stamp as a long, vertical text item. Its
  // horizontal width is misleading and can join both columns into one block.
  const rotated = raw.filter(item => item.text.trim() && Math.abs(item.angle ?? 0) > 25)
  const unknownRotated = rotated.filter(item => !/^arxiv:/i.test(item.text.trim()))
  const baseItems = raw.filter(item => item.text.trim() && Number.isFinite(item.x) && Number.isFinite(item.y)
    && Math.abs(item.angle ?? 0) <= 25
    && !(item.y > height * 0.9 && /^Published as a conference paper at\b/i.test(item.text.trim()))
    && !(item.y < height * 0.055 && Math.abs(item.x + item.width / 2 - width / 2) < 30
      && /^\d{1,3}$/.test(item.text.trim())))
  const items = baseItems.filter(item => !(item.height <= 8 && /^\d{1,2}$/.test(item.text.trim())
    && baseItems.some(other => other !== item && other.text.length > 30 && other.height > item.height
      && item.y - other.y > 1 && item.y - other.y < 8
      && other.x < item.x && other.x + other.width > item.x)))
  const mid = width / 2
  const lines = makeLines(items)
  const substantial = lines.filter(i => i.text.length >= 25 && i.x2 - i.x >= 65)
  const leftCount = substantial.filter(i => i.x < mid - 95 && i.x2 < mid + 22).length
  const rightCount = substantial.filter(i => i.x >= mid - 4).length
  const columns: 1 | 2 = leftCount >= 18 && rightCount >= 4 ? 2 : 1
  const groups: Line[][] = []
  if (columns === 1) {
    groups.push(lines)
  } else {
    const fullLines = lines.filter(i => i.x < mid - 55 && i.x2 > mid + 55)
    const leftLines = lines.filter(i => !fullLines.includes(i) && i.x < mid - 4)
    const rightLines = lines.filter(i => !fullLines.includes(i) && i.x >= mid - 4)
    let top = Infinity
    for (const anchor of [...fullLines, { y: -Infinity }]) {
      groups.push(leftLines.filter(x => x.y < top && x.y >= anchor.y))
      groups.push(rightLines.filter(x => x.y < top && x.y >= anchor.y))
      if (Number.isFinite(anchor.y)) groups.push([anchor as Line])
      top = anchor.y
    }
  }
  // Flush explicitly between columns, even when their end/start baselines coincide.
  let blocks: ExtractedBlock[] = []
  for (const group of groups) blocks.push(...paragraphs(group, page, blocks.length, false))
  const referenceIndex = blocks.findIndex(b => /^References\b/i.test(b.text))
  if (referenceIndex >= 0) blocks = blocks.map((b, i) => i > referenceIndex ? { ...b, kind: 'reference' } : b)
  const chars = blocks.reduce((n, b) => n + b.text.length, 0)
  const badChars = blocks.reduce((n, b) => n + (b.text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g) || []).length, 0)
  const quality = chars < 80 ? 'empty' : badChars > 0 || chars < 800 ? 'review' : 'ok'
  return {
    extractorVersion: EXTRACTOR_VERSION, paperId, page, rotation, width, height, columns, quality,
    warning: quality === 'empty' ? '本页文字过少；可能是扫描页、图像页或提取失败。'
      : quality === 'review' ? '本页文字较少或含异常字符；请先在诊断视图核对。'
        : unknownRotated.length ? `已忽略 ${unknownRotated.length} 处竖排图表文字；图表请对照原页。` : undefined,
    blocks,
  }
}

export async function extractPage(paperId: string, pageNumber: number, page: PDFPageProxy): Promise<ExtractedPage> {
  const content = await page.getTextContent({ disableNormalization: false })
  const fragments: Fragment[] = content.items.filter(item => 'str' in item).map(item => ({
    text: item.str,
    x: item.transform[4], y: item.transform[5], width: item.width,
    height: Math.max(item.height, Math.hypot(item.transform[2], item.transform[3])),
    angle: Math.atan2(item.transform[1], item.transform[0]) * 180 / Math.PI,
  }))
  return extractFromFragments(paperId, pageNumber, page.view[2] - page.view[0], page.view[3] - page.view[1], page.rotate, fragments)
}
