import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, List, Type, Mic2, Minus, Plus } from 'lucide-react'
import type { Book, DialogueMode, ReaderSettings, VoiceConfig } from '../types'
import { engine } from '../services/ttsEngine'
import { setProgress, setSettings } from '../services/db'
import { AudioPlayer } from './AudioPlayer'
import { VoiceConfigModal } from './VoiceConfigModal'
import { useEngine } from '../hooks/useEngine'

interface Props {
  book: Book
  voices: VoiceConfig
  settings: ReaderSettings
  onVoices: (v: VoiceConfig) => void
  onMode: (m: DialogueMode) => void
  onSettings: (s: ReaderSettings) => void
  onBack: () => void
}

const FONT_STACK: Record<ReaderSettings['font'], string> = {
  literata: '"Literata", Georgia, serif',
  bookerly: '"Bookerly", "Palatino", "Book Antiqua", Georgia, serif',
  serif: 'Georgia, "Times New Roman", serif',
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif',
}

export function ReaderView({ book, voices, settings, onVoices, onMode, onSettings, onBack }: Props) {
  const { state, sentenceId, buffered, error } = useEngine()
  const [chapterIdx, setChapterIdx] = useState(book.sentences[sentenceId]?.chapterIdx ?? 0)
  const [showToc, setShowToc] = useState(false)
  const [showType, setShowType] = useState(false)
  const [showVoices, setShowVoices] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [followAudio, setFollowAudio] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastAutoScroll = useRef(0)

  const playing = state === 'playing' || state === 'buffering'
  const currentSentence = book.sentences[sentenceId]
  const activeParagraph = currentSentence?.paragraphIdx

  // Follow audio into other chapters
  useEffect(() => {
    if (currentSentence && currentSentence.chapterIdx !== chapterIdx && followAudio) setChapterIdx(currentSentence.chapterIdx)
  }, [currentSentence, chapterIdx, followAudio])

  // Persist progress (debounced)
  useEffect(() => {
    const t = setTimeout(() => void setProgress(book.id, sentenceId), 800)
    return () => clearTimeout(t)
  }, [book.id, sentenceId])

  // Karaoke autoscroll: keep active sentence in the middle third
  useEffect(() => {
    if (!followAudio) return
    const el = document.getElementById(`s-${sentenceId}`)
    const sc = scrollRef.current
    if (!el || !sc) return
    const r = el.getBoundingClientRect(), c = sc.getBoundingClientRect()
    const inComfortZone = r.top > c.top + c.height * 0.2 && r.bottom < c.bottom - c.height * 0.35
    if (!inComfortZone) {
      lastAutoScroll.current = Date.now()
      el.scrollIntoView({ block: 'center', behavior: playing ? 'smooth' : 'auto' })
    }
  }, [sentenceId, chapterIdx, followAudio, playing])

  // User scroll disables follow until they tap a paragraph or the "resume" pill
  const onScroll = () => { if (Date.now() - lastAutoScroll.current > 900 && playing) setFollowAudio(false) }

  const chapter = book.chapters[chapterIdx]
  const paragraphs = useMemo(() => chapter.paragraphIds.map(id => book.paragraphs[id]), [chapter, book])

  const tapParagraph = (pid: number, sid?: number) => {
    const target = sid ?? book.paragraphs[pid].sentenceIds[0]
    setFollowAudio(true)
    void engine.play(target)
  }

  const updateSettings = (patch: Partial<ReaderSettings>) => { const s = { ...settings, ...patch }; onSettings(s); void setSettings(s) }

  const themeClass = `theme-${settings.theme}`
  const dark = settings.theme === 'black'

  return (
    <div className={`${themeClass} reader-surface h-dvh flex flex-col overflow-hidden`}>
      {/* Top chrome */}
      <header className={`absolute top-0 inset-x-0 z-30 pt-safe transition-transform duration-300 ${chromeVisible ? '' : '-translate-y-full'}`}>
        <div className={`flex items-center justify-between px-2 chrome-px h-12 backdrop-blur-xl ${dark ? 'bg-black/70' : 'bg-[var(--bg)]/80'} border-b border-current/5`}>
          <button onClick={onBack} className="h-10 w-10 flex items-center justify-center rounded-full active:opacity-60"><ChevronLeft size={26} /></button>
          <div className="text-center min-w-0 flex-1 px-2">
            <p className="text-[13px] font-medium truncate">{chapter.title}</p>
            <p className="text-[10px] reader-muted">{chapterIdx + 1} / {book.chapters.length} · {Math.round((sentenceId / book.sentences.length) * 100)}%</p>
          </div>
          <div className="flex">
            <button onClick={() => setShowType(v => !v)} className="h-10 w-10 flex items-center justify-center rounded-full active:opacity-60"><Type size={20} /></button>
            <button onClick={() => setShowVoices(true)} className="h-10 w-10 flex items-center justify-center rounded-full active:opacity-60"><Mic2 size={20} /></button>
            <button onClick={() => setShowToc(true)} className="h-10 w-10 flex items-center justify-center rounded-full active:opacity-60"><List size={22} /></button>
          </div>
        </div>
        {showType && (
          <div className={`mx-3 mt-2 rounded-2xl p-4 shadow-xl backdrop-blur-xl ${dark ? 'bg-neutral-900/95' : 'bg-[var(--card)]'} space-y-4 text-sm`}>
            <div className="flex items-center justify-between gap-3">
              <span className="reader-muted">Size</span>
              <div className="flex items-center gap-2">
                <button onClick={() => updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })} className="h-9 w-9 rounded-full bg-current/10 flex items-center justify-center"><Minus size={16} /></button>
                <span className="w-8 text-center tabular-nums">{settings.fontSize}</span>
                <button onClick={() => updateSettings({ fontSize: Math.min(32, settings.fontSize + 1) })} className="h-9 w-9 rounded-full bg-current/10 flex items-center justify-center"><Plus size={16} /></button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="reader-muted">Spacing</span>
              <div className="flex gap-1.5">{[1.4, 1.65, 1.9].map(lh => <button key={lh} onClick={() => updateSettings({ lineHeight: lh })} className={`h-9 px-3 rounded-full text-xs ${settings.lineHeight === lh ? 'bg-current/20 font-semibold' : 'bg-current/8'}`}>{lh}</button>)}</div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="reader-muted">Font</span>
              <div className="flex gap-1.5">{(['literata', 'bookerly', 'serif', 'sans'] as const).map(f => <button key={f} onClick={() => updateSettings({ font: f })} style={{ fontFamily: FONT_STACK[f] }} className={`h-9 px-3 rounded-full text-xs capitalize ${settings.font === f ? 'bg-current/20 font-semibold' : 'bg-current/8'}`}>{f}</button>)}</div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="reader-muted">Theme</span>
              <div className="flex gap-2">
                {([['black', '#000', '#eee'], ['sepia', '#f4ecd8', '#3d2f1e'], ['light', '#fafafa', '#171717']] as const).map(([t, bg, fg]) => (
                  <button key={t} onClick={() => updateSettings({ theme: t })} className={`h-9 w-9 rounded-full border-2 ${settings.theme === t ? 'border-amber-400' : 'border-transparent'}`} style={{ background: bg, color: fg }}>Aa</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Text */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-6 reader-pad px-safe no-scrollbar"
        onClick={e => { if (e.target === e.currentTarget) setChromeVisible(v => !v) }}>
        <div className="max-w-2xl mx-auto pt-20 pb-40" style={{ fontFamily: FONT_STACK[settings.font], fontSize: settings.fontSize, lineHeight: settings.lineHeight }}>
          {paragraphs.map(p => {
            const isActivePara = p.id === activeParagraph
            const Tag = p.heading === 1 ? 'h1' : p.heading === 2 ? 'h2' : p.heading === 3 ? 'h3' : 'p'
            const headingCls = p.heading === 1 ? 'text-[1.6em] font-bold mt-8 mb-6 text-center leading-tight' : p.heading === 2 ? 'text-[1.3em] font-semibold mt-6 mb-4' : p.heading === 3 ? 'text-[1.1em] font-semibold mt-4 mb-3' : 'mb-[0.9em] text-justify hyphens-auto'
            return (
              <Tag key={p.id} id={`p-${p.id}`} className={`paragraph ${isActivePara ? 'active' : ''} ${headingCls} px-1.5 -mx-1.5 py-0.5 cursor-pointer`}
                onClick={(e) => { e.stopPropagation(); if (!(e.target as HTMLElement).closest('.sentence')) tapParagraph(p.id) }}>
                {p.sentenceIds.map((sid) => {
                  const s = book.sentences[sid]
                  const isActive = sid === sentenceId
                  const tone = s.role === 'male' ? 'opacity-95' : s.role === 'female' ? 'opacity-95' : ''
                  return (
                    <span key={sid} id={`s-${sid}`} className={`sentence ${isActive ? 'active' : ''} ${tone}`}
                      onClick={(e) => { e.stopPropagation(); tapParagraph(p.id, sid) }}>
                      {s.text}{' '}
                    </span>
                  )
                })}
              </Tag>
            )
          })}
          <div className="flex justify-between mt-10 text-sm reader-muted">
            {chapterIdx > 0 ? <button onClick={() => { setFollowAudio(false); setChapterIdx(chapterIdx - 1); scrollRef.current?.scrollTo(0, 0) }}>← Previous</button> : <span />}
            {chapterIdx < book.chapters.length - 1 && <button onClick={() => { setFollowAudio(false); setChapterIdx(chapterIdx + 1); scrollRef.current?.scrollTo(0, 0) }}>Next →</button>}
          </div>
        </div>
      </div>

      {!followAudio && playing && (
        <button onClick={() => { setFollowAudio(true); setChapterIdx(currentSentence.chapterIdx) }}
          className="fixed left-1/2 -translate-x-1/2 bottom-28 mb-safe z-40 h-9 px-4 rounded-full bg-amber-400 text-black text-xs font-semibold shadow-lg active:scale-95">
          Return to audio position
        </button>
      )}

      {error && <div className="fixed top-16 inset-x-4 z-50 rounded-xl bg-red-500/90 text-white text-sm px-4 py-2.5 shadow-xl">{error}</div>}

      <AudioPlayer book={book} sentenceId={sentenceId} state={state} buffered={buffered} speed={voices.speed}
        onSpeed={s => onVoices({ ...voices, speed: s })} onOpenVoices={() => setShowVoices(true)} />

      {showToc && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end" onClick={() => setShowToc(false)}>
          <div className={`${themeClass} reader-surface w-[85vw] max-w-sm h-full overflow-y-auto pt-safe pb-safe pl-safe shadow-2xl`} onClick={e => e.stopPropagation()}>
            <p className="px-5 pt-5 pb-3 text-xs font-semibold uppercase tracking-wider reader-muted">Contents · {book.chapters.length}</p>
            {book.chapters.map(c => (
              <button key={c.idx} onClick={() => { setShowToc(false); setFollowAudio(true); engine.seek(c.firstSentenceId); setChapterIdx(c.idx) }}
                className={`w-full text-left px-5 py-3 text-[15px] border-b border-current/5 ${c.idx === chapterIdx ? 'font-semibold bg-current/5' : ''}`}>
                <span className="reader-muted text-xs mr-2 tabular-nums">{c.idx + 1}</span>{c.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {showVoices && (
        <VoiceConfigModal config={voices} lang={book.language} mode={book.dialogueMode ?? 'punctuation'} onMode={onMode} onClose={() => setShowVoices(false)}
          onChange={onVoices} onPreview={() => { /* changes apply live to next sentence */ }} />
      )}
    </div>
  )
}
