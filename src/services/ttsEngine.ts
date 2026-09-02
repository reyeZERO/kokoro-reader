/**
 * TTS engine: main-thread orchestrator.
 *  - Owns the worker (Kokoro ONNX), an LRU AudioBuffer cache keyed by sentence+voice+speed
 *  - Pre-buffers upcoming sentences (lookahead window) so playback never stalls
 *  - Schedules playback via Web Audio, exposes seek/skip/speed/sleep-timer
 *  - iOS: AudioContext unlock, silent <audio> keepalive, MediaSession lock-screen controls
 */
import type { Book, Sentence, VoiceConfig, VoiceId } from '../types'
import type { WorkerIn, WorkerOut } from '../workers/tts.worker'

export type EngineState = 'idle' | 'loading-model' | 'ready' | 'buffering' | 'playing' | 'paused' | 'error'

export interface EngineEvents {
  state: (s: EngineState) => void
  sentence: (sentenceId: number) => void
  modelProgress: (p: { file: string; loaded: number; total: number; status: string; overall: number }) => void
  error: (msg: string) => void
  bufferHealth: (readyAhead: number) => void
  ended: () => void
}

type Listener<K extends keyof EngineEvents> = EngineEvents[K]

const LOOKAHEAD = 4          // sentences to keep synthesized ahead of the cursor
const CACHE_MAX = 40         // AudioBuffers kept in memory (~1–3s each @24kHz mono ≈ 100–300KB each)
const GAP_SENTENCE = 0.12    // seconds of silence between sentences
const GAP_PARAGRAPH = 0.38
const GAP_CHAPTER = 1.0

export class TTSEngine {
  private worker: Worker | null = null
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private keepalive: HTMLAudioElement | null = null
  private state: EngineState = 'idle'
  private listeners: { [K in keyof EngineEvents]: Set<Listener<K>> } = {
    state: new Set(), sentence: new Set(), modelProgress: new Set(), error: new Set(), bufferHealth: new Set(), ended: new Set(),
  }

  private book: Book | null = null
  private voices: VoiceConfig | null = null
  private cursor = 0                          // index into book.sentences
  private cache = new Map<string, AudioBuffer>()
  private pending = new Map<string, { reqId: number; resolve: (b: AudioBuffer) => void; reject: (e: Error) => void }>()
  private reqCounter = 0
  private currentSource: AudioBufferSourceNode | null = null
  private playToken = 0                       // invalidates stale playback continuations
  private sleepTimer: ReturnType<typeof setTimeout> | null = null
  private sleepAtChapterEnd = false
  private fileProgress = new Map<string, { loaded: number; total: number }>()
  private modelReady: Promise<void> | null = null
  private resolveModelReady: (() => void) | null = null
  private rejectModelReady: ((e: Error) => void) | null = null
  availableVoices: string[] = []
  backend: { device: 'wasm' | 'webgpu'; dtype: string } | null = null

  // ------------------------------------------------------------ events
  on<K extends keyof EngineEvents>(ev: K, fn: Listener<K>): () => void {
    this.listeners[ev].add(fn)
    return () => this.listeners[ev].delete(fn)
  }
  private emit<K extends keyof EngineEvents>(ev: K, ...args: Parameters<EngineEvents[K]>) {
    for (const fn of this.listeners[ev]) (fn as (...a: unknown[]) => void)(...args)
  }
  private setState(s: EngineState) { if (s !== this.state) { this.state = s; this.emit('state', s); this.syncMediaSession() } }
  getState() { return this.state }
  bench() { this.post({ type: 'bench' }) }
  debug() { return { state: this.state, cursor: this.cursor, ctx: this.ctx?.state, ctxTime: this.ctx?.currentTime, cache: this.cache.size, pending: this.pending.size, src: !!this.currentSource } }

