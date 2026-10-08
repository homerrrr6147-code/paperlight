import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { blockViewportRect, extractPage, openPdf } from './pdf'
import type { ExtractedBlock, ExtractedPage } from './pdf'
import {
  getFullTranslationJob, getPage, getPdfBytes, getTranslation, getTranslationHistory, importPaper, listPapers,
  saveFullTranslationJob, saveManualBlock, savePage, savePaper, sha256, updateFullTranslationJob,
  updatePaperMetadata,
} from './storage'
import type { FullTranslationJob, PageTranslation, Paper } from './storage'
import { canAutoTranslate, canTranslateBlock, referenceOnlyPages, translateExtractedPage } from './translation'
import { invoke, isTauri } from '@tauri-apps/api/core'

const VERSION = '阅读样机 0.1.6'
const NATIVE = isTauri()

async function getOrExtractPage(doc: PDFDocumentProxy, paperId: string, number: number): Promise<ExtractedPage> {
  const cached = await getPage(paperId, number)
  if (cached) return cached
  const extracted = await extractPage(paperId, number, await doc.getPage(number))
  await savePage(extracted)
  return extracted
}

const PdfPage = memo(function PdfPage({ doc, number, scale, visible, highlight }: {
  doc: PDFDocumentProxy; number: number; scale: number; visible: boolean
  highlight?: ExtractedBlock['bbox']
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState('')
  const [viewport, setViewport] = useState<ReturnType<PDFPageProxy['getViewport']> | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !visible) return
    let cancelled = false
    let render: { cancel: () => void; promise: Promise<unknown> } | undefined
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined
    void (async () => {
      try {
        page = await doc.getPage(number)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        setViewport(viewport)
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.ceil(viewport.width * pixelRatio)
        canvas.height = Math.ceil(viewport.height * pixelRatio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas 不可用')
        render = page.render({ canvas, canvasContext: ctx, viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] })
        await render.promise
        if (!cancelled) setError('')
      } catch (cause) {
        if (!cancelled && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    })()
    return () => {
      cancelled = true
      render?.cancel()
      canvas.width = 0
      canvas.height = 0
      page?.cleanup()
    }
  }, [doc, number, scale, visible])
  if (!visible) return <div className="page-offscreen">页面 {number}</div>
  const rect = highlight && viewport ? blockViewportRect(highlight, viewport) : null
  return <>{error && <div className="page-error">第 {number} 页渲染失败：{error}</div>}
    <div className="pdf-page-content"><canvas ref={canvasRef} />
      {rect && <div className="pdf-block-highlight" aria-hidden="true" style={{
        left: rect.left, top: rect.top, width: Math.max(4, rect.width), height: Math.max(8, rect.height),
      }} />}
    </div></>
})

function TranslationPage({ page, translation, onSave, onLocate, onRetry, canRequest, requestBusy, retryingBlockId }: {
  page: ExtractedPage
  translation?: PageTranslation
  onSave: (block: ExtractedBlock, text: string) => Promise<void>
  onLocate: (block: ExtractedBlock) => void
  onRetry: (block: ExtractedBlock) => void
  canRequest: boolean
  requestBusy: boolean
  retryingBlockId: string | null
}) {
  return <div className="translation-body">
    {page.warning && <p className="warning">{page.warning}</p>}
    {page.blocks.length === 0 && <p className="muted">没有可提取的文字。本版不支持 OCR。</p>}
    {page.blocks.map(block => <TranslationBlock
      key={block.id} block={block} value={translation?.textByBlock[block.id] || ''} onSave={onSave}
      onLocate={onLocate} onRetry={onRetry} canRequest={canRequest && canTranslateBlock(page, block)}
      requestBusy={requestBusy}
      manual={!!translation?.manualBlockIds?.includes(block.id)} retrying={retryingBlockId === block.id}
    />)}
  </div>
}

