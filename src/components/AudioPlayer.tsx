import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, RotateCcw, RotateCw, SkipBack, SkipForward, ChevronDown, Moon, Gauge, Mic2, Loader2 } from 'lucide-react'
import type { Book } from '../types'
import { engine, type EngineState } from '../services/ttsEngine'
import { formatClock, formatDuration } from '../utils/format'

interface Props {
  book: Book
  sentenceId: number
  state: EngineState
  buffered: number
  speed: number
  onSpeed: (s: number) => void
  onOpenVoices: () => void
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

export function AudioPlayer({ book, sentenceId, state, buffered, speed, onSpeed, onOpenVoices }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [sleep, setSleep] = useState<number | 'chapter' | null>(null)
  const [showSleep, setShowSleep] = useState(false)
  const playing = state === 'playing' || state === 'buffering'
  const buffering = state === 'buffering' || state === 'loading-model'
  const sentence = book.sentences[sentenceId]
  const chapter = book.chapters[sentence?.chapterIdx ?? 0]

  // Chapter-relative position (in sentences) for scrubber
  const chapterStart = chapter?.firstSentenceId ?? 0
  const chapterEnd = book.chapters[chapter.idx + 1]?.firstSentenceId ?? book.sentences.length
  const chapterLen = Math.max(1, chapterEnd - chapterStart)
  const posInChapter = sentenceId - chapterStart

  const elapsed = useMemo(() => { let t = 0; for (let i = chapterStart; i < sentenceId; i++) t += engine.durationOf(book.sentences[i]); return t }, [sentenceId, chapterStart, book])
  const chapterTotal = useMemo(() => { let t = 0; for (let i = chapterStart; i < chapterEnd; i++) t += engine.durationOf(book.sentences[i]); return t }, [chapterStart, chapterEnd, book])
  const bookPct = Math.round((sentenceId / book.sentences.length) * 100)

  const coverUrl = useMemo(() => book.coverBlob ? URL.createObjectURL(book.coverBlob) : null, [book.coverBlob])
  useEffect(() => () => { if (coverUrl) URL.revokeObjectURL(coverUrl) }, [coverUrl])

  const pickSleep = (v: number | 'chapter' | null) => { setSleep(v); engine.setSleepTimer(v); setShowSleep(false) }

  // ---------------------------------------------------------------- mini player
  if (!expanded) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 pb-safe">
        <div className="mx-3 mb-2 rounded-2xl bg-neutral-900/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/60 text-white overflow-hidden">
          <div className="h-0.5 bg-white/10"><div className="h-full bg-amber-400 transition-all" style={{ width: `${(posInChapter / chapterLen) * 100}%` }} /></div>
          <div className="flex items-center gap-3 px-3 py-2.5" onClick={() => setExpanded(true)}>
            <div className="h-11 w-11 rounded-lg bg-neutral-800 overflow-hidden shrink-0">
              {coverUrl && <img src={coverUrl} className="h-full w-full object-cover" alt="" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] leading-snug line-clamp-2">{sentence?.text ?? book.title}</p>
              <p className="text-[11px] text-neutral-500 truncate mt-0.5">{chapter?.title} · {buffered > 0 ? `${buffered} ahead` : buffering ? 'buffering…' : ''}</p>
            </div>
            <button onClick={e => { e.stopPropagation(); engine.skip(-15) }} className="h-10 w-10 flex items-center justify-center text-neutral-300 active:scale-90"><RotateCcw size={22} /></button>
            <button onClick={e => { e.stopPropagation(); engine.toggle() }} className="h-11 w-11 rounded-full bg-white text-black flex items-center justify-center active:scale-90 transition">
              {buffering && playing ? <Loader2 size={22} className="animate-spin" /> : playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="ml-0.5" />}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------- full-screen player
  return (
    <div className="fixed inset-0 z-50 bg-gradient-to-b from-neutral-900 to-black text-white flex flex-col pt-safe pb-safe">
      <div className="flex items-center justify-between px-4 pt-2">
        <button onClick={() => setExpanded(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:bg-white/10"><ChevronDown size={26} /></button>
        <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider truncate max-w-[60%]">{book.title}</p>
        <button onClick={onOpenVoices} className="h-10 w-10 flex items-center justify-center rounded-full active:bg-white/10"><Mic2 size={20} /></button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-8 gap-6 min-h-0">
        <div className="w-[min(70vw,300px)] aspect-[2/3] rounded-2xl bg-neutral-800 shadow-2xl shadow-black/70 overflow-hidden shrink">
          {coverUrl ? <img src={coverUrl} className="h-full w-full object-cover" alt="" /> : (
            <div className="h-full w-full p-5 flex flex-col justify-end bg-gradient-to-br from-neutral-700 to-neutral-950"><p className="font-bold text-lg leading-tight">{book.title}</p><p className="text-sm text-neutral-400">{book.author}</p></div>
          )}
        </div>
        <div className="text-center w-full">
          <p className="font-semibold text-lg leading-tight line-clamp-2">{chapter?.title}</p>
          <p className="text-sm text-neutral-400 mt-1">{book.author} · {bookPct}% · {formatDuration(engine.remainingSeconds())} left</p>
        </div>
        <Waveform active={state === 'playing'} />
        <p className="text-[15px] text-neutral-300 text-center leading-relaxed line-clamp-3 min-h-[4.5rem]">{sentence?.text}</p>
      </div>

      <div className="px-6 pb-4 space-y-4">
        <div>
          <input type="range" min={0} max={chapterLen - 1} value={posInChapter} className="w-full"
            onChange={e => engine.seek(chapterStart + Number(e.target.value))} />
          <div className="flex justify-between text-[11px] text-neutral-500 tabular-nums mt-1">
            <span>{formatClock(elapsed)}</span><span>−{formatClock(Math.max(0, chapterTotal - elapsed))}</span>
          </div>
        </div>

        <div className="flex items-center justify-center gap-5">
          <button onClick={() => engine.prevChapter()} className="h-12 w-12 flex items-center justify-center text-neutral-300 active:scale-90"><SkipBack size={26} fill="currentColor" /></button>
          <button onClick={() => engine.skip(-15)} className="h-12 w-12 flex items-center justify-center relative active:scale-90"><RotateCcw size={32} /><span className="absolute text-[9px] font-bold mt-0.5">15</span></button>
          <button onClick={() => engine.toggle()} className="h-18 w-18 rounded-full bg-white text-black flex items-center justify-center active:scale-95 transition shadow-lg shadow-white/10">
            {buffering && playing ? <Loader2 size={30} className="animate-spin" /> : playing ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" className="ml-1" />}
          </button>
          <button onClick={() => engine.skip(15)} className="h-12 w-12 flex items-center justify-center relative active:scale-90"><RotateCw size={32} /><span className="absolute text-[9px] font-bold mt-0.5">15</span></button>
          <button onClick={() => engine.nextChapter()} className="h-12 w-12 flex items-center justify-center text-neutral-300 active:scale-90"><SkipForward size={26} fill="currentColor" /></button>
        </div>

        <div className="flex items-center justify-between text-sm">
          <button onClick={() => onSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} className="h-10 px-4 rounded-full bg-white/10 flex items-center gap-1.5 font-medium tabular-nums"><Gauge size={16} />{speed}×</button>
          <div className="relative">
            <button onClick={() => setShowSleep(s => !s)} className={`h-10 px-4 rounded-full flex items-center gap-1.5 font-medium ${sleep ? 'bg-amber-400/20 text-amber-300' : 'bg-white/10'}`}>
              <Moon size={16} />{sleep === 'chapter' ? 'End of chapter' : sleep ? `${sleep} min` : 'Sleep'}
            </button>
            {showSleep && (
              <div className="absolute bottom-12 right-0 bg-neutral-800 rounded-2xl p-1.5 shadow-xl min-w-44 z-10">
                {([15, 30, 45, 'chapter', null] as const).map(v => (
                  <button key={String(v)} onClick={() => pickSleep(v)} className={`w-full text-left px-3 py-2.5 rounded-xl text-sm ${sleep === v ? 'bg-white/10' : ''}`}>
                    {v === null ? 'Off' : v === 'chapter' ? 'End of chapter' : `${v} minutes`}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Lightweight CSS-driven waveform: real analyser data isn't worth the battery on iOS; this animates when playing. */
function Waveform({ active }: { active: boolean }) {
  const bars = 28
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const el = ref.current
      if (el) {
        const children = el.children
        for (let i = 0; i < children.length; i++) {
          const phase = (t - t0) / 1000 * 3 + i * 0.45
          const h = 0.25 + 0.75 * Math.abs(Math.sin(phase) * Math.sin(phase * 0.37 + i))
          ;(children[i] as HTMLElement).style.transform = `scaleY(${h})`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])
  return (
    <div ref={ref} className="flex items-center gap-[3px] h-10 w-full max-w-xs">
      {Array.from({ length: bars }).map((_, i) => (
        <div key={i} className="flex-1 h-full rounded-full bg-amber-400/80 origin-center transition-transform duration-150" style={{ transform: `scaleY(${active ? 0.4 : 0.12})` }} />
      ))}
    </div>
  )
}
