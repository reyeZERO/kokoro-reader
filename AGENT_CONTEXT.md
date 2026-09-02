# AGENT_CONTEXT — Kokoro Reader (token-dense reference for headless AI/CLI)

PWA. Offline EPUB→TTS. React18+TS+Vite+Tailwind4, kokoro-js (Kokoro-82M ONNX) in Web Worker,
onnxruntime-web WASM self-hosted. No backend. Deploy: GH Pages `BASE_PATH=/<repo>/ npm run build`.
Live: https://reyezero.github.io/kokoro-reader/ · repo reyeZERO/kokoro-reader (branch master).

## Entry points
- src/main.tsx:13 React root + registerSW({immediate:true})
- src/App.tsx view state {library|reader}; openBook(id) L26; onMode reparse L44 (maps cursor via paragraphIdx); model warmup timeout 1.2s L22
- vite.config.ts: base=process.env.BASE_PATH||'/'; VitePWA precache globPatterns js,css,html,svg,png,woff2,mjs,wasm; maxFile 30MB; globIgnores **/assets/ort-wasm-* (self-hosted copy in public/ort wins)
- index.html: viewport-fit=cover, user-scalable=no, apple-touch-icon icons/icon-192.png (relative!)

## Types (src/types.ts)
Lang='en'|'es'; SpeakerRole='narrator'|'male'|'female'|'unknown'; DialogueMode='punctuation'|'tags'|'solo'
VoiceId union (af_*/am_*/bf_*/bm_*/ef_dora/em_alex)
Sentence{id,text,paragraphIdx,chapterIdx,role,dialogue?,start,end} // start/end=char offsets in paragraph text
Paragraph{id,chapterIdx,text,heading:0|1|2|3,sentenceIds[]}
Chapter{idx,title,href,paragraphIds[],firstSentenceId,wordCount}
BookMeta{id,title,author,language,coverBlob?,addedAt,wordCount,sentenceCount,chapterCount,dialogueMode?}
Book=BookMeta+{chapters[],paragraphs[],sentences[]}
VoiceConfig{narrator,male,female,unknown:VoiceId,speed:number}; DEFAULT_VOICES_EN/ES L88-93
VOICE_CATALOG L95 [{id,label,lang,gender:'f'|'m'}]

## services/epubParser.ts (315L)
parseFile(file)→Book L12 (epub|txt); parseEpub L43: jszip→container.xml→OPF→spine; TOC nav>ncx; cover via properties=cover-image; dc:language else detectLang
BookBuilder L184: records ops[], finish() auto-mode looksUnquoted(first 600 body paras)→'tags' else 'punctuation'
reparseBook(book,mode)→Book L210 (same id/meta; sentence ids shift→reset progress)
buildStructure(ops,lang,mode) L218: per paragraph→mode==='tags'?tags.segment()??ctx.segment() : 'solo'?soloSegments : ctx.segment(); long para>MAX_PARAGRAPH_CHARS→chunkBySentences L237
detectLang(sample) L311 stopwords
Imports Book text only at addParagraph; heading>0 forces narrator-only

## services/dialogueParser.ts (218L) PURE, no DOM
splitSentences(text)→{start,end}[] L23 (ABBREV set, initials, decimals, ellipsis)
markDialogue(p)→boolean[] L172 char mask: OPEN_Q='"“«', em-dash — open/close pairs
DialogueContext L83: segment(paragraph,lang)→Segment[] L91; gender from narrative pronouns MALE_EN/FEMALE_EN/MALE_ES/FEMALE_ES L73-76, SPEECH_VERBS L77; untagged dialogue alternates last↔prev speaker L111-117
Segment{start,end,role,dialogue} L11; mergeTiny merges punctuation-only segs L145

## services/speakerTags.ts (109L) unquoted-prose parser (Heller/McCarthy)
TAG regex L25: ^(.+?[,?!…])\s+(VERB)(?!\s+que\b)(.*)$ — comma/?/! + utterance verb, NOT "dijo que"
FIRST_ES/THIRD_ES L18-19, FIRST_EN/THIRD_EN L20-21 (THIRD_EN includes "(he|she) said")
SpeakerTagContext L37: segment()→Segment[]|null(null=no tag→caller falls back to punctuation parser); names Map memoizes character→voice; unknown names alternate vs lastThird L84-90; setName() seeds gender
First-person tag (dije) → role stays 'narrator' but dialogue:true
Untagged ¿…?/¡…! right after tagged line inherits speaker L64-67
looksUnquoted(paras)→bool L102: quotes<10 && tags>=8

## services/chunkText.ts chunkText(text,max=320) clause splits ;:—, then spaces (Kokoro 510-token truncation guard)

