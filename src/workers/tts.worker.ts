/**
 * TTS Web Worker: hosts the Kokoro ONNX model, synthesizes sentences on request.
 * Messages in:  { type:'load', dtype, device } | { type:'synth', reqId, sentenceId, text, voice, speed } | { type:'cancel' }
 * Messages out: { type:'progress', ... } | { type:'ready', voices } | { type:'audio', reqId, sentenceId, samples: Float32Array, sampleRate } | { type:'error', reqId?, message }
 */
import { KokoroTTS } from 'kokoro-js'
import { env } from '@huggingface/transformers'
import { phonemize } from 'phonemizer'
import ESpeakNG from 'espeak-ng'
import { chunkText } from '../services/chunkText'

export type WorkerIn =
  | { type: 'load'; dtype: 'q8' | 'fp16' | 'fp32' | 'q4'; device: 'wasm' | 'webgpu' }
  | { type: 'synth'; reqId: number; sentenceId: number; text: string; voice: string; speed: number }
  | { type: 'cancel' }
  | { type: 'bench' }
  | { type: 'warmVoices'; voices: string[] }

export type WorkerOut =
  | { type: 'voicesWarmed'; ok: string[]; failed: string[] }
  | { type: 'bench'; result: Record<string, number> }
  | { type: 'progress'; file: string; loaded: number; total: number; status: string }
  | { type: 'ready'; voices: string[] }
  | { type: 'audio'; reqId: number; sentenceId: number; samples: Float32Array; sampleRate: number; ms?: number }
  | { type: 'error'; reqId?: number; message: string }

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const SAMPLE_RATE = 24000
/** Voices kokoro-js doesn't validate (Spanish etc.) — we phonemize ourselves and call generate_from_ids. */
const EXTRA_VOICES: Record<string, string> = { ef_dora: 'es', em_alex: 'es', em_santa: 'es' }

let tts: KokoroTTS | null = null
let currentDevice: 'wasm' | 'webgpu' = 'wasm'
let generation = 0
let queue: Extract<WorkerIn, { type: 'synth' }>[] = []
let busy = false

env.useBrowserCache = true
env.allowLocalModels = false
// Self-hosted ORT WASM (copied to /public/ort) so the service worker precaches it → true offline.
env.backends.onnx.wasm!.wasmPaths = new URL(`${import.meta.env.BASE_URL}ort/`, self.location.origin).href
// Single-thread when SharedArrayBuffer is unavailable (iOS Safari w/o COOP/COEP); more stable and lower memory.
env.backends.onnx.wasm!.numThreads = typeof SharedArrayBuffer === 'undefined' ? 1 : Math.min(4, navigator.hardwareConcurrency || 1)

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  try {
    if (msg.type === 'load') await load(msg.dtype, msg.device)
    else if (msg.type === 'synth') { queue.push(msg); void pump() }
    else if (msg.type === 'cancel') { generation++; queue = [] }
    else if (msg.type === 'bench') await bench()
    else if (msg.type === 'warmVoices') await warmVoices(msg.voices)
  } catch (err) {
    post({ type: 'error', message: (err as Error).message })
  }
}

function post(m: WorkerOut, transfer?: Transferable[]) {
  ;(self as unknown as Worker).postMessage(m, transfer ?? [])
}

async function load(dtype: 'q8' | 'fp16' | 'fp32' | 'q4', device: 'wasm' | 'webgpu') {
  if (tts) { post({ type: 'ready', voices: allVoices() }); return }
  currentDevice = device
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype, device,
    progress_callback: (p: unknown) => {
      const info = p as { status: string; file?: string; loaded?: number; total?: number }
      post({ type: 'progress', file: info.file ?? '', loaded: info.loaded ?? 0, total: info.total ?? 0, status: info.status })
    },
  })
  // Warm up: first inference compiles WASM kernels (~1–3s); do it now so first real sentence is fast.
  try { await tts.generate('Ready.', { voice: 'af_heart', speed: 1 }) } catch { /* non-fatal */ }
  post({ type: 'ready', voices: allVoices() })
}

function allVoices() { return [...Object.keys(tts?.voices ?? {}), ...Object.keys(EXTRA_VOICES)] }

async function pump() {
  if (busy || !tts) return
  busy = true
  while (queue.length) {
    const job = queue.shift()!
    const gen = generation
    try {
      const text = job.text.trim()
      if (!text || !/[\p{L}\p{N}]/u.test(text)) {
        const samples = new Float32Array(Math.round(SAMPLE_RATE * 0.25))
        post({ type: 'audio', reqId: job.reqId, sentenceId: job.sentenceId, samples, sampleRate: SAMPLE_RATE }, [samples.buffer])
        continue
      }
      const t0 = performance.now()
      const raw = await synth(text, job.voice, job.speed)
      const ms = performance.now() - t0
      if (gen !== generation) continue
      // Copy into a fresh non-shared buffer so it can be transferred
      const samples = new Float32Array(raw)
      post({ type: 'audio', reqId: job.reqId, sentenceId: job.sentenceId, samples, sampleRate: SAMPLE_RATE, ms }, [samples.buffer])
    } catch (err) {
      post({ type: 'error', reqId: job.reqId, message: (err as Error).message })
    }
  }
  busy = false
}