function TranslationBlock({ block, value, onSave, onLocate, onRetry, canRequest, requestBusy, manual, retrying }: {
  block: ExtractedBlock; value: string
  onSave: (block: ExtractedBlock, text: string) => Promise<void>
  onLocate: (block: ExtractedBlock) => void
  onRetry: (block: ExtractedBlock) => void
  canRequest: boolean
  requestBusy: boolean
  manual: boolean
  retrying: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <div className={`translation-block kind-${block.kind}`} onClick={() => onLocate(block)}>
    <div className="source-line"><span className="block-id">{block.id}</span>{block.text}</div>
    <div className="block-actions">
      <button onClick={event => { event.stopPropagation(); onLocate(block) }}>定位原文</button>
      {canRequest && !manual && <button onClick={event => { event.stopPropagation(); onRetry(block) }}
        disabled={requestBusy || draft !== value} title="只请求这个文本块，可能产生 API 用量">
        {retrying ? '翻译中…' : value.trim() ? '重新翻译此块' : '翻译此块'}
      </button>}
      {manual && <span className="muted">人工译文已保护</span>}
    </div>
    {block.kind === 'reference' ? <span className="muted">参考文献默认跳过</span> :
      <textarea aria-label={`第 ${block.page} 页文本块 ${block.id} 的中文译文`}
        placeholder="可手工编辑译文；离开文本框后自动保存"
        value={draft} onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (draft !== value) void onSave(block, draft) }}
        rows={Math.max(2, Math.min(8, Math.ceil(block.text.length / 65)))} />}
  </div>
}

