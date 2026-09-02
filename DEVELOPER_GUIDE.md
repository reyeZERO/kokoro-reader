# Kokoro Reader — Developer Guide

A complete architecture and modification manual. Assumes TypeScript basics but no prior knowledge of
this codebase, Web Audio, ONNX, or PWAs.

---

## 1. System Architecture

Kokoro Reader is a 100% client-side PWA. There is no server, no backend API, no account. An EPUB is
unzipped in the browser, split into spoken segments, synthesized by a Kokoro-82M ONNX model running
in a Web Worker, and played through Web Audio while the reader highlights the sentence being spoken.

```
 [EPUB file picker / drop]
        │
        ▼
 ┌──────────────────────┐      ┌─────────────────────────┐
 │ epubParser.ts        │      │ (auto-detect)           │
 │ jszip + DOMParser    │─────▶│ looksUnquoted()         │
 │ spine/TOC/cover/text │      │ <10 quotes & ≥8 tags    │
 └──────────┬───────────┘      │ → mode = "tags"         │
            │ paragraphs       └─────────────────────────┘
            ▼
 ┌──────────────────────────────┐
 │ buildStructure()             │  one of three strategies per paragraph:
 │  ├─ DialogueContext.segment  │  'punctuation' — quote/em-dash mask
 │  ├─ SpeakerTagContext.segment│  'tags'        — verb anchors (dije/dijo X)
 │  └─ soloSegments             │  'solo'        — detect but keep narrator voice
 └──────────┬───────────────────┘
            │ Book { chapters, paragraphs, sentences[] (role, dialogue, start/end) }
            ▼
 ┌────────────────────────┐         IndexedDB (idb)
 │ db.ts                  │──────── stores: books (meta) · bodies (chapters/paras/sents)
 │                        │                voices (per-book cfg) · progress · settings
 └──────────┬─────────────┘
            │ engine.setBook(book, voices, cursor)
            ▼
 ┌──────────────────────────┐    postMessage    ┌──────────────────────────────┐
 │ TTSEngine (main thread)  │◀─────────────────▶│ tts.worker.ts (Web Worker)   │
 │  · LRU AudioBuffer cache │  {synth,text,…}   │  · KokoroTTS.from_pretrained │
 │  · lookahead prefetch ×4 │  {audio,samples}  │  · phonemizer (espeak WASM)  │
 │  · Web Audio scheduling  │                   │  · chunkText (>320 chars)    │
 │  · MediaSession          │                   │  · ORT WASM self-hosted /ort │
 └──────────┬───────────────┘                   └──────────────┬───────────────┘
            │ AudioBufferSourceNode                           │ model + voices
            ▼                                                 ▼
   speakers / headphones                        CacheStorage (transformers cache
            │                                    ~92 MB q8) + 'kokoro-voices' cache
            ▼
   React UI: ReaderView (karaoke highlight via 'sentence' events, tap-to-read),
   AudioPlayer (mini + fullscreen), LibraryView, VoiceConfigModal, ModelLoader
```

Threading model: everything CPU-heavy (ONNX inference, phonemization) is in the worker; the main
thread only schedules already-synthesized `AudioBuffer`s, so the UI never blocks on inference.

---

## 2. Directory & File Breakdown

