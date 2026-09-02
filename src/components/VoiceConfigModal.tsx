import { X, Mic2, User, UserRound, Gauge, MessageSquareQuote } from 'lucide-react'
import { VOICE_CATALOG, type DialogueMode, type Lang, type VoiceConfig, type VoiceId } from '../types'

interface Props {
  config: VoiceConfig
  lang: Lang
  mode: DialogueMode
  onMode: (m: DialogueMode) => void
  onChange: (c: VoiceConfig) => void
  onClose: () => void
  onPreview: (voice: VoiceId) => void
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]
const MODES: { id: DialogueMode; label: string; hint: string }[] = [
  { id: 'punctuation', label: 'Punctuation', hint: 'Quotes “…” and dashes —… mark speech' },
  { id: 'tags', label: 'Speech tags', hint: 'No quotes in this book: uses "dije / dijo Bangley" anchors' },
  { id: 'solo', label: 'Solo narrator', hint: 'One voice; spoken lines slightly slower' },
]

export function VoiceConfigModal({ config, lang, mode, onMode, onChange, onClose, onPreview }: Props) {
  const set = <K extends keyof VoiceConfig>(k: K, v: VoiceConfig[K]) => onChange({ ...config, [k]: v })
  const voices = [...VOICE_CATALOG].sort((a, b) => (a.lang === lang ? -1 : 1) - (b.lang === lang ? -1 : 1))

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-neutral-950 text-white rounded-t-3xl max-h-[88dvh] flex flex-col pb-safe" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div><h2 className="text-lg font-bold">Voices</h2><p className="text-xs text-neutral-500">Saved per book</p></div>
          <button onClick={onClose} className="h-9 w-9 rounded-full bg-neutral-800 flex items-center justify-center"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto px-5 pb-6 space-y-6">
          <section>
            <p className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2 flex items-center gap-1.5"><Gauge size={14} /> Speed</p>
            <div className="grid grid-cols-5 gap-2">
              {SPEEDS.map(s => (
                <button key={s} onClick={() => set('speed', s)} className={`h-10 rounded-xl text-sm font-medium ${config.speed === s ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-300'}`}>{s}×</button>
              ))}
            </div>
          </section>

          <section>
            <p className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2 flex items-center gap-1.5"><MessageSquareQuote size={14} /> Dialogue detection</p>
            <div className="grid grid-cols-3 gap-2">
              {MODES.map(m => (
                <button key={m.id} onClick={() => onMode(m.id)} className={`h-10 rounded-xl text-sm font-medium ${mode === m.id ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-300'}`}>{m.label}</button>
              ))}
            </div>
            <p className="text-[11px] text-neutral-600 mt-1.5">{MODES.find(m => m.id === mode)?.hint}</p>
          </section>

          <VoiceRow icon={<Mic2 size={14} />} label="Narrator" hint="Descriptive text" value={config.narrator} voices={voices} onChange={v => set('narrator', v)} onPreview={onPreview} />
          <VoiceRow icon={<User size={14} />} label="Male dialogue" hint="“…” he said / —dijo él" value={config.male} voices={voices} onChange={v => set('male', v)} onPreview={onPreview} />
          <VoiceRow icon={<UserRound size={14} />} label="Female dialogue" hint="“…” she said / —dijo ella" value={config.female} voices={voices} onChange={v => set('female', v)} onPreview={onPreview} />
          <VoiceRow icon={<UserRound size={14} />} label="Unknown speaker" hint="Dialogue with no gender cue" value={config.unknown} voices={voices} onChange={v => set('unknown', v)} onPreview={onPreview} />
        </div>
      </div>
    </div>
  )
}

function VoiceRow({ icon, label, hint, value, voices, onChange, onPreview }: {
  icon: React.ReactNode; label: string; hint: string; value: VoiceId
  voices: typeof VOICE_CATALOG; onChange: (v: VoiceId) => void; onPreview: (v: VoiceId) => void
}) {
  return (
    <section>
      <p className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-0.5 flex items-center gap-1.5">{icon} {label}</p>
      <p className="text-[11px] text-neutral-600 mb-2">{hint}</p>
      <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-5 px-5 pb-1">
        {voices.map(v => (
          <button key={v.id} onClick={() => { onChange(v.id); onPreview(v.id) }}
            className={`shrink-0 h-10 px-3.5 rounded-full text-sm whitespace-nowrap ${value === v.id ? 'bg-white text-black font-medium' : 'bg-neutral-800 text-neutral-300'}`}>
            {v.label}
          </button>
        ))}
      </div>
    </section>
  )
}
