/**
 * Client-side EPUB (and .txt) parsing with jszip + DOMParser.
 * Produces a fully segmented Book (chapters → paragraphs → sentences with speaker roles).
 */
import JSZip from 'jszip'
import type { Book, Chapter, Lang, Paragraph, Sentence } from '../types'
import { DialogueContext, splitSentences } from './dialogueParser'

const MAX_PARAGRAPH_CHARS = 1400 // split very long paragraphs so highlight granularity stays sane

export async function parseFile(file: File): Promise<Book> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.txt')) return parseTxt(file)
  if (name.endsWith('.epub')) return parseEpub(file)
  throw new Error('Unsupported file type. Use .epub or .txt')
}

// ---------------------------------------------------------------- TXT

async function parseTxt(file: File): Promise<Book> {
  const text = await file.text()
  const lang = detectLang(text.slice(0, 5000))
  const rawParas = text.split(/\n\s*\n|\r\n\s*\r\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const builder = new BookBuilder(lang)
  // Chapter breaks: "Chapter N" / "Capítulo N" / all-caps short lines
  let currentTitle = file.name.replace(/\.txt$/i, '')
  builder.startChapter(currentTitle, 'txt')
  for (const p of rawParas) {
    if (/^(chapter|capítulo|cap\.|parte|part|libro|book)\s+[\divxlc]+/i.test(p) && p.length < 80) {
      currentTitle = p
      builder.startChapter(p, 'txt')
      builder.addParagraph(p, 1)
    } else {
      builder.addParagraph(p, 0)
    }
  }
  return builder.finish({ title: file.name.replace(/\.txt$/i, ''), author: 'Unknown', lang })
}

// ---------------------------------------------------------------- EPUB

export async function parseEpub(file: File): Promise<Book> {
  const zip = await JSZip.loadAsync(file)
  const dom = new DOMParser()

  // 1. container.xml → OPF path
  const containerXml = await readText(zip, 'META-INF/container.xml')
  const container = dom.parseFromString(containerXml, 'application/xml')
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path')
  if (!opfPath) throw new Error('Invalid EPUB: missing rootfile')
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  // 2. OPF → metadata, manifest, spine
  const opf = dom.parseFromString(await readText(zip, opfPath), 'application/xml')
  const meta = (tag: string) => opf.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() ?? ''
  const title = meta('title') || file.name.replace(/\.epub$/i, '')
  const author = meta('creator') || 'Unknown'
  const langRaw = meta('language').toLowerCase()

  const manifest = new Map<string, { href: string; type: string; props: string }>()
  for (const item of Array.from(opf.getElementsByTagNameNS('*', 'item'))) {
    manifest.set(item.getAttribute('id') ?? '', {
      href: decodeURIComponent(item.getAttribute('href') ?? ''),
      type: item.getAttribute('media-type') ?? '',
      props: item.getAttribute('properties') ?? '',
    })
  }
  const spineIds = Array.from(opf.getElementsByTagNameNS('*', 'itemref'))
    .filter(r => r.getAttribute('linear') !== 'no')
    .map(r => r.getAttribute('idref') ?? '')

  // 3. Cover
  let coverBlob: Blob | undefined
  const coverId = Array.from(opf.getElementsByTagNameNS('*', 'meta')).find(m => m.getAttribute('name') === 'cover')?.getAttribute('content')
  let coverHref = coverId ? manifest.get(coverId)?.href : undefined
  if (!coverHref) coverHref = Array.from(manifest.values()).find(m => m.props.includes('cover-image'))?.href
  if (!coverHref) coverHref = Array.from(manifest.values()).find(m => m.type.startsWith('image/') && /cover/i.test(m.href))?.href
  if (coverHref) {
    const f = zip.file(resolvePath(opfDir, coverHref))
    if (f) coverBlob = new Blob([await f.async('arraybuffer')], { type: manifest.get(coverId ?? '')?.type || guessMime(coverHref) })
  }

  // 4. TOC (nav.xhtml or toc.ncx) → href → title
  const tocTitles = new Map<string, string>()
  const navItem = Array.from(manifest.values()).find(m => m.props.includes('nav'))
  if (navItem) {
    const navDoc = dom.parseFromString(await readText(zip, resolvePath(opfDir, navItem.href)), 'application/xhtml+xml')
    const navDir = dirOf(resolvePath(opfDir, navItem.href))
    for (const a of Array.from(navDoc.querySelectorAll('nav a[href]'))) {
      const href = normalizeHref(resolvePath(navDir, a.getAttribute('href')!))
      if (!tocTitles.has(href)) tocTitles.set(href, a.textContent?.trim() ?? '')
    }
  } else {
    const ncx = Array.from(manifest.values()).find(m => m.type === 'application/x-dtbncx+xml')
    if (ncx) {
      const ncxDoc = dom.parseFromString(await readText(zip, resolvePath(opfDir, ncx.href)), 'application/xml')
      const ncxDir = dirOf(resolvePath(opfDir, ncx.href))
      for (const np of Array.from(ncxDoc.getElementsByTagNameNS('*', 'navPoint'))) {
        const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent?.trim() ?? ''
        const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src')
        if (src) {
          const href = normalizeHref(resolvePath(ncxDir, decodeURIComponent(src)))
          if (!tocTitles.has(href)) tocTitles.set(href, label)
        }
      }
    }
  }

  // 5. Walk spine, extract text
  let sampleText = ''
  const builder = new BookBuilder(langRaw.startsWith('es') ? 'es' : langRaw.startsWith('en') ? 'en' : 'en')
  let chapterNo = 0
  for (const id of spineIds) {
    const item = manifest.get(id)
    if (!item || !/html|xml/.test(item.type)) continue
    const path = resolvePath(opfDir, item.href)
    const zf = zip.file(path)
    if (!zf) continue
    const html = await zf.async('text')
    const doc = dom.parseFromString(html, 'application/xhtml+xml')
    const body = doc.querySelector('body') ?? dom.parseFromString(html, 'text/html').body
    if (!body) continue

    // Strip noise
    body.querySelectorAll('script, style, svg, img, figure, nav, aside, sup.footnote, [epub\\:type="pagebreak"]').forEach(n => n.remove())

    const blocks = extractBlocks(body)
    if (blocks.every(b => !b.text.trim())) continue

    chapterNo++
    const tocTitle = tocTitles.get(normalizeHref(path))
    const firstHeading = blocks.find(b => b.heading > 0)?.text
    const chapterTitle = tocTitle || firstHeading || `Chapter ${chapterNo}`
    builder.startChapter(chapterTitle, path)
    for (const b of blocks) {
      if (!b.text) continue
      builder.addParagraph(b.text, b.heading)
      if (sampleText.length < 6000) sampleText += b.text + ' '
    }
  }

  const lang: Lang = langRaw.startsWith('es') ? 'es' : langRaw.startsWith('en') ? 'en' : detectLang(sampleText)
  builder.setLang(lang)
  return builder.finish({ title, author, lang, coverBlob })
}

// ---------------------------------------------------------------- Block extraction

interface Block { text: string; heading: 0 | 1 | 2 | 3 }

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'DT', 'DD', 'SECTION', 'ARTICLE', 'BR', 'HR'])