const MAX_CHUNK = 320 // chars; Kokoro's context is 510 tokens (~400 chars). Longer input is silently truncated.

async function synth(text: string, voice: string, speed: number): Promise<Float32Array> {
  if (text.length <= MAX_CHUNK) return synthOne(text, voice, speed)
  const parts = chunkText(text, MAX_CHUNK)
  const bufs: Float32Array[] = []
  let total = 0
  for (const p of parts) { const b = await synthOne(p, voice, speed); bufs.push(b); total += b.length }
  const out = new Float32Array(total)
  let o = 0
  for (const b of bufs) { out.set(b, o); o += b.length }
  return out
}

async function synthOne(text: string, voice: string, speed: number): Promise<Float32Array> {
  const t = tts!
  const lang = EXTRA_VOICES[voice]
  if (!lang) {
    const audio = await t.generate(text, { voice: voice as never, speed })
    return audio.audio as Float32Array
  }
  // Non-English path: espeak-ng phonemes → Kokoro tokenizer → model
  const ph = await phonemizeFor(text, lang)
  const { input_ids } = t.tokenizer(ph, { truncation: true })
  const audio = await t.generate_from_ids(input_ids, { voice: voice as never, speed })
  return audio.audio as Float32Array
}

const PUNCT = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g
async function phonemizeFor(text: string, lang: string): Promise<string> {
  // `phonemizer` 1.2 ships an English-only espeak dictionary. Its API advertises
  // Spanish voices, but `phonemize(..., 'es')` throws at runtime. The full
  // espeak-ng WASM package includes es_dict and is bundled with the app, so this
  // branch stays local/offline after the PWA shell is cached.
  if (lang === 'es') return phonemizeSpanish(text)

  // Keep punctuation (Kokoro's tokenizer knows it, drives prosody); phonemize the words between.
  const norm = normalizeForKokoro(text)
  const parts = splitPunctuation(norm)
  const out = await Promise.all(parts.map(async p => p.punct ? p.text : (await phonemize(p.text, lang)).join(' ')))
  return kokoroIpa(out.join(''))
}

function normalizeForKokoro(text: string) {
  return text.replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
}

function splitPunctuation(norm: string) {
  const parts: { punct: boolean; text: string }[] = []
  let last = 0
  for (const m of norm.matchAll(PUNCT)) {
    if (m.index! > last) parts.push({ punct: false, text: norm.slice(last, m.index) })
    parts.push({ punct: true, text: m[0] })
    last = m.index! + m[0].length
  }
  if (last < norm.length) parts.push({ punct: false, text: norm.slice(last) })
  return parts
}

async function phonemizeSpanish(text: string): Promise<string> {
  const output = `kokoro-es-${Math.random().toString(36).slice(2)}`
  const espeak = await ESpeakNG({
    arguments: ['--phonout', output, '--sep=', '-q', '-b=1', '--ipa=3', '-v', 'es', normalizeForKokoro(text)],
  })
  // IPA punctuation is retained by espeak. Normalize only symbols unsupported
  // by the Kokoro v1 tokenizer, matching the upstream non-English pathway.
  return kokoroIpa(espeak.FS.readFile(output, { encoding: 'utf8' }).trim())
}

function kokoroIpa(ipa: string): string {
  // Kokoro (misaki) post-processing for espeak output
  return ipa.replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l').trim()
}

async function bench() {
  const t = tts!
  const res: Record<string, number> = {}
  const text = 'The quick brown fox jumps over the lazy dog near the river bank.'
  let t0 = performance.now()
  const ph = await phonemizeFor(text, 'en-us')
  res.phonemize_ms = performance.now() - t0
  t0 = performance.now()
  const { input_ids } = t.tokenizer(ph, { truncation: true })
  res.tokenize_ms = performance.now() - t0
  res.tokens = input_ids.dims.at(-1) as number
  for (let i = 0; i < 2; i++) {
    t0 = performance.now()
    const a = await t.generate_from_ids(input_ids, { voice: 'af_heart', speed: 1 })
    res[`infer${i}_ms`] = performance.now() - t0
    res.audio_s = a.audio.length / SAMPLE_RATE
  }
  res.threads = env.backends.onnx.wasm!.numThreads as number
  res.device = currentDevice === 'webgpu' ? 1 : 0
  res.sab = typeof SharedArrayBuffer !== 'undefined' ? 1 : 0
  post({ type: 'bench', result: res })
}

/** Fetch voice embeddings into the same Cache kokoro-js reads from, so they work offline later. */
async function warmVoices(voices: string[]) {
  const ok: string[] = [], failed: string[] = []
  let cache: Cache | null = null
  try { cache = await caches.open('kokoro-voices') } catch { /* no Cache API */ }
  for (const v of new Set(voices)) {
    const url = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${v}.bin`
    try {
      if (cache && await cache.match(url)) { ok.push(v); continue }
      const r = await fetch(url)
      if (!r.ok) throw new Error(String(r.status))
      if (cache) await cache.put(url, r.clone())
      ok.push(v)
    } catch { failed.push(v) }
  }
  post({ type: 'voicesWarmed', ok, failed })
}