  // ------------------------------------------------------------ model
  /** Start (or reuse) the worker and load model weights. Safe to call repeatedly. */
  loadModel(opts: { dtype?: 'q8' | 'fp16' | 'fp32' | 'q4'; device?: 'wasm' | 'webgpu' } = {}): Promise<void> {
    if (this.modelReady) return this.modelReady
    this.setState('loading-model')
    const prevRes = this.resolveModelReady, prevRej = this.rejectModelReady
    this.modelReady = new Promise<void>((res, rej) => {
      // Chain so callers awaiting the first (failed-GPU) promise still resolve on the fallback
      this.resolveModelReady = () => { res(); prevRes?.() }
      this.rejectModelReady = (e) => { rej(e); prevRej?.(e) }
    })
    this.worker = new Worker(new URL('../workers/tts.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => this.onWorkerMessage(e.data)
    this.worker.onerror = (e) => { this.emit('error', e.message); this.setState('error'); this.rejectModelReady?.(new Error(e.message)) }
    // Backend preference: explicit arg > ?device=/dtype= URL param > localStorage > auto.
    // WebGPU (Safari 26+/iOS 26+, Chrome) runs Kokoro fp32 several x faster than WASM q8; WASM is the fallback.
    const pref = getBackendPref()
    const devPref = opts.device ?? pref.device
    const wantGpu = devPref ? devPref === 'webgpu' : hasWebGPU()
    const device = wantGpu ? 'webgpu' : 'wasm'
    const dtype = opts.dtype ?? pref.dtype ?? (device === 'webgpu' ? 'fp32' : 'q8')
    if (opts.device || opts.dtype) setBackendPref({ device: opts.device, dtype: opts.dtype })
    this.backend = { device, dtype }
    this.post({ type: 'load', dtype, device })
    return this.modelReady
  }

  private onWorkerMessage(m: WorkerOut) {
    switch (m.type) {
      case 'progress': {
        if (m.file) this.fileProgress.set(m.file, { loaded: m.loaded, total: m.total })
        let loaded = 0, total = 0
        for (const v of this.fileProgress.values()) { loaded += v.loaded; total += v.total }
        this.emit('modelProgress', { ...m, overall: total ? loaded / total : 0 })
        break
      }
      case 'bench':
        console.log('[bench]', JSON.stringify(m.result))
        ;(globalThis as unknown as { __bench: unknown }).__bench = m.result
        break
      case 'voicesWarmed':
        if (m.failed.length) console.warn('[tts] voices not cached (offline?):', m.failed)
        break
      case 'ready':
        this.availableVoices = m.voices
        if (this.voices) this.warmVoices(this.voices)
        this.setState(this.book ? 'paused' : 'ready')
        this.resolveModelReady?.()
        break
      case 'audio': {
        const entry = [...this.pending.entries()].find(([, v]) => v.reqId === m.reqId)
        if (!entry) break
        const [key, p] = entry
        this.pending.delete(key)
        const buf = this.toAudioBuffer(m.samples, m.sampleRate)
        if (m.ms && import.meta.env.DEV) console.debug(`[tts] s${m.sentenceId}: ${buf.duration.toFixed(1)}s in ${m.ms.toFixed(0)}ms (${(buf.duration / (m.ms / 1000)).toFixed(2)}x rt)`)
        this.putCache(key, buf)
        p.resolve(buf)
        this.reportHealth()
        break
      }
      case 'error': {
        if (m.reqId != null) {
          const entry = [...this.pending.entries()].find(([, v]) => v.reqId === m.reqId)
          if (entry) { this.pending.delete(entry[0]); entry[1].reject(new Error(m.message)) }
        } else if (this.backend?.device === 'webgpu' && !this.availableVoices.length) {
          // WebGPU init failed (unsupported adapter, OOM) → restart the worker on WASM q8
          console.warn('[tts] WebGPU failed, falling back to WASM:', m.message)
          this.worker?.terminate(); this.worker = null; this.modelReady = null; this.fileProgress.clear()
          void this.loadModel({ device: 'wasm', dtype: 'q8' })
        } else {
          this.emit('error', m.message); this.setState('error'); this.rejectModelReady?.(new Error(m.message))
        }
        break
      }
    }
  }

  private post(m: WorkerIn) { this.worker?.postMessage(m) }

  // ------------------------------------------------------------ audio context (iOS unlock)
  /** Must be called from a user gesture at least once. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new AC({ sampleRate: 24000, latencyHint: 'playback' })
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
      this.setupKeepalive()
      document.addEventListener('visibilitychange', () => { if (this.state === 'playing') void this.ctx?.resume() })
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    // iOS requires a real buffer to play once inside the gesture
    const b = this.ctx.createBuffer(1, 1, 24000)
    const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start()
  }

  /**
   * iOS Safari suspends WebAudio when the screen locks unless an <audio> element is playing.
   * A looping silent WAV keeps the audio session alive and gives MediaSession something to attach to.
   */
  private setupKeepalive() {
    const a = document.createElement('audio')
    a.loop = true
    a.setAttribute('playsinline', '')
    a.preload = 'auto'
    a.src = silentWavDataUrl(2)
    a.volume = 0.01 // not 0: iOS treats muted media as non-audible and may still suspend
    document.body.appendChild(a)
    this.keepalive = a
  }

  private toAudioBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
    const ctx = this.ctx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    if (!this.ctx) this.ctx = ctx
    const buf = ctx.createBuffer(1, samples.length, sampleRate)
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    return buf
  }

  // ------------------------------------------------------------ book / voices
  setBook(book: Book, voices: VoiceConfig, startSentence = 0) {
    this.stopSource()
    this.book = book
    this.voices = voices
    this.cursor = clamp(startSentence, 0, Math.max(0, book.sentences.length - 1))
    this.cache.clear()
    this.cancelPending()
    if (this.modelReady) this.setState(this.state === 'loading-model' ? 'loading-model' : 'paused')
    this.emit('sentence', this.cursor)
    this.updateMediaMetadata()
  }

  private warmVoices(v: VoiceConfig) {
    if (this.availableVoices.length) this.post({ type: 'warmVoices', voices: [v.narrator, v.male, v.female, v.unknown] })
  }

  setVoices(voices: VoiceConfig) {
    this.warmVoices(voices)
    const speedChanged = voices.speed !== this.voices?.speed
    const wasPlaying = this.state === 'playing'
    this.voices = voices
    // Cache keys include voice+speed so stale entries just go unused; drop them to free memory
    this.cache.clear(); this.cancelPending()
    if (wasPlaying || speedChanged) { this.stopSource(); if (wasPlaying) void this.play() }
    else this.prefetch()
  }
  getVoices() { return this.voices }

  // ------------------------------------------------------------ playback
  async play(fromSentence?: number) {
    if (!this.book || !this.voices) return
    await this.unlock()
    await this.loadModel()
    if (fromSentence != null) this.cursor = clamp(fromSentence, 0, this.book.sentences.length - 1)
    this.stopSource()
    const token = ++this.playToken
    void this.keepalive?.play().catch(() => {})
    this.setState('buffering')
    this.emit('sentence', this.cursor)
    this.prefetch()
    await this.playLoop(token)
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'buffering') return
    this.playToken++
    this.stopSource()
    this.keepalive?.pause()
    this.setState('paused')
  }