function extractBlocks(body: Element): Block[] {
  const blocks: Block[] = []
  let buf = ''
  let heading: 0 | 1 | 2 | 3 = 0

  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim()
    if (t) blocks.push({ text: t, heading })
    buf = ''
    heading = 0
  }

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { buf += node.textContent ?? ''; return }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    const tag = el.tagName.toUpperCase()
    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock) flush()
    if (/^H[1-6]$/.test(tag)) heading = Math.min(3, parseInt(tag[1])) as 1 | 2 | 3
    for (const child of Array.from(el.childNodes)) walk(child)
    if (isBlock) flush()
  }
  walk(body)
  flush()
  return blocks
}

// ---------------------------------------------------------------- Builder

class BookBuilder {
  private chapters: Chapter[] = []
  private paragraphs: Paragraph[] = []
  private sentences: Sentence[] = []
  private ctx = new DialogueContext()
  private lang: Lang

  constructor(lang: Lang) { this.lang = lang }
  setLang(l: Lang) { this.lang = l }

  startChapter(title: string, href: string) {
    this.ctx.reset()
    this.chapters.push({ idx: this.chapters.length, title: title.slice(0, 120), href, paragraphIds: [], firstSentenceId: this.sentences.length, wordCount: 0 })
  }

  addParagraph(text: string, heading: 0 | 1 | 2 | 3) {
    if (this.chapters.length === 0) this.startChapter('Untitled', '')
    const ch = this.chapters[this.chapters.length - 1]
    // Split pathological long paragraphs at sentence boundaries
    const chunks = text.length > MAX_PARAGRAPH_CHARS ? chunkBySentences(text, MAX_PARAGRAPH_CHARS) : [text]
    for (const chunk of chunks) {
      const pid = this.paragraphs.length
      const segs = heading > 0
        ? splitSentences(chunk).map(r => ({ ...r, role: 'narrator' as const, dialogue: false }))
        : this.ctx.segment(chunk, this.lang)
      const sentenceIds: number[] = []
      for (const r of segs) {
        const sid = this.sentences.length
        this.sentences.push({ id: sid, text: chunk.slice(r.start, r.end).trim(), paragraphIdx: pid, chapterIdx: ch.idx, role: r.role, start: r.start, end: r.end })
        sentenceIds.push(sid)
      }
      this.paragraphs.push({ id: pid, chapterIdx: ch.idx, text: chunk, heading, sentenceIds })
      ch.paragraphIds.push(pid)
      ch.wordCount += chunk.split(/\s+/).length
    }
  }

