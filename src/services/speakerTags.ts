/**
 * Speech-tag dialogue detection for books with minimalist punctuation (Heller, McCarthy, Saramago…):
 * no quotes or dashes, dialogue anchored only by verbs of utterance.
 *
 *   Ya lo sé, dije.                      → [Ya lo sé,] self   [dije.] narrator
 *   Termina, dijo el viejo con voz…      → [Termina,] male    [dijo el viejo…] narrator
 *   No sé francés, murmuré.              → [No sé francés,] self
 *   Dispara, suplicó.                    → speaker = last third-person speaker
 *   ¿Qué haces? (sentence after a tagged line, starts with ¿/¡/?) → same speaker
 *
 * First-person tags (dije / I said) mark the narrator's own spoken lines. They keep the narrator
 * voice but are flagged `dialogue: true` so "solo" mode can modulate them.
 * Pure functions, worker-safe.
 */
import type { Lang } from '../types'
import { splitSentences, type Segment } from './dialogueParser.ts'

const FIRST_ES = 'dije|digo|pregunté|pregunto|respondí|respondo|contesté|contesto|grité|grito|murmuré|susurré|solté|añadí|repetí|insistí|exclamé|repliqué|balbuceé|le dije|le pregunté|le solté|le contesté|le grité|le respondí'
const THIRD_ES = 'dijo|dice|preguntó|pregunta|respondió|responde|contestó|contesta|gritó|grita|murmuró|susurró|soltó|añadió|agregó|repitió|insistió|suplicó|exclamó|replicó|gruñó|rio|rió|sonrió|masculló|balbuceó|me dijo|me preguntó|me soltó|me contestó|me gritó|me respondió'
const FIRST_EN = 'I said|I say|I asked|I ask|I answered|I replied|I whispered|I shouted|I muttered|I told him|I told her'
const THIRD_EN = '(?:he|she) (?:said|says|asked|answered|replied|whispered|shouted|muttered)|said|says|asked|asks|answered|replied|whispered|shouted|muttered|cried|murmured|yelled|snapped|growled'

const L = (alts: string) => `(?<!\\p{L})(?:${alts})(?!\\p{L})`
/** dialogue-text , VERB rest   — the comma (or ?/!) right before the verb is what makes it a tag. */
const TAG = new RegExp(`^(.+?[,?!…])\\s+(${L(FIRST_ES)}|${L(THIRD_ES)}|${L(FIRST_EN)}|${L(THIRD_EN)})(?!\\s+que\\b)(.*)$`, 'su')
const FIRST = new RegExp(`^(?:${FIRST_ES}|${FIRST_EN})$`, 'iu')

const MALE_ES = /(?<!\p{L})(?:él|el (?:viejo|hombre|chico|niño|muchacho|tipo|padre|abuelo|hermano|tío|señor|piloto|soldado))(?!\p{L})/iu
const FEMALE_ES = /(?<!\p{L})(?:ella|la (?:vieja|mujer|chica|niña|muchacha|madre|abuela|hermana|tía|señora))(?!\p{L})/iu
const MALE_EN = /(?<!\p{L})(?:he|the (?:old man|man|boy|kid|father|guy))(?!\p{L})/iu
const FEMALE_EN = /(?<!\p{L})(?:she|the (?:old woman|woman|girl|mother))(?!\p{L})/iu
const NAME = /^\s*(?:a|to)?\s*([\p{Lu}][\p{Ll}]+)/u

export type TagRole = 'male' | 'female' | 'unknown'

/** Remembers named speakers' genders and the last third-person speaker across paragraphs. */
export class SpeakerTagContext {
  private names = new Map<string, TagRole>()
  private lastThird: TagRole | null = null

  reset() { this.lastThird = null }
  /** Pre-seed a name's gender (e.g. from user config). */
  setName(name: string, role: TagRole) { this.names.set(name.toLowerCase(), role) }

  segment(paragraph: string, lang: Lang): Segment[] | null {
    const sentences = splitSentences(paragraph)
    const out: Segment[] = []
    let tagged = false
    let carry: 'self' | TagRole | null = null   // speaker for untagged follow-up lines in this paragraph

    for (const s of sentences) {
      const txt = paragraph.slice(s.start, s.end)
      const m = TAG.exec(txt)
      if (m) {
        tagged = true
        const [, speech, verb, rest] = m
        const speaker = FIRST.test(verb.trim()) ? 'self' : this.thirdPerson(verb, rest, lang)
        const speechEnd = s.start + speech.length
        push(out, s.start, speechEnd, speaker === 'self' ? 'narrator' : speaker, true, paragraph)
        push(out, speechEnd, s.end, 'narrator', false, paragraph)
        carry = speaker
        if (speaker !== 'self') this.lastThird = speaker
      } else if (carry && /^\s*[¿¡?!]|^\s*[\p{Lu}][^.]{0,60}\?$/u.test(txt) && tagged) {
        // Untagged question/exclamation right after a tagged line → same speaker continues
        push(out, s.start, s.end, carry === 'self' ? 'narrator' : carry, true)
      } else {
        push(out, s.start, s.end, 'narrator', false)
        carry = null
      }
    }
    return tagged ? out : null
  }

  private thirdPerson(verb: string, rest: string, lang: Lang): TagRole {
    const nm = NAME.exec(rest)
    if (nm) {
      const key = nm[1].toLowerCase()
      const known = this.names.get(key)
      if (known) return known
    }
    const cue = verb + rest
    const male = (lang === 'es' ? MALE_ES : MALE_EN).test(cue) || (lang === 'es' ? MALE_EN : MALE_ES).test(cue)
    const female = (lang === 'es' ? FEMALE_ES : FEMALE_EN).test(cue) || (lang === 'es' ? FEMALE_EN : FEMALE_ES).test(cue)
    let role: TagRole = male && !female ? 'male' : female && !male ? 'female' : 'unknown'
    if (role === 'unknown' && nm) {
      // Unknown named speaker: alternate against the last third-person voice so two characters differ
      role = this.lastThird === 'male' ? 'female' : 'male'
      this.names.set(nm[1].toLowerCase(), role)
    } else if (role === 'unknown' && this.lastThird) role = this.lastThird
    if (nm && role !== 'unknown') this.names.set(nm[1].toLowerCase(), role)
    return role
  }
}

function push(out: Segment[], start: number, end: number, role: Segment['role'], dialogue: boolean, p?: string) {
  if (p) { while (start < end && /\s/.test(p[start])) start++; while (end > start && /\s/.test(p[end - 1])) end-- }
  if (end <= start) return
  out.push({ start, end, role, dialogue })
}

/** Cheap import-time detector: does this book need tag mode? */
export function looksUnquoted(sampleParagraphs: string[]): boolean {
  let quotes = 0, tags = 0
  for (const p of sampleParagraphs) {
    quotes += (p.match(/[“"«]|^\s*—/gm) ?? []).length
    for (const s of splitSentences(p)) if (TAG.test(p.slice(s.start, s.end))) tags++
  }
  return quotes < 10 && tags >= 8
}
