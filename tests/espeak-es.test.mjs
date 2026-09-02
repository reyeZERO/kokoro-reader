import assert from 'node:assert/strict'
import ESpeakNG from 'espeak-ng'

// Regression: `phonemizer` bundled by kokoro-js is English-only. This is the
// full Spanish espeak-ng WASM path used by tts.worker.ts.
const file = 'es-regression'
const espeak = await ESpeakNG({
  arguments: ['--phonout', file, '--sep=', '-q', '-b=1', '--ipa=3', '-v', 'es', 'Los humanos casi se han extinguido.'],
})
const ipa = espeak.FS.readFile(file, { encoding: 'utf8' }).trim()
assert.ok(ipa.length > 5, 'Spanish eSpeak returned no IPA')
assert.match(ipa, /ˈ|a|o/, 'Spanish eSpeak returned unexpected IPA')
console.log('Spanish eSpeak regression: PASS', ipa)
