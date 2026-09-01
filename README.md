# Kokoro Reader

Offline-first PWA: EPUB/TXT reader with fully on-device neural TTS (Kokoro-82M via ONNX Runtime WASM),
multi-voice dialogue, karaoke highlighting, and Audible-style player. No backend, no sideloading.

## Run

    npm install --ignore-scripts    # sharp's native build is not needed; skip it
    npm rebuild esbuild @tailwindcss/oxide rolldown
    npm run dev                      # http://localhost:5173
    npm run build && npx serve dist  # production (any static host: GitHub Pages, Cloudflare Pages, Netlify)

First run downloads Kokoro-82M INT8 (~92 MB) + tokenizer + voice files from huggingface.co into
CacheStorage. After that everything works in airplane mode.

## iOS install

Open the deployed HTTPS URL in Safari → Share → Add to Home Screen. HTTPS is required for the service
worker and for `navigator.storage.persist()`. Tap the "Voice model" pill once to download while on WiFi.

## Tests

    node --experimental-strip-types tests/dialogue.test.ts   # sentence splitter + speaker heuristics
    python3 tests/e2e.py /path/to/book.epub                   # headless Chromium: import → play → karaoke

## Layout

    src/services/epubParser.ts     jszip + DOMParser: container → OPF → spine/TOC/cover → blocks → sentences
    src/services/dialogueParser.ts sentence splitting, quote/em-dash masks, pronoun+speech-verb gender heuristics
    src/services/ttsEngine.ts      worker orchestration, LRU AudioBuffer cache, lookahead prefetch,
                                   Web Audio scheduling, iOS unlock + silent keepalive, MediaSession
    src/workers/tts.worker.ts      Kokoro ONNX in a Worker; Spanish voices via espeak-ng phonemizer
    src/services/db.ts             idb: books, bodies, per-book voices, progress, settings
    src/components/                LibraryView, ReaderView, AudioPlayer (mini + full), VoiceConfigModal, ModelLoader
    public/ort/                    self-hosted ORT WASM so the SW precaches it (true offline)

## Notes / limits

- Kokoro INT8 on WASM runs ~1–2x realtime on an A16; the engine prefetches 4 sentences ahead and
  plays sentence 1 as soon as it's ready. Slow devices show "buffering" between sentences at 2x speed.
- iOS Safari will kill the page if memory exceeds ~1.2 GB. The q8 model + ORT arena stays around
  400–600 MB. Don't switch to fp32.
- Background playback: the looping silent <audio> keeps the audio session alive after screen lock;
  MediaSession exposes play/pause/±15s/chapter on the lock screen. Fully backgrounded synthesis is
  throttled by iOS — pre-buffer is what covers the gap.
- Speaker detection is heuristic. Manual override per book in the Voices sheet.