```
kokoro-reader/
├── index.html                     PWA shell: viewport-fit=cover, iOS meta tags, theme-color
├── vite.config.ts                 base (BASE_PATH env, default '/'), VitePWA precache config
├── package.json                   scripts: dev / build / serve / test / e2e
├── .github/workflows/pages.yml    CI: test → build with BASE_PATH=/<repo>/ → GitHub Pages
├── public/
│   ├── icons/                     SVG + generated PNG PWA icons
│   └── ort/ort-wasm-simd-threaded.jsep.{mjs,wasm}   self-hosted ONNX Runtime (offline!)
├── src/
│   ├── main.tsx                   React root + registerSW (vite-plugin-pwa)
│   ├── App.tsx                    view switch (library/reader), model warmup, mode reparse
│   ├── index.css                  Tailwind v4 @theme: fonts (literata/bookerly), palette
│   ├── types.ts                   every shared interface + VOICE_CATALOG
│   ├── services/
│   │   ├── epubParser.ts          EPUB/TXT → Book; buildStructure; reparseBook
│   │   ├── dialogueParser.ts      sentence splitter + quote/em-dash dialogue mask
│   │   ├── speakerTags.ts         verb-anchor parser for unquoted prose + looksUnquoted
│   │   ├── chunkText.ts           clause-boundary chunking for >320-char segments
│   │   ├── ttsEngine.ts           playback orchestrator (main thread)
│   │   └── db.ts                  IndexedDB (idb) persistence
│   ├── workers/
│   │   └── tts.worker.ts          Kokoro-82M ONNX host, synth, bench, voice warming
│   ├── hooks/useEngine.ts         React binding: subscribe to engine events
│   ├── utils/format.ts            formatDuration / formatClock
│   └── components/
│       ├── LibraryView.tsx        shelf, import, delete, storage meter, model entry
│       ├── ReaderView.tsx         chapter-virtualized reading, karaoke, TOC, settings
│       ├── AudioPlayer.tsx        mini-player + fullscreen modal, sleep timer, speed
│       ├── VoiceConfigModal.tsx   voice pickers, speed, dialogue-mode toggle
│       └── ModelLoader.tsx        device/dtype picker, download progress, persistence
└── tests/
    ├── dialogue.test.ts           23 unit cases (node --experimental-strip-types)
    ├── tags.test.ts               speech-tag unit cases + Heller fixture regression
    ├── fixtures/heller-es-paras.json   2354 real ES paragraphs (Peter Heller)
    ├── e2e.py                     raw-CDP headless-Chromium end-to-end (import→play→karaoke)
    ├── bench.py                   WASM/WebGPU inference benchmark
    ├── websocket_min.py           stdlib RFC6455 client used by e2e/bench
    ├── serve.py                   static server with COOP/COEP (threaded WASM)
    └── serve-https.py             LAN HTTPS + self-signed cert for iPhone testing
```

### File-by-file exports

**src/types.ts** (~120 lines) — the contract for the whole app.

| Export | Kind | Meaning |
|---|---|---|
| `Lang` | `'en' \| 'es'` | Only two langs have full phonemizer + voice support |
| `VoiceId` | union | `'af_bella' \| 'am_adam' \| … \| 'ef_dora' \| 'em_alex'` — Kokoro voice file ids |
| `SpeakerRole` | union | `'narrator' \| 'male' \| 'female' \| 'unknown'` |
| `DialogueMode` | union | `'punctuation' \| 'tags' \| 'solo'` |
| `Sentence` | interface | `{ id, text, paragraphIdx, chapterIdx, role, dialogue?, start, end }` — start/end are char offsets inside the paragraph (for highlighting); `dialogue` is true for spoken lines even when role stays narrator (first-person "dije") |
| `Paragraph` | interface | `{ id, chapterIdx, text, heading: 0\|1\|2\|3, sentenceIds[] }` |
| `Chapter` | interface | `{ idx, title, href, paragraphIds[], firstSentenceId, wordCount }` |
| `Book` / `BookMeta` | interface | full structure vs. header row; `BookMeta` adds `dialogueMode?` |
| `VoiceConfig` | interface | `{ narrator, male, female, unknown: VoiceId, speed: number }` — per book |
| `ReaderSettings` | interface | `{ theme: 'black'\|'sepia'\|'light', font, fontSize, lineHeight }` |
| `DEFAULT_VOICES_EN/ES`, `VOICE_CATALOG` | consts | defaults + `[{ id, label, lang, gender }]` used by the picker |

**src/services/epubParser.ts** (315 lines)

| Export | Signature | Role |
|---|---|---|
| `parseFile(file: File) → Promise<Book>` | entry | dispatches `.epub` → `parseEpub`, else TXT (chapter split on ALL-CAPS/"Chapter N" headings) |
| `parseEpub(file) → Promise<Book>` | entry | jszip unzip → `container.xml` → OPF → spine order, TOC (EPUB3 nav or NCX), cover image, `dc:language`; DOMParser walks each spine doc's `<body>` into paragraphs with heading levels |
| `reparseBook(book, mode) → Book` | UI hook | rebuilds chapters/paragraphs/sentences from existing paragraph text with another DialogueMode; keeps id/meta; used by the mode toggle |
| `detectLang(sample) → Lang` | util | stopword heuristic (el/la/de/que vs the/and/of) |
| (internal) `BookBuilder` | class | records `{chapter\|para}` ops; `finish()` auto-detects mode via `looksUnquoted` then calls `buildStructure` |
| (internal) `buildStructure(ops, lang, mode)` | fn | the segmentation core: per paragraph → DialogueContext / SpeakerTagContext / soloSegments; long paragraphs pre-split by `chunkBySentences` (MAX_PARAGRAPH_CHARS) |