  toggle() { this.state === 'playing' || this.state === 'buffering' ? this.pause() : void this.play() }

  seek(sentenceId: number) {
    if (!this.book) return
    const wasPlaying = this.state === 'playing' || this.state === 'buffering'
    this.cursor = clamp(sentenceId, 0, this.book.sentences.length - 1)
    this.emit('sentence', this.cursor)
    if (wasPlaying) void this.play(this.cursor)
    else this.prefetch()
  }

  /** Skip approximately ±seconds by walking sentence durations (cached real durations, else estimates). */
  skip(seconds: number) {
    if (!this.book) return
    let remaining = Math.abs(seconds)
    let i = this.cursor
    const dir = Math.sign(seconds)
    while (remaining > 0) {
      const next = i + dir
      if (next < 0 || next >= this.book.sentences.length) break
      i = next
      remaining -= this.durationOf(this.book.sentences[i])
    }
    this.seek(i)
  }

  nextChapter() {
    if (!this.book) return
    const ch = this.book.sentences[this.cursor].chapterIdx
    const next = this.book.chapters[ch + 1]
    if (next) this.seek(next.firstSentenceId)
  }
  prevChapter() {
    if (!this.book) return
    const ch = this.book.sentences[this.cursor].chapterIdx
    const cur = this.book.chapters[ch]
    // If more than a few sentences in, go to chapter start; else previous chapter
    if (this.cursor - cur.firstSentenceId > 3 || ch === 0) this.seek(cur.firstSentenceId)
    else this.seek(this.book.chapters[ch - 1].firstSentenceId)
  }

  getCursor() { return this.cursor }