## services/ttsEngine.ts (507L) class TTSEngine, singleton `engine`, globalThis.__engine for tests
States: idle|loading-model|ready|buffering|playing|paused|error L11
Fields L31-53: worker, ctx:AudioContext, keepalive:HTMLAudioElement, cursor, cache Map(key→AudioBuffer), pending Map(key→{reqId,resolve,reject}), playToken, sleepTimer
loadModel({dtype='q8',device=auto}) L72 — auto: WebGPU→fp32 else wasm; URL overrides ?device=&dtype=
onWorkerMessage L97: ready→warmVoices; audio→cache+resolve pending; progress→fileProgress
setupKeepalive L171: hidden looping silent WAV <audio> (iOS screen-lock); makeSilentWav L135
setBook L191 (cursor clamp, cache.clear); setVoices L207 (warm+clear cache+restart if playing)
play L220 (unlock→loadModel→token→keepalive.play→prefetch→playLoop); pause L234; seek L244; skip(±15s) L254; next/prevChapter L268/276
playLoop L294: ensure(cursor)→playBuffer→onended→cursor++; token guards stale continuations
ensure(s) L369 dedupe key=`${s.id}|${voiceFor}|${speedFor}`; voiceFor L358 role→VoiceId; speedFor L363: dialogue && (mode==='solo'||role==='narrator') → speed*0.94
prefetch L386 LOOKAHEAD=4; putCache L404 LRU cap; durationOf L416 (cached real else words/2.6/speed)
MediaSession L436-462: metadata(cover), play/pause/seekbackward15/seekforward15/prevchapter/nextchapter
debug() L68; bench() L67

## workers/tts.worker.ts (189L)
WorkerIn: load{dtype,device}|synth{reqId,sentenceId,text,voice,speed}|cancel{reqId?}|bench|warmVoices{voices[]} L11
WorkerOut: ready{voices}|audio{reqId,samples:Float32Array,sampleRate,ms}|progress{file,loaded,total}|error{message}|bench{result}|voicesWarmed{ok,failed}
env.useBrowserCache=true (CacheStorage offline), allowLocalModels=false; wasmPaths=`${import.meta.env.BASE_URL}ort/` L39
MODEL_ID='onnx-community/Kokoro-82M-v1.0-ONNX'
synth: >320 chars→chunkText; ef_/em_ Spanish voices→full espeak-ng WASM (IPA)→tokenizer→generate_from_ids; EN→kokoro generate(text,{voice,speed})
warmVoices: fetch voices/<id>.bin into cache 'kokoro-voices'... (writes via caches API so offline voice switch works)

## services/db.ts (111L) idb, DB 'kokoro-reader' v1
stores: books(BookMeta, idx addedAt), bodies({id,chapters,paragraphs,sentences}), voices(kp bookId), progress(kp bookId), settings(kv)
saveBook L35 (meta/body split), listBooks L46 (newest first), loadBook L52, deleteBook L59, getVoices/setVoices L71/78, getProgress/setProgress L82/85, getAllProgress L88, getSettings/setSettings L94/98, estimateUsage L102, requestPersistence L109

## Components (props in each file header)
LibraryView L14: shelf grid, import input[type=file], delete, storage meter, model button
ReaderView L27: chapter virtualization, karaoke span highlight, tap-to-read, TOC drawer, Aa settings, VoiceConfigModal mount L186
AudioPlayer L19: mini (safe-area bottom) + fullscreen, CSS waveform, ±15s, sleep timer 15/30/chapter, speed
VoiceConfigModal L21: speed row, MODES toggle (punctuation|tags|solo), 4 VoiceRows
ModelLoader L16: device/dtype picker, progress bars, persistence request
hooks/useEngine.ts L4: subscribes engine events → {state,sentenceId,buffered,progress,error}
utils/format.ts: formatDuration, formatClock

## Tests / tooling
npm test = node --experimental-strip-types tests/dialogue.test.ts(23 cases) + tests/tags.test.ts(10+fixture)
tests/fixtures/heller-es-paras.json: 2354 real ES paragraphs; expected tags-mode output ≈140 tagged paras (45m/48f/49self/9unk)
tests/e2e.py <book>: headless chromium (~/.cache/ms-playwright/chromium-1234), CDP via tests/websocket_min.py (stdlib RFC6455); flow: navigate→reload(SW update)→import via DataTransfer→open newest→assert chapters/cover(+dialogue iff quotes>20)→tap→play→sample cursor; prints mini-player text
tests/bench.py: DEV=webgpu DTYPE=fp32 env; chrome flags --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan
tests/serve.py dist 4173: COOP=same-origin, COEP=credentialless (SAB/threaded WASM)
tests/serve-https.py: self-signed LAN HTTPS :8443 for iPhone (cert trust steps in docstring)

## Environment constraints
- iOS Safari PWA: AudioContext must be created/resumed in user gesture; keepalive silent <audio loop> prevents JS/WASM suspend on screen lock; background synthesis still throttled → LOOKAHEAD buffer covers
- GitHub Pages: no COOP/COEP headers → WASM single-threaded there
- CacheStorage eviction unless navigator.storage.persist() granted; iOS tab jetsam ~1GB → keep cache/LOOKAHEAD modest
- Kokoro truncates >510 tokens silently → chunkText 320
- kokoro-js validates EN voices only; `phonemizer@1.2` has EN-only eSpeak data despite advertising ES. ES uses the bundled full `espeak-ng` WASM; regression: `node tests/espeak-es.test.mjs`.
- Model: q8≈92MB fp16≈160MB fp32≈325MB in CacheStorage; first load needs network, then offline
- terminal guard: use `npm install --no-fund --no-audit` (plain `npm i` blocked); long builds/e2e in background procs w/ logs /tmp/kr-*
- HF downloads from this dev box ~2KB/s (throttled) — don't fetch big models here