**src/services/dialogueParser.ts** (218 lines) — pure, no DOM.

| Export | Signature | Role |
|---|---|---|
| `splitSentences(text) → {start,end}[]` | fn | sentence boundaries with abbreviations (Sr., etc.), initials, decimals, ellipsis rules |
| `markDialogue(p) → boolean[]` | fn | per-char "inside dialogue" mask for `"…" “…” «…»` and em-dash style `—Hola —dijo él— adiós` |
| `DialogueContext` | class | `segment(paragraph, lang) → Segment[]`; tracks last/prev gendered speaker so untagged dialogue alternates; gender from pronouns near speech verbs (`nearestGender`) |
| `Segment` | interface | `{ start, end, role, dialogue }` |

Key regexes (top of file): `MALE_EN/FEMALE_EN/MALE_ES/FEMALE_ES` pronoun+noun sets,
`SPEECH_VERBS` (said/dijo/preguntó/murmuró…), `OPEN_Q = '"“«'`.

**src/services/speakerTags.ts** (109 lines) — the "minimalist punctuation" parser.

| Export | Signature | Role |
|---|---|---|
| `SpeakerTagContext` | class | `segment(paragraph, lang) → Segment[] \| null` (null = no speech tag here); `setName(name, role)` seeds character gender; `reset()` per chapter |
| `looksUnquoted(paragraphs) → boolean` | fn | import-time detector: <10 quote marks and ≥8 tag sentences → tag mode |

Core regex `TAG`: `^(.+?[,?!…])\s+(VERB)(?!\s+que\b)(.*)$` — a sentence whose first clause ends in
comma/?/! and is followed by a verb of utterance is speech + attribution. `FIRST_ES/THIRD_ES`
(`dije|dijo|murmuró|solté|me dijo…`), English equivalents. Unknown named speakers alternate against
the last third-person speaker and are memoized in `names` so "Bangley" keeps the same voice all book.

**src/services/chunkText.ts** (20 lines) — `chunkText(text, max)` splits at `; : — ,` closest to the
limit, falling back to spaces. Kokoro's 510-token context silently truncates long inputs; this
prevents that.

**src/services/ttsEngine.ts** (507 lines) — main-thread orchestrator. Class `TTSEngine`, singleton
`engine` (exported, also on `globalThis.__engine` for tests).

| Method | Role |
|---|---|
| `loadModel({dtype?, device?})` | spawns worker, sends `load`; resolves on `ready`. Default `q8`/auto (WebGPU if available → fp32, else WASM) |
| `setBook(book, voices, startSentence)` | resets cursor/cache, emits 'sentence' |
| `setVoices(v)` | warms voice embeddings (offline prefetch), clears cache on voice/speed change, restarts playback if playing |
| `play(from?)` / `pause()` / `toggle()` / `seek(sentenceId)` / `skip(seconds)` / `nextChapter()` / `prevChapter()` | transport |
| `setSleepTimer(min \| 'chapter' \| null)` | sleep timer |
| `playLoop(token)` (294) | the core: `ensure(cursor)` → `playBuffer` → on `ended` advance cursor; token invalidates stale continuations after seek/pause |
| `ensure(s)` (369) | LRU cache get → pending dedupe → post `{synth}` to worker |
| `prefetch()` (386) | synthesizes LOOKAHEAD=4 sentences ahead of the cursor |
| `voiceFor(s)` / `speedFor(s)` (358–367) | role→VoiceId map; solo/first-person dialogue runs at 0.94× (audiobook-director modulation) |
| `updateMediaMetadata/bindMediaHandlers/syncMediaSession` | lock-screen metadata + play/pause/±15s/chapter handlers |
| `setupKeepalive()` (171) | hidden looping silent WAV `<audio>` element — keeps the iOS audio session alive after screen lock |
| `unlock()` | creates/resumes AudioContext inside a user gesture |
| `durationOf/remainingSeconds` | real duration when cached, else 2.6 words/sec estimate |
| `bench()`, `debug()` | test hooks |
| `reportHealth/putCache/cancelPending` | cache/queue hygiene (LRU cap, low-memory pressure) |

**src/workers/tts.worker.ts** (189 lines)