  // ------------------------------------------------------------ sleep timer
  setSleepTimer(minutes: number | 'chapter' | null) {
    if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null }
    this.sleepAtChapterEnd = false
    if (minutes === 'chapter') this.sleepAtChapterEnd = true
    else if (typeof minutes === 'number') this.sleepTimer = setTimeout(() => { this.pause(); this.sleepTimer = null }, minutes * 60_000)
  }

  // ------------------------------------------------------------ internals
  private async playLoop(token: number) {
    const book = this.book!
    while (token === this.playToken && this.cursor < book.sentences.length) {
      const s = book.sentences[this.cursor]
      let buf: AudioBuffer
      try {
        this.setState(this.cache.has(this.keyFor(s)) ? 'playing' : 'buffering')
        this.emit('sentence', this.cursor)
        buf = await this.ensure(s)
      } catch (e) {
        this.emit('error', `Synthesis failed: ${(e as Error).message}`)
        this.cursor++
        continue
      }
      if (token !== this.playToken) return
      this.setState('playing')
      this.emit('sentence', this.cursor)
      this.prefetch()
      this.updateMediaMetadata()

      await this.playBuffer(buf, token)
      if (token !== this.playToken) return

      const next = book.sentences[this.cursor + 1]
      const gap = !next ? 0 : next.chapterIdx !== s.chapterIdx ? GAP_CHAPTER : next.paragraphIdx !== s.paragraphIdx ? GAP_PARAGRAPH : GAP_SENTENCE
      if (next && next.chapterIdx !== s.chapterIdx && this.sleepAtChapterEnd) {
        this.cursor++
        this.sleepAtChapterEnd = false
        this.pause()
        return
      }
      if (gap) await sleep(gap * 1000)
      if (token !== this.playToken) return
      this.cursor++
    }
    if (token === this.playToken && this.cursor >= book.sentences.length) {
      this.cursor = book.sentences.length - 1
      this.keepalive?.pause()
      this.setState('paused')
      this.emit('ended')
    }
  }

  private playBuffer(buf: AudioBuffer, token: number): Promise<void> {
    return new Promise(resolve => {
      const ctx = this.ctx!
      if (ctx.state === 'suspended') void ctx.resume()
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.gain!)
      src.onended = () => { if (this.currentSource === src) this.currentSource = null; resolve() }
      this.currentSource = src
      src.start()
      // Safety: if token invalidated mid-play, resolve promptly
      const check = setInterval(() => { if (token !== this.playToken) { clearInterval(check); resolve() } }, 200)
      src.addEventListener('ended', () => clearInterval(check))
    })
  }

  private stopSource() {
    if (this.currentSource) { try { this.currentSource.onended = null; this.currentSource.stop() } catch { /* already stopped */ } this.currentSource = null }
  }

  private keyFor(s: Sentence) { return `${s.id}|${this.voiceFor(s)}|${this.speedFor(s)}` }
  private voiceFor(s: Sentence): VoiceId {
    const v = this.voices!
    return s.role === 'male' ? v.male : s.role === 'female' ? v.female : s.role === 'unknown' ? v.unknown : v.narrator
  }
  /** Solo mode / first-person speech: spoken lines get a slightly slower delivery (audiobook-director style). */
  private speedFor(s: Sentence): number {
    const base = this.voices?.speed ?? 1
    const solo = this.book?.dialogueMode === 'solo' || s.role === 'narrator'
    return s.dialogue && solo ? Math.round(base * 0.94 * 100) / 100 : base
  }

  private ensure(s: Sentence): Promise<AudioBuffer> {
    const key = this.keyFor(s)
    const hit = this.cache.get(key)
    if (hit) return Promise.resolve(hit)
    const pend = this.pending.get(key)
    if (pend) return new Promise((resolve, reject) => {
      const orig = pend.resolve, origRej = pend.reject
      pend.resolve = (b) => { orig(b); resolve(b) }
      pend.reject = (e) => { origRej(e); reject(e) }
    })
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqCounter
      this.pending.set(key, { reqId, resolve, reject })
      this.post({ type: 'synth', reqId, sentenceId: s.id, text: s.text, voice: this.voiceFor(s), speed: this.speedFor(s) })
    })
  }

  private prefetch() {
    if (!this.book || !this.voices || !this.modelReady) return
    for (let i = this.cursor; i < Math.min(this.book.sentences.length, this.cursor + 1 + LOOKAHEAD); i++) {
      const s = this.book.sentences[i]
      const key = this.keyFor(s)
      if (!this.cache.has(key) && !this.pending.has(key)) this.ensure(s).catch(() => {})
    }
    this.reportHealth()
  }

  private reportHealth() {
    if (!this.book) return
    let n = 0
    for (let i = this.cursor; i < this.book.sentences.length && this.cache.has(this.keyFor(this.book.sentences[i])); i++) n++
    this.emit('bufferHealth', n)
  }

  private putCache(key: string, buf: AudioBuffer) {
    this.cache.set(key, buf)
    if (this.cache.size > CACHE_MAX) {
      // Evict entries furthest behind the cursor first
      const keys = [...this.cache.keys()]
      keys.sort((a, b) => Math.abs(parseInt(a) - this.cursor) - Math.abs(parseInt(b) - this.cursor))
      while (this.cache.size > CACHE_MAX) this.cache.delete(keys.pop()!)
    }
  }

  private cancelPending() {
    this.post({ type: 'cancel' })
    for (const p of this.pending.values()) p.reject(new Error('cancelled'))
    this.pending.clear()
  }

  /** Actual duration when cached; else ~2.6 words/sec estimate scaled by speed. */
  durationOf(s: Sentence): number {
    const b = this.voices ? this.cache.get(this.keyFor(s)) : undefined
    if (b) return b.duration
    const words = s.text.split(/\s+/).length
    return (words / 2.6 + 0.15) / (this.voices?.speed ?? 1)
  }

  /** Estimated total seconds remaining in the book from the cursor. */
  remainingSeconds(from = this.cursor): number {
    if (!this.book) return 0
    let t = 0
    for (let i = from; i < this.book.sentences.length; i++) t += this.durationOf(this.book.sentences[i])
    return t
  }

  // ------------------------------------------------------------ MediaSession
  private updateMediaMetadata() {
    if (!('mediaSession' in navigator) || !this.book) return
    const s = this.book.sentences[this.cursor]
    const ch = this.book.chapters[s?.chapterIdx ?? 0]
    const artwork = this.book.coverBlob ? [{ src: URL.createObjectURL(this.book.coverBlob), sizes: '512x512', type: this.book.coverBlob.type }] : []
    navigator.mediaSession.metadata = new MediaMetadata({ title: ch?.title ?? this.book.title, artist: this.book.author, album: this.book.title, artwork })
    if (!this.mediaHandlersBound) this.bindMediaHandlers()
  }
  private mediaHandlersBound = false
  private bindMediaHandlers() {
    this.mediaHandlersBound = true
    const ms = navigator.mediaSession
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler) => { try { ms.setActionHandler(a, h) } catch { /* unsupported */ } }
    set('play', () => void this.play())
    set('pause', () => this.pause())
    set('stop', () => this.pause())
    set('seekbackward', (d) => this.skip(-(d.seekOffset ?? 15)))
    set('seekforward', (d) => this.skip(d.seekOffset ?? 15))
    set('previoustrack', () => this.prevChapter())
    set('nexttrack', () => this.nextChapter())
  }
  private syncMediaSession() {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = this.state === 'playing' || this.state === 'buffering' ? 'playing' : 'paused'
  }

  destroy() {
    this.playToken++
    this.stopSource()
    this.cancelPending()
    this.worker?.terminate(); this.worker = null; this.modelReady = null
    this.keepalive?.remove()
    void this.ctx?.close(); this.ctx = null
  }
}

