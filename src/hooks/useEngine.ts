import { useEffect, useState } from 'react'
import { engine, type EngineState } from '../services/ttsEngine'

export function useEngine() {
  const [state, setState] = useState<EngineState>(engine.getState())
  const [sentenceId, setSentenceId] = useState(engine.getCursor())
  const [buffered, setBuffered] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ file: string; loaded: number; total: number; status: string; overall: number } | null>(null)

  useEffect(() => {
    const offs = [
      engine.on('state', setState),
      engine.on('sentence', setSentenceId),
      engine.on('bufferHealth', setBuffered),
      engine.on('error', (m) => { setError(m); setTimeout(() => setError(null), 6000) }),
      engine.on('modelProgress', setProgress),
    ]
    return () => offs.forEach(f => f())
  }, [])

  return { state, sentenceId, buffered, error, progress, engine, isPlaying: state === 'playing' || state === 'buffering' }
}