| Piece | Role |
|---|---|
| `WorkerIn` / `WorkerOut` | message protocol: `load{s dtype,device}` / `synth{reqId,text,voice,speed}` / `cancel` / `bench` / `warmVoices{voices}` ⇢ `ready{voices}` / `audio{reqId,samples,sampleRate,ms}` / `progress{file,loaded,total}` / `error` / `bench` / `voicesWarmed` |
| top config | `env.useBrowserCache = true` (weights → CacheStorage), `env.allowLocalModels = false`, ORT `wasmPaths` → self-hosted `${BASE_URL}ort/` |
| `synth(text, voice, speed)` | chunks >320 chars via chunkText; ES voices use the full `espeak-ng` WASM bundle (the `phonemizer` dependency is English-only) → IPA → tokenizer → `generate_from_ids`; EN calls `KokoroTTS.generate`; returns Float32Array |
| `warmVoices(voices)` | fetches `voices/<id>.bin` into the same cache kokoro-js reads → voice switching works offline |
| `bench()` | synthesizes fixed sentences, returns timing |

**src/services/db.ts** (111 lines) — idb schema, DB name `kokoro-reader`, version 1:
`books` (BookMeta, index addedAt), `bodies` ({id, chapters, paragraphs, sentences}), `voices`
(keyPath bookId), `progress` (bookId), `settings` (kv). Functions listed in §3.5. `estimateUsage()`
wraps `navigator.storage.estimate()`, `requestPersistence()` → `navigator.storage.persist()`.

**Components** — all props-typed, state local:
`LibraryView({onOpen, onOpenModel, modelState})`, `ReaderView({book, voices, settings, onVoices, onMode, onSettings, onBack})`,
`AudioPlayer({book, sentenceId, state, buffered, speed, onSpeed, onOpenVoices})`,
`VoiceConfigModal({config, lang, mode, onMode, onChange, onClose, onPreview})`,
`ModelLoader({onClose, progress, state, error})`. `useEngine()` subscribes to engine events and
returns `{state, sentenceId, buffered, progress, error}`.

---

## 3. Core Subsystems, Deep Dive

### 3.1 EPUB parser

1. **Unzip** with jszip; `META-INF/container.xml` gives the OPF path.
2. **Spine order** from `<spine>` itemrefs → manifest hrefs (resolved relative to OPF dir).
3. **TOC**: EPUB3 `nav[epub:type="toc"]` preferred, NCX fallback; titles matched to spine files.
4. **Text extraction**: `DOMParser` per spine doc; a `walk()` over `<body>` collects block-level
   text (`p`, `h1–h3` → heading levels, `li`, `blockquote`), skipping `script/style/svg`.
5. **Language**: `dc:language` first, `detectLang` fallback on the sample.
6. **Cover**: manifest item with `properties="cover-image"` or meta name=cover → Blob stored on Book.
7. **Segmentation**: deferred to `finish()` so mode auto-detection sees the whole text
   (`looksUnquoted` on first 600 body paragraphs).
8. TXT: blank-line paragraphs; a line that is ALL-CAPS or `^Chapter \d+` starts a new chapter.

Paragraphs > MAX_PARAGRAPH_CHARS are pre-split at sentence boundaries so neither the dialogue
parser nor the TTS sees pathological inputs.

### 3.2 Dialogue & voice engine

