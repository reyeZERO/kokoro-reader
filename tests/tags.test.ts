import { readFileSync } from 'node:fs'
import { SpeakerTagContext, looksUnquoted } from '../src/services/speakerTags.ts'

let fails = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`) } else console.log(`ok   ${name}`)
}
const roles = (p: string, ctx = new SpeakerTagContext()) => ctx.segment(p, 'es')?.map(s => `${s.role}${s.dialogue ? '*' : ''}:${p.slice(s.start, s.end)}`) ?? null

eq('first person', roles('Ya lo sé, dije.'), ['narrator*:Ya lo sé,', 'narrator:dije.'])
eq('third male', roles('Termina, dijo el viejo con voz asfixiada. Los ojos flotaron hacia arriba. Dispara, suplicó.'),
  ['male*:Termina,', 'narrator:dijo el viejo con voz asfixiada.', 'narrator:Los ojos flotaron hacia arriba.', 'male*:Dispara,', 'narrator:suplicó.'])
eq('murmuré', roles('No sé francés, murmuré.'), ['narrator*:No sé francés,', 'narrator:murmuré.'])
eq('no tag → null', roles('Empezó a hacer calor enseguida. La primavera cedió sin resistencia.'), null)
eq('dijo que is not a tag', roles('Me dijo que serviría con cualquier pistola.'), null)
eq('named speaker alternates', roles('Vamos, dijo Bangley. No, dijo Hig.'), ['male*:Vamos,', 'narrator:dijo Bangley.', 'female*:No,', 'narrator:dijo Hig.'])
const ctx = new SpeakerTagContext(); ctx.setName('Bangley', 'male')
eq('question carries speaker', roles('Vamos, dijo Bangley. ¿Vienes o no?', ctx), ['male*:Vamos,', 'narrator:dijo Bangley.', 'male*:¿Vienes o no?'])
eq('english', new SpeakerTagContext().segment('Fine, I said. Go ahead, she said.', 'en')?.map(s => s.role + (s.dialogue ? '*' : '')), ['narrator*', 'narrator', 'female*', 'narrator'])

const paras: string[] = JSON.parse(readFileSync(new URL('./fixtures/heller-es-paras.json', import.meta.url), 'utf8'))
eq('heller detected as unquoted', looksUnquoted(paras.slice(0, 600)), true)
const c = new SpeakerTagContext(); const counts: Record<string, number> = {}; let taggedParas = 0
for (const p of paras) { const s = c.segment(p, 'es'); if (!s) continue; taggedParas++; for (const x of s) if (x.dialogue) counts[x.role] = (counts[x.role] ?? 0) + 1 }
console.log('heller: tagged paragraphs', taggedParas, 'spoken segments by role', counts)
eq('heller has >120 tagged paragraphs', taggedParas > 120, true)
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0)