function App() {
  const [papers, setPapers] = useState<Paper[]>([])
  const [selected, setSelected] = useState<Paper | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [current, setCurrent] = useState(1)
  const [scale, setScale] = useState(0.8)
  const [baseSize, setBaseSize] = useState({ width: 612, height: 792 })
  const [pages, setPages] = useState<Record<number, ExtractedPage>>({})
  const [translations, setTranslations] = useState<Record<number, PageTranslation>>({})
  const [staleTranslations, setStaleTranslations] = useState<Record<number, PageTranslation>>({})
  const [notice, setNotice] = useState('把 PDF 拖入窗口，或点击“导入 PDF”。')
  const [busy, setBusy] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [syncEnabled, setSyncEnabled] = useState(true)
  const [diagnostics, setDiagnostics] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingPaper, setEditingPaper] = useState<Paper | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [tagsDraft, setTagsDraft] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState(localStorage.getItem('paperlight-base-url') || 'https://api.deepseek.com')
  const [model, setModel] = useState(localStorage.getItem('paperlight-model') || 'deepseek-flash')
  const [translationMode, setTranslationMode] = useState<'page' | 'full' | 'block' | null>(null)
  const [retryingBlockId, setRetryingBlockId] = useState<string | null>(null)
  const [activeSourceBlock, setActiveSourceBlock] = useState<{ page: number; id: string } | null>(null)
  const [activeFullPaperId, setActiveFullPaperId] = useState<string | null>(null)
  const [fullJob, setFullJob] = useState<FullTranslationJob | null>(null)
  const translatingRef = useRef(false)
  const fullStopRequested = useRef(false)
  const pdfInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const leftPane = useRef<HTMLDivElement>(null)
  const rightPane = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const translationRefs = useRef<Record<number, HTMLElement | null>>({})
  const selectedRef = useRef<Paper | null>(null)
  selectedRef.current = selected
  const currentRef = useRef(current)
  currentRef.current = current

  useEffect(() => { void listPapers().then(setPapers).catch(error => setNotice(String(error))) }, [])
  useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', '') }, [])
  useEffect(() => { if (NATIVE) void invoke<boolean>('has_api_key').then(setHasKey).catch(error => setNotice(String(error))) }, [])
  useEffect(() => {
    if (!selected) { setFullJob(null); return }
    let active = true
    void getFullTranslationJob(selected.id).then(job => { if (active) setFullJob(job || null) })
      .catch(error => { if (active) setNotice(String(error)) })
    return () => { active = false }
  }, [selected?.id])

  const refresh = useCallback(async () => setPapers(await listPapers()), [])

  const choosePaper = useCallback(async (paper: Paper) => {
    setNotice('正在打开 PDF…')
    setDoc(null); setPages({}); setTranslations({}); setStaleTranslations({}); setFullJob(null)
    setActiveSourceBlock(null); setSelected(paper); setCurrent(paper.lastPage)
    try {
      const bytes = await getPdfBytes(paper.id)
      const opened = await openPdf(bytes)
      const first = await opened.getPage(1)
      const viewport = first.getViewport({ scale: 1 })
      setBaseSize({ width: viewport.width, height: viewport.height })
      const availableWidth = (window.innerWidth - (sidebarOpen ? 245 : 0)) * 0.52 - 80
      setScale(Math.min(1.25, Math.max(0.65, +(availableWidth / viewport.width).toFixed(2))))
      setDoc(opened)
      setNotice(`已打开 ${paper.title}。可翻译当前页，或手工编辑并保存译文。`)
      window.setTimeout(() => pageRefs.current[paper.lastPage]?.scrollIntoView({ block: 'start' }), 100)
    } catch (error) { setNotice(`打开失败：${String(error)}`) }
  }, [sidebarOpen])

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const pdfs = [...files].filter(file => /\.pdf$/i.test(file.name))
    if (!pdfs.length) { setNotice('没有找到 PDF 文件。'); return }
    setBusy(true)
    let added = 0; let duplicates = 0; let errors = 0
    let firstPaper: Paper | undefined
    for (const file of pdfs) {
      try {
        const bytes = await file.arrayBuffer()
        const opened = await openPdf(bytes.slice(0))
        const result = await importPaper(file, opened.numPages, bytes)
        if (result.duplicate) duplicates++
        else added++
        firstPaper ||= result.paper
        await opened.cleanup()
      } catch (error) { errors++; console.error(`导入 ${file.name} 失败`, error) }
    }
    await refresh()
    setBusy(false)
    setNotice(`导入完成：新增 ${added}，完全重复 ${duplicates}，失败 ${errors}。源文件未移动。`)
    if (!selectedRef.current && firstPaper) await choosePaper(firstPaper)
  }, [refresh, choosePaper])

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void handleFiles(event.target.files)
    event.target.value = ''
  }
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    if (event.dataTransfer.files.length) void handleFiles(event.dataTransfer.files)
  }

  useEffect(() => {
    if (!doc || !selected) return
    let cancelled = false
    const wanted = [current - 1, current, current + 1].filter(n => n >= 1 && n <= doc.numPages)
    void Promise.all(wanted.map(async n => {
      try {
        const extracted = await getOrExtractPage(doc, selected.id, n)
        const translated = await getTranslation(selected.id, n)
        const history = await getTranslationHistory(selected.id, n)
        if (!cancelled) {
          setPages(prev => ({ ...prev, [n]: extracted! }))
          const sourceHash = await sha256(new TextEncoder().encode(
            extracted.blocks.map(b => `${b.id}:${b.text}`).join('\n'),
          ).buffer as ArrayBuffer)
          if (cancelled) return
          const archived = history.find(item => item.sourceHash !== sourceHash)
          if (archived) setStaleTranslations(prev => ({ ...prev, [n]: archived }))
          if (translated) {
            if (translated.sourceHash === sourceHash) {
              setTranslations(prev => ({ ...prev, [n]: translated }))
            } else {
              setStaleTranslations(prev => ({ ...prev, [n]: translated }))
              setNotice(`第 ${n} 页解析结果已变化；旧人工译文仍保存在数据库中，需要迁移后才能显示。`)
            }
          }
        }
      } catch (error) { if (!cancelled) setNotice(`第 ${n} 页提取失败：${String(error)}`) }
    }))
    return () => { cancelled = true }
  }, [doc, selected?.id, current])

  useEffect(() => {
    if (!selected) return
    const timeout = window.setTimeout(() => {
      const updated = { ...selected, lastPage: current, lastReadAt: Date.now() }
      void savePaper(updated).then(refresh)
    }, 600)
    return () => window.clearTimeout(timeout)
  }, [current, selected?.id, refresh])

  useEffect(() => {
    if (syncEnabled) translationRefs.current[current]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [current, syncEnabled, pages[current]])

  const onLeftScroll = () => {
    const container = leftPane.current
    if (!container || !doc) return
    let nearest = current; let distance = Infinity
    const top = container.getBoundingClientRect().top + 90
    for (let n = 1; n <= doc.numPages; n++) {
      const node = pageRefs.current[n]
      if (!node) continue
      const bounds = node.getBoundingClientRect()
      if (bounds.top <= top && bounds.bottom > top) { nearest = n; break }
      const delta = Math.abs(bounds.top - top)
      if (delta < distance) { nearest = n; distance = delta }
    }
    if (nearest !== current) setCurrent(nearest)
  }

  const jumpTo = (page: number) => {
    if (!doc) return
    const safe = Math.max(1, Math.min(doc.numPages, page))
    pageRefs.current[safe]?.scrollIntoView({ block: 'start' })
    setCurrent(safe)
  }

  const locateSourceBlock = async (block: ExtractedBlock) => {
    if (!doc || !selected) return
    const paperId = selected.id
    try {
      const pdfPage = await doc.getPage(block.page)
      if (selectedRef.current?.id !== paperId) return
      const rect = blockViewportRect(block.bbox, pdfPage.getViewport({ scale }))
      const container = leftPane.current
      const shell = pageRefs.current[block.page]
      if (!container || !shell) return
      const pageTop = container.scrollTop + shell.getBoundingClientRect().top
        - container.getBoundingClientRect().top
      const targetTop = Math.max(0, pageTop + rect.top - Math.min(180, container.clientHeight * 0.25))
      setSyncEnabled(false)
      setActiveSourceBlock({ page: block.page, id: block.id })
      setCurrent(block.page)
      container.scrollTo({ top: targetTop, behavior: 'smooth' })
    } catch (error) { setNotice(`定位文本块 ${block.id} 失败：${String(error)}`) }
  }

  const saveBlock = async (block: ExtractedBlock, text: string) => {
    if (!selected) return
    const page = pages[block.page]
    if (!page) return
    const encoded = new TextEncoder().encode(page.blocks.map(b => `${b.id}:${b.text}`).join('\n'))
    const sourceHash = await sha256(encoded.buffer as ArrayBuffer)
    const saved = await saveManualBlock(selected.id, block.page, sourceHash, block.id, text)
    if (selectedRef.current?.id === selected.id) {
      setTranslations(prev => ({ ...prev, [block.page]: saved }))
      setNotice(`第 ${block.page} 页的人工译文已保存到本地。`)
    }
  }

  const saveSettings = async () => {
    localStorage.setItem('paperlight-base-url', baseUrl.trim())
    localStorage.setItem('paperlight-model', model.trim())
    if (apiKey.trim()) {
      try {
        await invoke('save_api_key', { key: apiKey.trim() })
        setApiKey(''); setHasKey(true)
      } catch (error) { setNotice(`密钥保存失败：${String(error)}`); return }
    }
    setSettingsOpen(false)
    setNotice('翻译供应商设置已保存。API Key 保存在 Windows 凭据管理器。')
  }

  const translateCurrent = async () => {
    if (!selected || !doc || !NATIVE || translatingRef.current) return
    const paper = selected
    const pageNumber = current
    translatingRef.current = true
    setTranslationMode('page')
    try {
      const extracted = pages[pageNumber] || await getOrExtractPage(doc, paper.id, pageNumber)
      const outcome = await translateExtractedPage({
        paper, page: extracted, baseUrl: baseUrl.trim(), model: model.trim(),
        onSaved: saved => {
          if (selectedRef.current?.id === paper.id)
            setTranslations(prev => ({ ...prev, [pageNumber]: saved }))
        },
      })
      if (selectedRef.current?.id === paper.id) {
        if (outcome.state === 'stale') setNotice('本页已有旧解析版本的译文；为保护人工修改，暂不自动翻译。')
        else if (outcome.state === 'skipped') setNotice('本页没有适合自动翻译的正文；请对照原 PDF 核对表格、公式或提取质量。')
        else if (outcome.state === 'cached') setNotice('当前页已有译文，无需重复调用 API。')
        else setNotice(`第 ${pageNumber} 页译文已保存。${outcome.translation?.usage ? `API 累计用量：输入 ${outcome.translation.usage.prompt_tokens}、输出 ${outcome.translation.usage.completion_tokens} token。` : ''}`)
      }
    } catch (error) {
      if (selectedRef.current?.id === paper.id)
        setNotice(`翻译失败：${String(error)}。已成功的批次保留；重新调用可能重复计费。`)
    } finally { translatingRef.current = false; setTranslationMode(null) }
  }

  const retryBlock = async (block: ExtractedBlock) => {
    if (!selected || !NATIVE || !hasKey || translatingRef.current) return
    const paper = selected
    const page = pages[block.page]
    if (!page || !canTranslateBlock(page, block)) return
    if (translations[block.page]?.manualBlockIds?.includes(block.id)) {
      setNotice(`文本块 ${block.id} 有人工修改，已保留原译文。`)
      return
    }
    translatingRef.current = true
    setTranslationMode('block')
    setRetryingBlockId(block.id)
    try {
      const outcome = await translateExtractedPage({
        paper, page, blockId: block.id, baseUrl: baseUrl.trim(), model: model.trim(),
        onSaved: saved => {
          if (selectedRef.current?.id === paper.id)
            setTranslations(prev => ({ ...prev, [block.page]: saved }))
        },
      })
      if (selectedRef.current?.id !== paper.id) return
      if (outcome.state === 'stale') {
        setNotice(`文本块 ${block.id} 的原文解析已变化；旧译文保留，请先核对。`)
      } else if (outcome.state === 'translated') {
        setNotice(`文本块 ${block.id} 已翻译并保存；请对照左侧原文核对。`)
        const job = await getFullTranslationJob(paper.id)
        if (job?.status === 'failed' && job.lastError?.includes(`文本块 ${block.id}`)) {
          const updated = await updateFullTranslationJob(paper.id, currentJob => ({
            ...currentJob, status: 'paused', lastError: undefined, updatedAt: Date.now(),
          }))
          setFullJob(updated)
        }
      } else {
        setNotice(`文本块 ${block.id} 没有新的自动译文。`)
      }
    } catch (error) {
      if (selectedRef.current?.id === paper.id)
        setNotice(`文本块 ${block.id} 翻译失败：${String(error)}。原译文已保留；再次请求可能计费。`)
    } finally {
      translatingRef.current = false
      setTranslationMode(null)
      setRetryingBlockId(null)
    }
  }

  const translateFull = async () => {
    if (!selected || !doc || !NATIVE || !hasKey || translatingRef.current) return
    const paper = selected
    const document = doc
    translatingRef.current = true
    fullStopRequested.current = false
    setTranslationMode('full')
    setActiveFullPaperId(paper.id)
    let errorMessage: string | null = null
    try {
      const previous = await getFullTranslationJob(paper.id)
      const resume = previous && previous.status !== 'complete' && previous.totalPages === document.numPages
        && previous.baseUrl === baseUrl.trim() && previous.model === model.trim()
      let job: FullTranslationJob = resume ? {
        ...previous, status: 'running', currentPage: undefined, lastError: undefined, updatedAt: Date.now(),
      } : {
        paperId: paper.id, totalPages: document.numPages, completedPages: [], skippedPages: [],
        status: 'running', baseUrl: baseUrl.trim(), model: model.trim(), updatedAt: Date.now(),
      }
      await saveFullTranslationJob(job)
      if (selectedRef.current?.id === paper.id) setFullJob(job)
      const extracted: (ExtractedPage | undefined)[] = []
      const failedExtraction: number[] = []
      for (let number = 1; number <= document.numPages && !fullStopRequested.current; number++) {
        try {
          extracted.push(await getOrExtractPage(document, paper.id, number))
        } catch {
          extracted.push(undefined)
          failedExtraction.push(number)
        }
        if (number % 2 === 0 || number === document.numPages)
          setNotice(`正在检查原文页面 ${number}/${document.numPages}；尚未发送新的翻译请求。`)
        if (number % 4 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0))
      }
      if (!fullStopRequested.current) {
        const referencePages = referenceOnlyPages(extracted.filter((page): page is ExtractedPage => !!page))
        const skipped = [...new Set([...failedExtraction, ...referencePages])]
        if (skipped.length) {
          job = await updateFullTranslationJob(paper.id, previousJob => ({
            ...previousJob,
            skippedPages: [...new Set([...previousJob.skippedPages, ...skipped])]
              .filter(number => !previousJob.completedPages.includes(number)).sort((a, b) => a - b),
            updatedAt: Date.now(),
          }))
          if (selectedRef.current?.id === paper.id) setFullJob(job)
        }
        job = await getFullTranslationJob(paper.id) || job
        const processed = new Set([...job.completedPages, ...job.skippedPages])
        const remaining = Array.from({ length: document.numPages }, (_, index) => index + 1)
          .filter(number => !processed.has(number))
        let index = 0
        let halt = false
        const worker = async () => {
          while (!fullStopRequested.current && !halt && index < remaining.length) {
            const number = remaining[index++]
            const page = extracted[number - 1]
            if (!page) continue
            try {
              const outcome = await translateExtractedPage({
                paper, page, baseUrl: job.baseUrl, model: job.model,
                shouldStop: () => fullStopRequested.current || halt,
                onSaved: saved => {
                  if (selectedRef.current?.id === paper.id && Math.abs(currentRef.current - number) <= 1)
                    setTranslations(prev => ({ ...prev, [number]: saved }))
                },
              })
              if (outcome.state === 'paused') continue
              const skippedPage = outcome.state === 'skipped' || outcome.state === 'stale'
              const updated = await updateFullTranslationJob(paper.id, previousJob => ({
                ...previousJob,
                completedPages: skippedPage ? previousJob.completedPages
                  : [...new Set([...previousJob.completedPages, number])].sort((a, b) => a - b),
                skippedPages: skippedPage
                  ? [...new Set([...previousJob.skippedPages, number])].sort((a, b) => a - b)
                  : previousJob.skippedPages,
                currentPage: number, updatedAt: Date.now(),
              }))
              if (selectedRef.current?.id === paper.id) setFullJob(updated)
              setNotice(`全文翻译：已处理 ${updated.completedPages.length + updated.skippedPages.length}/${document.numPages} 页；跳过 ${updated.skippedPages.length} 页。`)
            } catch (error) {
              errorMessage ||= `第 ${number} 页：${String(error)}`
              halt = true
            }
          }
        }
        await Promise.all([worker(), worker()])
      }
      const finalJob = await updateFullTranslationJob(paper.id, previousJob => ({
        ...previousJob,
        status: errorMessage ? 'failed' : fullStopRequested.current ? 'paused' : 'complete',
        lastError: errorMessage || undefined, currentPage: undefined, updatedAt: Date.now(),
      }))
      if (selectedRef.current?.id === paper.id) setFullJob(finalJob)
      if (errorMessage) setNotice(`全文翻译暂停：${errorMessage}。已保存的译文会复用；继续请求可能重复计费。`)
      else if (fullStopRequested.current) setNotice('全文翻译已暂停。已完成的译文保留，再次点击可继续。')
      else setNotice(`全文翻译已处理 ${finalJob.completedPages.length}/${document.numPages} 页；跳过 ${finalJob.skippedPages.length} 页。请核对译文质量。`)
    } catch (error) {
      setNotice(`全文翻译任务失败：${String(error)}。已保存的译文仍在本地。`)
      try {
        const failed = await updateFullTranslationJob(paper.id, job => ({
          ...job, status: 'failed', lastError: String(error), updatedAt: Date.now(),
        }))
        if (selectedRef.current?.id === paper.id) setFullJob(failed)
      } catch { /* The initial task may not have been saved. */ }
    } finally {
      translatingRef.current = false
      setTranslationMode(null)
      setActiveFullPaperId(null)
    }
  }

  const stopFullTranslation = () => {
    fullStopRequested.current = true
    setNotice('正在暂停全文翻译；正在进行的请求可能完成并计费，之后不会发出新请求。')
  }

  const toggleStar = async (paper: Paper) => {
    const update = { ...paper, starred: !paper.starred }
    await savePaper(update)
    setSelected(prev => prev?.id === paper.id ? update : prev)
    await refresh()
  }

  const openMetadataEditor = (paper: Paper) => {
    setEditingPaper(paper)
    setTitleDraft(paper.title)
    setTagsDraft((paper.tags || []).join('，'))
  }

  const saveMetadata = async () => {
    if (!editingPaper) return
    try {
      const updated = await updatePaperMetadata(editingPaper.id, titleDraft, tagsDraft)
      setPapers(currentPapers => currentPapers.map(paper => paper.id === updated.id ? updated : paper))
      setSelected(currentPaper => currentPaper?.id === updated.id ? updated : currentPaper)
      setEditingPaper(null)
      setNotice(`“${updated.title}”的显示名称和标签已保存。原 PDF 文件未修改。`)
    } catch (error) { setNotice(`保存论文信息失败：${String(error)}`) }
  }

  return <main className="app" onDragOver={event => event.preventDefault()} onDrop={onDrop}>
    <header className="topbar">
      <div className="brand"><button className="icon-button" title="切换资料库侧栏" onClick={() => setSidebarOpen(x => !x)}>☰</button><strong>Paperlight</strong><span>{VERSION}</span></div>
      <div className="toolbar">
        <input ref={pdfInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onFileChange} />
        <input ref={folderInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onFileChange} />
        <button onClick={() => pdfInput.current?.click()} disabled={busy}>导入 PDF</button>
        <button onClick={() => folderInput.current?.click()} disabled={busy}>导入文件夹</button>
        {NATIVE && <button onClick={() => setSettingsOpen(true)}>翻译设置</button>}
        {translationMode === 'full' && activeFullPaperId !== selected?.id
          && <button onClick={stopFullTranslation} disabled={fullStopRequested.current}>暂停后台全文翻译</button>}
      </div>
    </header>
    <div className="workspace">
      {sidebarOpen && <aside className="library">
        <div className="section-title">我的论文 <span>{papers.length}</span></div>
        {papers.length === 0 && <p className="empty-library">尚无论文。文件按 SHA-256 去重，导入源文件会保留。</p>}
        {papers.map(paper => <div className={`paper-entry ${selected?.id === paper.id ? 'selected' : ''}`} key={paper.id}>
          <button className="paper-title" onClick={() => void choosePaper(paper)} title={paper.name}>{paper.title}</button>
          <button className="edit-paper" title="修改显示名称和标签" aria-label={`编辑 ${paper.title}`}
            onClick={() => openMetadataEditor(paper)}>✎</button>
          <button className="star" title={paper.starred ? '取消星标' : '星标'} onClick={() => void toggleStar(paper)}>{paper.starred ? '★' : '☆'}</button>
          <small>{paper.pages} 页 · {new Date(paper.lastReadAt).toLocaleDateString('zh-CN')}</small>
          {!!paper.tags?.length && <div className="paper-tags">{paper.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}
        </div>)}
      </aside>}
      {doc && selected ? <section className="reader">
        <div className="reader-toolbar">
          <div className="reader-title" title={selected.name}>{selected.title}</div>
          <div className="controls">
            <button onClick={() => jumpTo(current - 1)} disabled={current === 1}>‹</button>
            <input aria-label="页码" type="number" min={1} max={doc.numPages} value={current}
              onChange={event => jumpTo(Number(event.target.value))} /> <span>/ {doc.numPages}</span>
            <button onClick={() => jumpTo(current + 1)} disabled={current === doc.numPages}>›</button>
            <button onClick={() => setScale(x => Math.max(0.7, +(x - 0.1).toFixed(1)))}>－</button>
            <span>{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale(x => Math.min(2.2, +(x + 0.1).toFixed(1)))}>＋</button>
            <button onClick={() => setDiagnostics(x => !x)}>{diagnostics ? '关闭诊断' : '提取诊断'}</button>
            {NATIVE && <button onClick={() => void translateCurrent()}
              disabled={translationMode !== null || !hasKey || !pages[current] || !canAutoTranslate(pages[current])}>
              {translationMode === 'page' ? '翻译中…' : pages[current]?.quality === 'review' ? '仅翻译图注' : '翻译当前页'}
            </button>}
            {NATIVE && (translationMode === 'full' && activeFullPaperId === selected.id
              ? <button onClick={stopFullTranslation} disabled={fullStopRequested.current}>暂停全文翻译</button>
              : <button onClick={() => void translateFull()} disabled={translationMode !== null || !hasKey}
                title="按页翻译可提取的正文；已保存译文不重复请求，参考文献与低质量页面会跳过">
                {fullJob && fullJob.status !== 'complete' ? '继续全文翻译' : '翻译全文'}
              </button>)}
          </div>
        </div>
        {fullJob && <div className="full-job-status" role="status">
          <span>全文任务：{fullJob.status === 'complete' ? '已处理' : fullJob.status === 'failed' ? '失败，可继续'
            : fullJob.status === 'paused' || (fullJob.status === 'running' && activeFullPaperId !== selected.id) ? '已暂停，可继续' : '进行中'}
            {' '}{fullJob.completedPages.length + fullJob.skippedPages.length}/{fullJob.totalPages} 页
            {fullJob.skippedPages.length > 0 && <span title={`跳过的页码：${fullJob.skippedPages.join('、')}`}> · 跳过 {fullJob.skippedPages.length} 页</span>}
            {' · '}{fullJob.model}</span>
          {fullJob.lastError && <div className="full-job-error">最近错误：{fullJob.lastError}</div>}
        </div>}
        <div className="reader-columns">
          <div className="pdf-scroll" ref={leftPane} onScroll={onLeftScroll}>
            {Array.from({ length: doc.numPages }, (_, i) => i + 1).map(n => <div className="pdf-page-shell" key={n}
              ref={node => { pageRefs.current[n] = node }}
              style={{ width: baseSize.width * scale, minHeight: baseSize.height * scale }}>
              <PdfPage doc={doc} number={n} scale={scale} visible={Math.abs(n - current) <= 1}
                highlight={activeSourceBlock?.page === n
                  ? pages[n]?.blocks.find(block => block.id === activeSourceBlock.id)?.bbox : undefined} />
              <div className="page-label">{n}</div>
            </div>)}
          </div>
          <div className="translation-column">
            <div className="translation-head">
              <strong>中文译文</strong><span className="muted">点击文本块定位原文 · 可重排</span>
              <button onClick={() => { setSyncEnabled(true); translationRefs.current[current]?.scrollIntoView({ block: 'start' }) }}>回到当前页</button>
            </div>
            {!syncEnabled && <p className="sync-note">右侧已独立滚动</p>}
            <div className="translation-scroll" ref={rightPane} onWheel={() => setSyncEnabled(false)} onTouchMove={() => setSyncEnabled(false)}>
              {Array.from({ length: doc.numPages }, (_, i) => i + 1).map(n => <article className="translation-page" key={n}
                ref={node => { translationRefs.current[n] = node }}>
                <h2>第 {n} 页 {n === current && <span className="current-indicator">当前</span>}</h2>
                {translations[n]?.usage && <p className="usage">{translations[n].model} · 输入 {translations[n].usage.prompt_tokens} / 输出 {translations[n].usage.completion_tokens} token</p>}
                {pages[n] ? <TranslationPage page={pages[n]} translation={translations[n]}
                  onSave={saveBlock} onLocate={block => { void locateSourceBlock(block) }}
                  onRetry={block => { void retryBlock(block) }} canRequest={NATIVE && hasKey}
                  requestBusy={translationMode !== null} retryingBlockId={retryingBlockId} />
                  : <p className="muted">滚动左侧至本页后提取文字</p>}
                {staleTranslations[n] && <details className="stale-translation"><summary>旧解析译文已保留（含人工修改）· 本页可按新分栏重新翻译</summary>
                  {Object.entries(staleTranslations[n].textByBlock).filter(([, text]) => text.trim()).map(([id, text]) =>
                    <p key={id}><strong>{id}</strong> {text}</p>)}
                </details>}
                {diagnostics && pages[n] && <details open={n === current} className="diagnostics">
                  <summary>提取诊断 · {pages[n].columns} 栏 · {pages[n].quality} · {pages[n].blocks.length} 块</summary>
                  {pages[n].blocks.map(block => <pre key={block.id}>{block.id} [{block.kind}] {block.bbox.map(x => x.toFixed(1)).join(', ')}\n{block.text}</pre>)}
                </details>}
              </article>)}
            </div>
          </div>
        </div>
      </section> : <section className="welcome"><div className="welcome-card">
        <div className="welcome-icon">▤</div><h1>从论文开始</h1>
        <p>导入英文原生 PDF，左侧阅读原页，右侧查看按页对应的可重排内容。</p>
        <button onClick={() => pdfInput.current?.click()}>选择 PDF 文件</button>
      </div></section>}
    </div>
    <footer className="status"><span>{notice}</span><span>{NATIVE ? 'Windows 桌面样机 · 资料位于本机 WebView 数据库' : '浏览器原型 · 数据仅存于此浏览器配置'}</span></footer>
    {settingsOpen && <div className="modal-backdrop"><section className="settings-modal" role="dialog" aria-label="翻译设置">
      <h2>翻译设置</h2>
      <p>本地论文管理和已有译文可离线使用。点击“翻译当前页”或“翻译全文”后，所需原文会发送给选定供应商；全文翻译会按页产生 API 用量。</p>
      <label>API Base URL<input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
      <label>模型名<input value={model} onChange={event => setModel(event.target.value)} /></label>
      <label>API Key <span className="muted">{hasKey ? '已保存在 Windows 凭据管理器；留空可保持原值' : '尚未保存'}</span>
        <input type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} />
      </label>
      <div className="modal-actions"><button onClick={() => { setApiKey(''); setSettingsOpen(false) }}>取消</button><button onClick={() => void saveSettings()}>保存</button></div>
    </section></div>}
    {editingPaper && <div className="modal-backdrop"><section className="settings-modal metadata-modal" role="dialog" aria-label="编辑论文信息">
      <h2>编辑论文信息</h2>
      <p>只修改资料库中的显示名称和标签。原 PDF 文件名、文件内容、译文和阅读进度保持不变。</p>
      <label>显示名称<input autoFocus value={titleDraft} maxLength={200}
        onChange={event => setTitleDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void saveMetadata() }} /></label>
      <label>标签<input value={tagsDraft} maxLength={380} placeholder="例如：强化学习，待读，复现"
        onChange={event => setTagsDraft(event.target.value)} /></label>
      <p className="metadata-help">用逗号或分号分隔，最多 12 个标签。原文件：{editingPaper.name}</p>
      <div className="modal-actions"><button onClick={() => setEditingPaper(null)}>取消</button>
        <button onClick={() => void saveMetadata()} disabled={!titleDraft.trim()}>保存</button></div>
    </section></div>}
  </main>
}

export default App