**Punctuation mode** (`dialogueParser.ts`): `markDialogue` produces a char-level boolean mask.
Quote pairs `"…"/"…"/«…» toggle state; Spanish em-dash lines are handled by tracking dash runs
(opening dash → dialogue on, closing dash → narrator). Sentences are then split at mask flips, so
`"Come here," she said.` becomes `[Come here,]=dialogue + [she said.]=narrator`. Gender is inferred
from pronouns/speech verbs in the *narrative* part of the paragraph; untagged consecutive dialogue
alternates between the two most recent speakers.

**Tags mode** (`speakerTags.ts`): for books like Heller/McCarthy with no quote marks at all. A
sentence is speech iff it matches `TAG` — first clause ends with `,? ! …` and is immediately
followed by a verb of utterance, and the verb is NOT followed by `que` (that would be a report:
"me dijo que…"). First-person verbs (`dije`, `murmuré`) keep the narrator voice but set
`dialogue: true` (so solo mode can modulate them). Third-person tags look up: named speaker →
memoized voice (unknown names alternate male/female and stick), gendered noun/pronoun (`el viejo`,
`ella`, `she`) → that role, else last third-person speaker. An untagged `¿…?` right after a tagged
line continues the same speaker.

**Solo mode**: runs both detectors but rewrites every role to `narrator`, keeping `dialogue` flags —
the engine then plays spoken lines at 0.94× speed instead of switching voices (intimate-memoir
audiobook style).

Mode is stored on `BookMeta.dialogueMode` and toggled live from the Voices sheet; `reparseBook`
rebuilds segments from paragraph text and `App.onMode` maps the cursor to the same paragraph so you
don't lose your place.

### 3.3 Kokoro-82M TTS pipeline

- **Model**: `onnx-community/Kokoro-82M-v1.0-ONNX`. Default dtype `q8` (~92 MB); fp16/fp32 selectable.
  kokoro-js → @huggingface/transformers → onnxruntime-web.
- **Weights cache**: `env.useBrowserCache = true` puts every fetched file (model + voice bins) in
  CacheStorage keyed by URL — after the first download the app works in airplane mode. The service
  worker separately precaches the app shell **and** the self-hosted ORT runtime in `/public/ort`
  (21 MB wasm), so `globIgnores: ['**/assets/ort-wasm-*']` avoids double-caching the worker-bundled copy.
- **Backend**: WebGPU (fp32) auto-detected, WASM fallback; `?device=&dtype=` URL overrides and the
  ModelLoader picker force either. Note GitHub Pages can't send COOP/COEP → single-threaded WASM there.
- **Phonemization**: `phonemizer@1.2` is bundled with English-only eSpeak data despite listing
  Spanish language identifiers. Spanish voices (`ef_dora`, `em_alex`) instead use the full
  `espeak-ng` WASM bundle, which includes `es_dict`. It produces IPA, then `tts.tokenizer()` converts
  it to Kokoro IDs before `generate_from_ids()`. `tests/espeak-es.test.mjs` guards this path.
- **Queue**: `ensure()` dedupes by `${sentenceId}|${voice}|${speed}`; `prefetch()` keeps 4 sentences
  in flight ahead of the cursor; `playLoop` awaits only the *next* buffer, so playback starts with
  the first synthesized sentence (<1 s on capable hardware) instead of waiting for a chapter.
- **Long text**: `chunkText` splits >320-char segments at clause boundaries (Kokoro truncates past
  510 tokens silently).
- **Bench**: `npm run e2e`-style `tests/bench.py` measures realtime factor; on the dev laptop's
  m3-7Y32 WASM q8 was 0.06–0.19× (expected much faster on A16).

### 3.4 iOS Safari & background audio

- **AudioContext unlock**: created lazily inside the play() user-gesture call chain; `ctx.resume()`
  retried on visibilitychange.
- **Keepalive**: `setupKeepalive()` creates a hidden `<audio loop src="data:audio/wav;base64,…">`
  (a generated 1 s silent 8 kHz WAV). While it loops, Mobile Safari treats the page as an active
  media session and does not suspend JS/WASM on screen lock. This is the standard PWA-audiobook trick.
- **MediaSession**: metadata (title/author/cover art) on book load; action handlers play, pause,
  seekbackward/forward (±15 s), previoustrack/nexttrack (chapter). `playbackState` synced on every
  state change.
- **Limits**: fully-backgrounded *synthesis* is still throttled by iOS; the 4-sentence pre-buffer is
  what covers screen-lock gaps. Low-memory iOS can evict CacheStorage unless
  `navigator.storage.persist()` succeeds (ModelLoader requests it and shows the outcome).
- **PWA install**: manifest `display: standalone`, `apple-mobile-web-app-capable`, touch icons;
  registerSW with `immediate: true` so updates apply on next open.

### 3.5 Persistence layer

IndexedDB `kokoro-reader` v1, five stores:

| store | key | value |
|---|---|---|
| `books` | id | BookMeta (+ `dialogueMode`, coverBlob, addedAt; index `addedAt`) |
| `bodies` | id | `{ id, chapters, paragraphs, sentences }` — big payload kept apart so listing is fast |
| `voices` | bookId | VoiceConfig |
| `progress` | bookId | `{ bookId, sentenceId }` |
| `settings` | key | ReaderSettings and misc kv |

Functions: `saveBook / listBooks / loadBook / deleteBook / getVoices / setVoices / getProgress /
setProgress / getAllProgress / getSettings / setSettings / estimateUsage / requestPersistence`.
Note `reparseBook` changes sentence numbering → `App.onMode` saves the re-parsed book *and* resets
progress to the mapped paragraph's first sentence.

---

## 4. "How to Modify" Cookbook

### Add or replace Kokoro voices

1. Check the voice file exists: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/voices/<id>.bin`.
2. Add the id to the `VoiceId` union in `src/types.ts` and a row in `VOICE_CATALOG`
   (`{ id: 'ef_x', label: 'Name (ES ♀)', lang: 'es', gender: 'f' }`).
