import { Cpu, Download, Check, AlertTriangle, X, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { estimateUsage, requestPersistence } from '../services/db'
import { engine } from '../services/ttsEngine'

interface Props {
  onClose: () => void
  progress: { file: string; loaded: number; total: number; status: string; overall: number } | null
  state: string
  error: string | null
}

const DTYPES: ['auto' | 'q8' | 'fp16' | 'fp32' | 'q4', string][] = [['auto', 'Auto'], ['q8', 'int8 92MB'], ['fp16', 'fp16 163MB'], ['fp32', 'fp32 325MB']]

/** Model downloader screen: real-time progress + memory/storage info. */
export function ModelLoader({ onClose, progress, state, error }: Props) {
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const [mem, setMem] = useState<number | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [device, setDevice] = useState<'auto' | 'webgpu' | 'wasm'>('auto')
  const [dtype, setDtype] = useState<'auto' | 'q8' | 'fp16' | 'fp32' | 'q4'>('auto')
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator

  useEffect(() => {
    const tick = async () => {
      setUsage(await estimateUsage())
      const perf = performance as unknown as { memory?: { usedJSHeapSize: number } }
      setMem(perf.memory?.usedJSHeapSize ?? null)
    }
    void tick()
    const id = setInterval(tick, 1500)
    void navigator.storage?.persisted?.().then(setPersisted)
    return () => clearInterval(id)
  }, [])

  const ready = state === 'ready' || state === 'paused' || state === 'playing' || state === 'buffering'
  const loading = state === 'loading-model'
  const pct = Math.round((progress?.overall ?? 0) * 100)

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col pt-safe pb-safe">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-xl font-bold">Voice model</h2>
        <button onClick={onClose} className="h-9 w-9 rounded-full bg-neutral-800 flex items-center justify-center"><X size={18} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 space-y-5">
        <div className="rounded-2xl bg-neutral-900 p-5">
          <div className="flex items-start gap-4">
            <div className={`h-12 w-12 rounded-xl flex items-center justify-center ${ready ? 'bg-emerald-500/20 text-emerald-400' : 'bg-neutral-800 text-neutral-300'}`}>
              {ready ? <Check size={24} /> : loading ? <Loader2 size={24} className="animate-spin" /> : <Cpu size={24} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold">Kokoro-82M {engine.backend ? `(${engine.backend.device === 'webgpu' ? 'WebGPU · ' : 'WASM · '}${engine.backend.dtype})` : ''}</p>
              <p className="text-sm text-neutral-400">82M-parameter neural TTS · 92 MB (WASM int8) or 325 MB (WebGPU fp32) · runs fully on-device. 30+ English & Spanish voices.</p>
            </div>
          </div>

          {(loading || ready) && (
            <div className="mt-5">
              <div className="flex justify-between text-xs text-neutral-400 mb-1.5">
                <span className="truncate max-w-[70%]">{ready ? 'Cached in browser storage' : progress?.file ? shortFile(progress.file) : progress?.status ?? 'Starting…'}</span>
                <span>{ready ? '100%' : `${pct}%`}</span>
              </div>
              <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
                <div className={`h-full transition-all duration-300 ${ready ? 'bg-emerald-400' : 'bg-white'}`} style={{ width: `${ready ? 100 : pct}%` }} />
              </div>
              {progress && !ready && progress.total > 0 && (
                <p className="text-[11px] text-neutral-500 mt-1.5">{fmt(progress.loaded)} / {fmt(progress.total)} · {progress.status}</p>
              )}
              {loading && pct === 0 && <p className="text-[11px] text-neutral-500 mt-1.5 pulse-soft">Fetching manifest… first download requires internet</p>}
            </div>
          )}

          {error && (
            <div className="mt-4 flex gap-2 text-sm text-red-400 bg-red-500/10 rounded-xl p-3"><AlertTriangle size={16} className="shrink-0 mt-0.5" /><span>{error}</span></div>
          )}

          {!ready && !loading && (
            <div className="mt-5 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                {(['auto', 'webgpu', 'wasm'] as const).map(d => (
                  <button key={d} onClick={() => setDevice(d)} className={`h-10 rounded-xl ${device === d ? 'bg-white text-black font-medium' : 'bg-neutral-800 text-neutral-300'} ${d === 'auto' ? 'col-span-2' : ''}`}>
                    {d === 'auto' ? `Auto (${hasGpu ? 'WebGPU' : 'WASM'})` : d === 'webgpu' ? 'WebGPU' : 'WASM (CPU)'}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs">
                {DTYPES.map(([id, label]) => (
                  <button key={id} onClick={() => setDtype(id)} className={`h-9 rounded-lg ${dtype === id ? 'bg-white text-black font-medium' : 'bg-neutral-800 text-neutral-300'}`}>{label}</button>
                ))}
              </div>
              <button onClick={() => void engine.loadModel({ device: device === 'auto' ? undefined : device, dtype: dtype === 'auto' ? undefined : dtype })} className="w-full h-12 rounded-xl bg-white text-black font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition">
                <Download size={18} /> Download model
              </button>
              <p className="text-[11px] text-neutral-500">WebGPU + fp32 is fastest where supported (Safari 26+, Chrome). WASM int8 is the smallest and most compatible. If playback stutters, try q4f16 or fp16 on WebGPU.</p>
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-neutral-900 p-5 space-y-3 text-sm">
          <Row label="Storage used" value={usage ? `${fmt(usage.usage)} / ${fmt(usage.quota)}` : '—'} />
          <Row label="JS heap (this tab)" value={mem != null ? fmt(mem) : 'n/a on Safari'} />
          <Row label="Persistent storage" value={persisted == null ? '—' : persisted ? 'Granted' : 'Not granted'} />
          {persisted === false && (
            <button onClick={async () => setPersisted(await requestPersistence())} className="text-xs text-amber-400 underline">Request persistence (prevents iOS eviction)</button>
          )}
          <Row label="Threads" value={typeof SharedArrayBuffer !== 'undefined' ? `${navigator.hardwareConcurrency ?? 1} (SAB ok)` : '1 (no SharedArrayBuffer)'} />
        </div>

        <div className="text-xs text-neutral-500 leading-relaxed pb-8">
          <p className="font-medium text-neutral-400 mb-1">iOS tip</p>
          <p>Install via Share → Add to Home Screen. The model and your books live in this app’s storage; Safari may evict them if the device runs low on space and persistence isn’t granted. Keep ~300 MB free.</p>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between"><span className="text-neutral-400">{label}</span><span className="font-medium tabular-nums">{value}</span></div>
}
function fmt(n: number) { return n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB` }
function shortFile(f: string) { return f.split('/').pop() ?? f }
