import { useCallback, useEffect, useState } from 'react'
import { LibraryView } from './components/LibraryView'
import { ReaderView } from './components/ReaderView'
import { ModelLoader } from './components/ModelLoader'
import { engine } from './services/ttsEngine'
import { useEngine } from './hooks/useEngine'
import { getProgress, getSettings, getVoices, loadBook, saveBook, setProgress, setVoices as persistVoices } from './services/db'
import { reparseBook } from './services/epubParser'
import { DEFAULT_VOICES_EN, DEFAULT_VOICES_ES, type Book, type DialogueMode, type ReaderSettings, type VoiceConfig } from './types'

type View = { name: 'library' } | { name: 'reader'; book: Book }

export default function App() {
  const [view, setView] = useState<View>({ name: 'library' })
  const [showModel, setShowModel] = useState(false)
  const [voices, setVoicesState] = useState<VoiceConfig>(DEFAULT_VOICES_EN)
  const [settings, setSettings] = useState<ReaderSettings>({ theme: 'black', font: 'literata', fontSize: 19, lineHeight: 1.65 })
  const { state, progress, error } = useEngine()

  useEffect(() => { void getSettings().then(setSettings) }, [])

  // Warm the model in the background once the app is open (weights come from CacheStorage after first run).
  useEffect(() => {
    const t = setTimeout(() => { engine.loadModel().catch(() => {}) }, 1200)
    return () => clearTimeout(t)
  }, [])

  const openBook = useCallback(async (id: string) => {
    const book = await loadBook(id)
    if (!book) return
    const [saved, prog] = await Promise.all([getVoices(id), getProgress(id)])
    const v = saved ?? (book.language === 'es' ? DEFAULT_VOICES_ES : DEFAULT_VOICES_EN)
    setVoicesState(v)
    engine.setBook(book, v, prog?.sentenceId ?? 0)
    setView({ name: 'reader', book })
  }, [])

  const onVoices = (v: VoiceConfig) => {
    setVoicesState(v)
    engine.setVoices(v)
    if (view.name === 'reader') void persistVoices(view.book.id, v)
  }

  /** Re-segment the book with a different dialogue mode, keeping the reading position (same paragraph). */
  const onMode = (mode: DialogueMode) => {
    if (view.name !== 'reader' || view.book.dialogueMode === mode) return
    const old = view.book
    const wasPlaying = engine.getState() === 'playing'
    const pid = old.sentences[engine.getCursor()]?.paragraphIdx ?? 0
    const book = reparseBook(old, mode)
    const start = book.paragraphs[pid]?.sentenceIds[0] ?? 0
    engine.setBook(book, voices, start)
    setView({ name: 'reader', book })
    void saveBook(book).then(() => setProgress(book.id, start))
    if (wasPlaying) void engine.play(start)
  }

  const modelState = state === 'loading-model' ? 'loading' : state === 'error' ? 'error' : state === 'idle' ? 'idle' : 'ready'

  return (
    <>
      {view.name === 'library' && <LibraryView onOpen={openBook} onOpenModel={() => setShowModel(true)} modelState={modelState} />}
      {view.name === 'reader' && (
        <ReaderView book={view.book} voices={voices} settings={settings} onVoices={onVoices} onMode={onMode} onSettings={setSettings}
          onBack={() => { engine.pause(); setView({ name: 'library' }) }} />
      )}
      {showModel && <ModelLoader onClose={() => setShowModel(false)} progress={progress} state={state} error={error} />}
    </>
  )
}
