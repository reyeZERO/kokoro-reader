export type VoiceId =
  // American English female
  | 'af_heart' | 'af_alloy' | 'af_aoede' | 'af_bella' | 'af_jessica' | 'af_kore' | 'af_nicole' | 'af_nova' | 'af_river' | 'af_sarah' | 'af_sky'
  // American English male
  | 'am_adam' | 'am_echo' | 'am_eric' | 'am_fenrir' | 'am_liam' | 'am_michael' | 'am_onyx' | 'am_puck' | 'am_santa'
  // British English
  | 'bf_alice' | 'bf_emma' | 'bf_isabella' | 'bf_lily' | 'bm_daniel' | 'bm_fable' | 'bm_george' | 'bm_lewis'
  // Spanish
  | 'ef_dora' | 'em_alex' | 'em_santa'

export type Lang = 'en' | 'es'

export interface Sentence {
  /** Global sentence index across the whole book */
  id: number
  text: string
  paragraphIdx: number
  chapterIdx: number
  role: SpeakerRole
  /** Local offset (chars) inside the paragraph, for highlight mapping */
  start: number
  end: number
}

export type SpeakerRole = 'narrator' | 'male' | 'female' | 'unknown'

export interface Paragraph {
  id: number
  chapterIdx: number
  text: string
  /** Heading level, 0 = body text */
  heading: 0 | 1 | 2 | 3
  sentenceIds: number[]
}

export interface Chapter {
  idx: number
  title: string
  href: string
  paragraphIds: number[]
  /** First sentence id in this chapter, for seeking */
  firstSentenceId: number
  wordCount: number
}

export interface BookMeta {
  id: string
  title: string
  author: string
  language: Lang
  coverBlob?: Blob
  addedAt: number
  wordCount: number
  sentenceCount: number
  chapterCount: number
}

export interface Book extends BookMeta {
  chapters: Chapter[]
  paragraphs: Paragraph[]
  sentences: Sentence[]
}

export interface VoiceConfig {
  narrator: VoiceId
  male: VoiceId
  female: VoiceId
  unknown: VoiceId
  speed: number
}

export interface Progress {
  bookId: string
  sentenceId: number
  updatedAt: number
}

export type ReaderTheme = 'black' | 'sepia' | 'light'
export type ReaderFont = 'literata' | 'bookerly' | 'serif' | 'sans'

export interface ReaderSettings {
  theme: ReaderTheme
  font: ReaderFont
  fontSize: number
  lineHeight: number
}

export const DEFAULT_VOICES_EN: VoiceConfig = {
  narrator: 'af_bella', male: 'am_adam', female: 'af_sarah', unknown: 'af_bella', speed: 1,
}
export const DEFAULT_VOICES_ES: VoiceConfig = {
  narrator: 'ef_dora', male: 'em_alex', female: 'ef_dora', unknown: 'ef_dora', speed: 1,
}

export const VOICE_CATALOG: { id: VoiceId; label: string; lang: Lang; gender: 'f' | 'm' }[] = [
  { id: 'af_heart', label: 'Heart (US ♀)', lang: 'en', gender: 'f' },
  { id: 'af_bella', label: 'Bella (US ♀)', lang: 'en', gender: 'f' },
  { id: 'af_sarah', label: 'Sarah (US ♀)', lang: 'en', gender: 'f' },
  { id: 'af_nicole', label: 'Nicole (US ♀, whisper)', lang: 'en', gender: 'f' },
  { id: 'af_sky', label: 'Sky (US ♀)', lang: 'en', gender: 'f' },
  { id: 'af_nova', label: 'Nova (US ♀)', lang: 'en', gender: 'f' },
  { id: 'am_adam', label: 'Adam (US ♂)', lang: 'en', gender: 'm' },
  { id: 'am_michael', label: 'Michael (US ♂)', lang: 'en', gender: 'm' },
  { id: 'am_fenrir', label: 'Fenrir (US ♂)', lang: 'en', gender: 'm' },
  { id: 'am_onyx', label: 'Onyx (US ♂, deep)', lang: 'en', gender: 'm' },
  { id: 'bf_emma', label: 'Emma (UK ♀)', lang: 'en', gender: 'f' },
  { id: 'bf_isabella', label: 'Isabella (UK ♀)', lang: 'en', gender: 'f' },
  { id: 'bm_george', label: 'George (UK ♂)', lang: 'en', gender: 'm' },
  { id: 'bm_fable', label: 'Fable (UK ♂)', lang: 'en', gender: 'm' },
  { id: 'ef_dora', label: 'Dora (ES ♀)', lang: 'es', gender: 'f' },
  { id: 'em_alex', label: 'Alex (ES ♂)', lang: 'es', gender: 'm' },
  { id: 'em_santa', label: 'Santa (ES ♂)', lang: 'es', gender: 'm' },
]