3. Non-English voices must be accepted in `tts.worker.ts` `synth()`'s phonemizer route (any id not
   starting with `a`/`b` goes through espeak — extend the condition for new language prefixes).
4. Defaults live in `DEFAULT_VOICES_EN/ES` (types.ts). The picker, warming, and persistence pick up
   new ids automatically.

### Tweak dialogue detection

- New speech verbs: add to `SPEECH_VERBS` (dialogueParser.ts, gender inference) **and**
  `FIRST_ES/THIRD_ES` (speakerTags.ts, tag detection) if you want tags mode to see them.
- New quote style: extend `OPEN_Q` and the matching closer logic in `markDialogue`.
- Tune tag rules: `TAG` regex and `looksUnquoted` thresholds in speakerTags.ts. Run
  `npm test` — the Heller fixture (tests/fixtures/heller-es-paras.json) will catch regressions.
- Change mode thresholds: `looksUnquoted` (currently `<10 quotes && ≥8 tags` in first 600 paragraphs).

### Responsiveness rules (already baked in)

- All breakpoints are plain CSS media queries in `src/index.css` (`.library-grid`, `.reader-pad`,
  `.chrome-px`, `.player-cover` helpers) — ≤340px shrinks the shelf to 2 covers and tightens
  reading margins, ≥428px goes to 4, ≥768px to 6, landscape to 4.
- Safe areas come from the `--sat/--sab/--sal/--sar` CSS vars and `pt-safe/pb-safe/px-safe/pl-safe`
  helpers — use those classes on any new fixed overlay.
- `tests/viewports.py` renders the five breakpoints via CDP and fails on `scrollWidth -
  clientWidth > 0`. Add new fixed overlays to that check.

### Add a reading theme / typography

1. `src/types.ts` → `ReaderSettings.theme` union; `src/index.css` `@theme` tokens (colors/fonts are
   Tailwind v4 theme vars, e.g. `--font-literata`).
2. `ReaderView.tsx` has the `THEMES`/`FONTS` maps (background/ink/muted per theme; font stacks) —
   add an entry and it appears in the Aa popover. Themes apply via inline style on the reader root;
   keep `env(safe-area-inset-*)` padding intact.

### Change model version / quantization

- Model id: `MODEL_ID` const at top of `src/workers/tts.worker.ts` (and the same string in
  `warmVoices`). Bump to a new HF repo → delete old cache at runtime (CacheStorage is keyed by URL,
  so stale files just sit unused; a "clear model cache" button would iterate
  `caches.delete(...)` if you add one).
- Quantization: dtype picker already supports `q4/q8/fp16/fp32` — the worker passes it straight to
  `KokoroTTS.from_pretrained`. Change the default in `ttsEngine.loadModel()` and the ModelLoader UI.
- ORT runtime: replace `public/ort/*` with the new `ort-wasm-simd-threaded.jsep.{mjs,wasm}` from
  `node_modules/@huggingface/transformers/dist/` after upgrading transformers, and rebuild.

### Debug audio stutter / iOS memory

1. **Stutter**: open console, `__engine.debug()` → `{cache, pending}`; `bench()` via
   `tests/bench.py`. If realtime factor < 1, raise `LOOKAHEAD` (ttsEngine.ts) — more pre-buffer,
   more memory. On iOS also confirm the keepalive audio is `playing` (debug output) — if Safari
   killed it, synthesis gets throttled in background.
2. **Memory**: `__engine.debug().cache` is the AudioBuffer LRU (cap in `putCache`). iOS jetsam
   kills at ~1 GB; if the tab dies on long books, lower the cap and LOOKAHEAD, prefer q8, and check
   `estimateUsage()` in ModelLoader.
3. **Worker crashes** surface as `state: 'error'` with the message in the ModelLoader; WASM OOM on
   fp32 is the classic cause — fall back to q8.
4. E2E reproduction without a phone: `npm run build && npm run serve`, then
   `python3 tests/e2e.py book.epub` (headless Chromium, prints cursor/role trace) and
   `python3 tests/serve-https.py` for the real phone on LAN.
