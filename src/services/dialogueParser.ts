/**
 * Sentence segmentation + heuristic dialogue/speaker detection.
 * Pure functions, no DOM — safe to run in a worker.
 *
 * Pipeline per paragraph:  splitSentences → markDialogue (char mask) → split each sentence at
 * dialogue boundaries → assign role (narrator / male / female / unknown) per segment.
 * Result: `"Come here," she said.` becomes two segments spoken by two voices.
 */
import type { Lang, SpeakerRole } from '../types'

export interface Segment { start: number; end: number; role: SpeakerRole; dialogue: boolean }

// ---------- Sentence splitting ----------

const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'vol', 'fig',
  'sra', 'srta', 'dra', 'ud', 'uds', 'pág', 'cap', 'art', 'gral', 'ing', 'lic', 'av', 'apdo',
])
const TERMINAL = '.!?'
const CLOSERS = /[.!?…"”’'»)\]]/

/** Splits text into sentences, returning [start, end) char ranges. */
export function splitSentences(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const len = text.length
  let start = 0
  let i = 0
  while (i < len) {
    const ch = text[i]
    const isEllipsis = ch === '…' || (ch === '.' && text[i + 1] === '.' && text[i + 2] === '.')
    if (TERMINAL.includes(ch) || ch === '…') {
      let j = i + 1
      while (j < len && CLOSERS.test(text[j])) j++
      const next = text[j]
      const after = text[j + 1]
      let isEnd = j >= len || next === '\n'
      if (!isEnd && /\s/.test(next)) {
        // Ellipsis followed by lowercase continues the sentence ("Well… I suppose" → only splits on uppercase non-'I' words? no: keep simple)
        if (isEllipsis) isEnd = j + 1 < len ? /[A-ZÁÉÍÓÚÑ"“«¿¡—]/.test(after) && !/^I\b/.test(text.slice(j + 1, j + 3)) : true
        else isEnd = true
      }
      if (isEnd && ch === '.' && !isEllipsis && isAbbrev(text, i)) { i = j; continue }
      // Decimal numbers "3.50"
      if (ch === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) { i++; continue }
      if (isEnd) {
        if (text.slice(start, j).trim()) out.push({ start, end: j })
        while (j < len && /\s/.test(text[j])) j++
        start = j; i = j
        continue
      }
    }
    i++
  }
  if (start < len && text.slice(start).trim()) out.push({ start, end: len })
  return out
}

function isAbbrev(text: string, dotIdx: number): boolean {
  let k = dotIdx - 1
  while (k >= 0 && /[\p{L}.]/u.test(text[k])) k--
  const word = text.slice(k + 1, dotIdx).toLowerCase().replace(/\.$/, '')
  if (ABBREV.has(word)) return true
  if (word.length === 1 && /\p{Lu}/u.test(text[k + 1] ?? '')) return true // initials: J. K. Rowling
  return false
}

// ---------- Dialogue detection ----------

const OPEN_Q = '"“«'

// Unicode-aware word boundaries (JS \b is ASCII-only → fails on "él", "señora")
const W = (alts: string) => new RegExp(`(?<!\\p{L})(?:${alts})(?!\\p{L})`, 'iu')
const MALE_EN = W('he|him|his|mr\\.?|sir|father|dad|brother|uncle|king|prince|lord|boy|man|gentleman|husband|son')
const FEMALE_EN = W('she|her|hers|mrs\\.?|ms\\.?|miss|madam|mother|mom|sister|aunt|queen|princess|lady|girl|woman|wife|daughter')
const MALE_ES = W('él|señor|sr\\.?|don|padre|papá|hermano|tío|rey|príncipe|niño|hombre|muchacho|chico|esposo|hijo|abuelo|marido')
const FEMALE_ES = W('ella|señora|señorita|sra\\.?|srta\\.?|doña|madre|mamá|hermana|tía|reina|princesa|niña|mujer|muchacha|chica|esposa|hija|abuela')
const SPEECH_VERBS = W('said|says|asked|replied|answered|whispered|shouted|cried|muttered|exclaimed|murmured|yelled|called|added|continued|told|snapped|growled|laughed|sighed|dijo|dice|preguntó|pregunta|respondió|responde|contestó|susurró|gritó|exclamó|murmuró|añadió|agregó|continuó|replicó|afirmó|comentó|explicó|repuso|balbuceó|rió|insistió')

/**
 * Tracks speaker gender across paragraphs: remembers the last explicitly-gendered speaker,
 * and untagged dialogue right after dialogue alternates between the two most recent speakers.
 */
export class DialogueContext {
  private lastGender: 'male' | 'female' | null = null
  private prevGender: 'male' | 'female' | null = null
  private lastWasDialogue = false

  reset() { this.lastGender = null; this.prevGender = null; this.lastWasDialogue = false }

  /** Full pipeline for one paragraph. */
  segment(paragraph: string, lang: Lang): Segment[] {
    const sentences = splitSentences(paragraph)
    const mask = markDialogue(paragraph)
    const hasDialogue = mask.some(Boolean)
    if (!hasDialogue) {
      this.lastWasDialogue = false
      return sentences.map(r => ({ ...r, role: 'narrator', dialogue: false }))
    }

    // Narrative-only text drives gender inference
    let narrative = ''
    for (let i = 0; i < paragraph.length; i++) narrative += mask[i] ? ' ' : paragraph[i]
    const male = MALE_EN.test(narrative) || MALE_ES.test(narrative)
    const female = FEMALE_EN.test(narrative) || FEMALE_ES.test(narrative)

    let gender: 'male' | 'female' | null = null
    if (male && !female) gender = 'male'
    else if (female && !male) gender = 'female'
    else if (male && female) gender = nearestGender(narrative, lang)

    if (!gender) {
      if (this.lastWasDialogue && this.lastGender && this.prevGender && this.lastGender !== this.prevGender) gender = this.prevGender
      else if (this.lastWasDialogue && this.lastGender) gender = this.lastGender === 'male' ? 'female' : 'male'
      else gender = this.lastGender
    }
    if (gender && gender !== this.lastGender) { this.prevGender = this.lastGender; this.lastGender = gender }
    this.lastWasDialogue = true

    // Split each sentence at dialogue boundaries
    const segs: Segment[] = []
    for (const s of sentences) {
      let segStart = s.start
      let cur = mask[s.start]
      for (let k = s.start + 1; k <= s.end; k++) {
        const v = k < s.end ? mask[k] : !cur
        if (v !== cur) {
          pushSeg(segs, paragraph, segStart, k, cur, gender)
          segStart = k; cur = v
        }
      }
    }
    return mergeTiny(segs, paragraph)
  }
}

function pushSeg(segs: Segment[], p: string, start: number, end: number, dialogue: boolean, gender: 'male' | 'female' | null) {
  // Trim whitespace; pull leading/trailing quote marks into the dialogue segment for natural reading
  while (start < end && /\s/.test(p[start])) start++
  while (end > start && /\s/.test(p[end - 1])) end--
  if (start >= end) return
  segs.push({ start, end, dialogue, role: dialogue ? (gender ?? 'unknown') : 'narrator' })
}

/** Merge segments that carry no pronounceable content (just punctuation/quotes) into their neighbour. */
function mergeTiny(segs: Segment[], p: string): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    const txt = p.slice(s.start, s.end)
    if (!/[\p{L}\p{N}]/u.test(txt) && out.length) { out[out.length - 1].end = s.end; continue }
    out.push({ ...s })
  }
  return out
}