  finish(meta: { title: string; author: string; lang: Lang; coverBlob?: Blob }): Book {
    const chapters = this.chapters.filter(c => c.paragraphIds.length > 0)
    // Re-index chapters after filtering
    const remap = new Map<number, number>()
    chapters.forEach((c, i) => { remap.set(c.idx, i); c.idx = i })
    for (const p of this.paragraphs) p.chapterIdx = remap.get(p.chapterIdx) ?? p.chapterIdx
    for (const s of this.sentences) s.chapterIdx = remap.get(s.chapterIdx) ?? s.chapterIdx
    const wordCount = chapters.reduce((a, c) => a + c.wordCount, 0)
    return {
      id: crypto.randomUUID(),
      title: meta.title, author: meta.author, language: meta.lang, coverBlob: meta.coverBlob,
      addedAt: Date.now(), wordCount, sentenceCount: this.sentences.length, chapterCount: chapters.length,
      chapters, paragraphs: this.paragraphs, sentences: this.sentences,
    }
  }
}

function chunkBySentences(text: string, max: number): string[] {
  const ranges = splitSentences(text)
  const out: string[] = []
  let cur = ''
  for (const r of ranges) {
    const s = text.slice(r.start, r.end)
    if (cur.length + s.length > max && cur) { out.push(cur.trim()); cur = '' }
    cur += s + ' '
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// ---------------------------------------------------------------- Utils

async function readText(zip: JSZip, path: string): Promise<string> {
  const f = zip.file(path) ?? zip.file(decodeURIComponent(path))
  if (!f) throw new Error(`EPUB missing ${path}`)
  return f.async('text')
}

function dirOf(p: string) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '' }

function resolvePath(base: string, rel: string): string {
  if (rel.startsWith('/')) return rel.slice(1)
  const parts = (base + rel).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return out.join('/')
}

function normalizeHref(h: string) { return h.split('#')[0] }

function guessMime(href: string) {
  if (/\.png$/i.test(href)) return 'image/png'
  if (/\.gif$/i.test(href)) return 'image/gif'
  if (/\.webp$/i.test(href)) return 'image/webp'
  if (/\.svg$/i.test(href)) return 'image/svg+xml'
  return 'image/jpeg'
}

export function detectLang(sample: string): Lang {
  const es = (sample.match(/\b(el|la|los|las|de|que|y|en|un|una|por|con|para|es|no|se|su|al|lo|como|más|pero)\b/gi) ?? []).length
  const en = (sample.match(/\b(the|and|of|to|a|in|that|is|was|he|for|it|with|as|his|on|be|at|by|i)\b/gi) ?? []).length
  return es > en * 1.2 ? 'es' : 'en'
}