// ------------------------------------------------------------ helpers
type Dev = 'wasm' | 'webgpu'; type Dt = 'q8' | 'fp16' | 'fp32' | 'q4'
export function getBackendPref(): { device?: Dev; dtype?: Dt } {
  try {
    const q = new URLSearchParams(location.search)
    const ls = JSON.parse(localStorage.getItem('kokoro.backend') ?? '{}') as { device?: Dev; dtype?: Dt }
    return { device: (q.get('device') as Dev) ?? ls.device, dtype: (q.get('dtype') as Dt) ?? ls.dtype }
  } catch { return {} }
}
export function setBackendPref(p: { device?: Dev; dtype?: Dt }) {
  try { localStorage.setItem('kokoro.backend', JSON.stringify(p)) } catch { /* private mode */ }
}
/** iOS Safari exposes WebGPU on Safari 26+ but its adapter/limits are immature and Kokoro fp32
 *  blows the ~1.2 GB iOS jetsam ceiling during model init — the tab gets killed mid-load and the
 *  model never finishes. Force WASM (CPU, q8) on iOS so the 92 MB int8 model loads reliably. */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent ?? ''
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
export function hasWebGPU(): boolean { return !isIOS() && typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as unknown as { gpu?: unknown }).gpu }
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Tiny silent PCM WAV as data URL (mono 8kHz 8-bit). */
function silentWavDataUrl(seconds: number): string {
  const sr = 8000, n = sr * seconds
  const buf = new ArrayBuffer(44 + n)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true)
  str(36, 'data'); v.setUint32(40, n, true)
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128)
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return 'data:audio/wav;base64,' + btoa(bin)
}

/** Singleton — one model, one AudioContext per page. */
export const engine = new TTSEngine()
;(globalThis as unknown as { __engine: TTSEngine }).__engine = engine