function nearestGender(text: string, lang: Lang): 'male' | 'female' | null {
  const verb = SPEECH_VERBS.exec(text)
  if (!verb) return null
  const vi = verb.index
  const m = (lang === 'es' ? MALE_ES : MALE_EN).exec(text) ?? (lang === 'es' ? MALE_EN : MALE_ES).exec(text)
  const f = (lang === 'es' ? FEMALE_ES : FEMALE_EN).exec(text) ?? (lang === 'es' ? FEMALE_EN : FEMALE_ES).exec(text)
  if (!m) return f ? 'female' : null
  if (!f) return 'male'
  return Math.abs(m.index - vi) <= Math.abs(f.index - vi) ? 'male' : 'female'
}

/**
 * Boolean per character: true if inside dialogue.
 * Handles "..." “...” «...» and Spanish/French em-dash dialogue:
 *   —Hola —dijo él—. Adiós.      → [Hola] narr:[dijo él] [Adiós.]
 *   Ella miró. —Es tarde —murmuró. → narr [Es tarde] narr
 */
export function markDialogue(p: string): boolean[] {
  const mask = new Array<boolean>(p.length).fill(false)
  const trimmed = p.trimStart()

  const startsWithDash = /^[—–]\s?[^\s—–]/.test(trimmed)
  const dashAfterSentence = /[.!?…]\s+[—–]\s?[^\s—–]/.test(p)
  if (startsWithDash || dashAfterSentence) {
    let inDialogue = false
    for (let i = 0; i < p.length; i++) {
      const c = p[i]
      if (c === '—' || c === '–') {
        const prev = prevNonSpace(p, i)
        const attached = i > 0 && !/\s/.test(p[i - 1])
        if (!inDialogue) {
          // Opens after start / sentence end, or resumes after an attached inciso close ("él—.")
          if (prev === null || /[.!?…:]/.test(prev) || attached) { inDialogue = true; mask[i] = !attached }
        } else {
          inDialogue = false
        }
        continue
      }
      // After a resume-dash, skip the trailing punctuation belonging to the inciso ("—. Adiós")
      if (inDialogue && i > 0 && (p[i - 1] === '—' || p[i - 1] === '–') && /[.,;:]/.test(c) && !/\s/.test(p[i - 2] ?? ' ')) continue
      mask[i] = inDialogue
    }
    // Any regular quotes inside are also dialogue (handled by fallthrough below? no — keep dash result)
    return mask
  }

  // Quote-based
  let open: string | null = null
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (!open && OPEN_Q.includes(c)) { open = c; mask[i] = true; continue }
    if (open) {
      mask[i] = true
      const closes = (open === '"' && c === '"') || (open === '“' && (c === '”' || c === '“')) || (open === '«' && c === '»')
      if (closes) open = null
    }
  }
  return mask // unterminated quote → dialogue continues to the end (multi-paragraph speech)
}

function prevNonSpace(p: string, i: number): string | null {
  for (let k = i - 1; k >= 0; k--) if (!/\s/.test(p[k])) return p[k]
  return null
}
