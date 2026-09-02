import { useEffect, useRef, useState } from 'react'
import { BookOpen, Loader2, Plus, Trash2, Cpu, HardDrive } from 'lucide-react'
import type { BookMeta, Progress } from '../types'
import { deleteBook, estimateUsage, getAllProgress, listBooks, saveBook } from '../services/db'
import { parseFile } from '../services/epubParser'
import { formatDuration } from '../utils/format'

interface Props {
  onOpen: (id: string) => void
  onOpenModel: () => void
  modelState: 'idle' | 'loading' | 'ready' | 'error'
}

export function LibraryView({ onOpen, onOpenModel, modelState }: Props) {
  const [books, setBooks] = useState<BookMeta[]>([])
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [sentenceCounts, setSentenceCounts] = useState<Record<string, number>>({})
  const [importing, setImporting] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = async () => {
    const [b, p, u] = await Promise.all([listBooks(), getAllProgress(), estimateUsage()])
    setBooks(b); setProgress(p); setUsage(u)
    setSentenceCounts(Object.fromEntries(b.map(x => [x.id, x.sentenceCount])))
  }
  useEffect(() => { void refresh() }, [])

  const importFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setImporting(f.name)
      try {
        const book = await parseFile(f)
        await saveBook(book)
      } catch (e) {
        alert(`Failed to import ${f.name}: ${(e as Error).message}`)
      }
    }
    setImporting(null)
    await refresh()
  }

  return (
    <div
      className="min-h-dvh bg-black text-white pt-safe pb-safe"
      onDragOver={e => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); void importFiles(e.dataTransfer.files) }}
    >
      <header className="px-5 pt-4 pb-3 flex items-center justify-between sticky top-0 bg-black/80 backdrop-blur-md z-10 pt-safe">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Library</h1>
          <p className="text-xs text-neutral-500 mt-0.5">{books.length} {books.length === 1 ? 'book' : 'books'}{usage ? ` · ${fmtBytes(usage.usage)} used` : ''}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={onOpenModel} className={`h-10 px-2.5 sm:px-3 rounded-full flex items-center gap-1.5 text-xs sm:text-sm font-medium whitespace-nowrap ${modelState === 'ready' ? 'bg-emerald-500/15 text-emerald-400' : modelState === 'loading' ? 'bg-amber-500/15 text-amber-400' : 'bg-neutral-800 text-neutral-300'}`}>
            {modelState === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Cpu size={16} />}
            {modelState === 'ready' ? 'Model ready' : modelState === 'loading' ? 'Loading…' : 'Voice model'}
          </button>
          <button onClick={() => fileRef.current?.click()} className="h-10 w-10 rounded-full bg-white text-black flex items-center justify-center active:scale-95 transition">
            <Plus size={20} />
          </button>
          <input ref={fileRef} type="file" accept=".epub,.txt,application/epub+zip,text/plain" multiple hidden onChange={e => e.target.files && void importFiles(e.target.files)} />
        </div>
      </header>

      {importing && (
        <div className="mx-5 mb-3 rounded-xl bg-neutral-900 px-4 py-3 flex items-center gap-3 text-sm">
          <Loader2 size={18} className="animate-spin text-neutral-400" />
          <span className="truncate">Parsing <span className="text-neutral-300">{importing}</span>…</span>
        </div>
      )}

      {books.length === 0 && !importing ? (
        <div className={`mx-5 mt-10 rounded-3xl border-2 border-dashed ${drag ? 'border-white bg-white/5' : 'border-neutral-800'} p-10 flex flex-col items-center text-center gap-4 transition`}
          onClick={() => fileRef.current?.click()}>
          <div className="h-16 w-16 rounded-2xl bg-neutral-900 flex items-center justify-center"><BookOpen size={28} className="text-neutral-400" /></div>
          <div>
            <p className="font-semibold text-lg">Add your first book</p>
            <p className="text-sm text-neutral-500 mt-1">Tap to pick an .epub or .txt file. Everything stays on this device.</p>
          </div>
        </div>
      ) : (
        <div className="grid library-grid grid-cols-3 gap-x-4 gap-y-6 px-5 pt-2 pb-24">
          {books.map(b => {
            const p = progress[b.id]
            const pct = p && sentenceCounts[b.id] ? Math.min(100, Math.round((p.sentenceId / sentenceCounts[b.id]) * 100)) : 0
            const remainingWords = b.wordCount * (1 - pct / 100)
            return (
              <BookCard key={b.id} book={b} pct={pct} remaining={formatDuration(remainingWords / 2.6)} onOpen={() => onOpen(b.id)}
                onDelete={async () => { if (confirm(`Delete "${b.title}"?`)) { await deleteBook(b.id); void refresh() } }} />
            )
          })}
        </div>
      )}

      {usage && usage.quota > 0 && (
        <div className="fixed bottom-0 inset-x-0 pb-safe px-safe pointer-events-none">
          <div className="mx-5 mb-3 text-[11px] text-neutral-600 flex items-center gap-1.5"><HardDrive size={12} />{fmtBytes(usage.usage)} of {fmtBytes(usage.quota)} available storage</div>
        </div>
      )}
    </div>
  )
}

function BookCard({ book, pct, remaining, onOpen, onDelete }: { book: BookMeta; pct: number; remaining: string; onOpen: () => void; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!book.coverBlob) return
    const u = URL.createObjectURL(book.coverBlob); setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [book.coverBlob])
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  return (
    <button
      className="text-left group active:scale-[0.97] transition select-none"
      onClick={onOpen}
      onContextMenu={e => { e.preventDefault(); onDelete() }}
      onTouchStart={() => { pressTimer.current = setTimeout(onDelete, 650) }}
      onTouchEnd={() => pressTimer.current && clearTimeout(pressTimer.current)}
      onTouchMove={() => pressTimer.current && clearTimeout(pressTimer.current)}
    >
      <div className="aspect-[2/3] rounded-lg overflow-hidden bg-neutral-900 shadow-lg shadow-black/50 relative">
        {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : (
          <div className="h-full w-full p-3 flex flex-col justify-end bg-gradient-to-br from-neutral-800 to-neutral-950">
            <p className="text-[13px] font-semibold leading-tight line-clamp-4">{book.title}</p>
            <p className="text-[11px] text-neutral-400 mt-1 line-clamp-1">{book.author}</p>
          </div>
        )}
        {pct > 0 && <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40"><div className="h-full bg-amber-400" style={{ width: `${pct}%` }} /></div>}
        <span className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition"><Trash2 size={14} className="text-white/70" /></span>
      </div>
      <p className="mt-2 text-[13px] font-medium leading-tight line-clamp-2">{book.title}</p>
      <p className="text-[11px] text-neutral-500 mt-0.5">{pct > 0 ? `${pct}% · ${remaining} left` : `${formatDuration(book.wordCount / 2.6)}`}</p>
    </button>
  )
}

function fmtBytes(n: number) {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n > 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.round(n / 1e3)} KB`
}
