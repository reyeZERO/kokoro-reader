import { splitSentences, markDialogue, DialogueContext } from '../src/services/dialogueParser.ts'

let fails = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`) } else console.log(`ok   ${name}`)
}
const sents = (t: string) => splitSentences(t).map(r => t.slice(r.start, r.end))

eq('basic split', sents('Hello there. How are you? Fine!'), ['Hello there.', 'How are you?', 'Fine!'])
eq('abbrev Mr.', sents('Mr. Darcy walked in. He sat down.'), ['Mr. Darcy walked in.', 'He sat down.'])
eq('initials', sents('J. K. Rowling wrote it. Really.'), ['J. K. Rowling wrote it.', 'Really.'])
eq('quote close', sents('"Come here," she said. "Now."'), ['"Come here," she said.', '"Now."'])
eq('curly quote after period', sents('“I know.” He left. “Fine.”'), ['“I know.”', 'He left.', '“Fine.”'])
eq('spanish ¿', sents('¿Qué pasa? No lo sé. ¡Vamos!'), ['¿Qué pasa?', 'No lo sé.', '¡Vamos!'])
eq('ellipsis continues lowercase', sents('Well… i suppose. Yes.'), ['Well… i suppose.', 'Yes.'])
eq('ellipsis ends on uppercase', sents('Well… Maybe. Yes.'), ['Well…', 'Maybe.', 'Yes.'])
eq('decimal', sents('It cost 3.50 dollars. Cheap.'), ['It cost 3.50 dollars.', 'Cheap.'])

const maskStr = (p: string) => markDialogue(p).map(b => b ? 'D' : '.').join('')
eq('curly quotes mask', maskStr('“Hi there,” he said.'), 'DDDDDDDDDDD.........')
//                                —Hola —dijo él—. Adiós.
eq('em-dash spanish', maskStr('—Hola —dijo él—. Adiós.'), 'DDDDDD..........DDDDDDD')
eq('guillemets', maskStr('«Ven aquí», susurró.'), 'DDDDDDDDDD..........')
eq('dash after narrative', maskStr('Ella miró. —Es tarde —murmuró.'), '...........DDDDDDDDDD.........')

const ctx = new DialogueContext()
const seg = (p: string, lang: 'en' | 'es' = 'en') => ctx.segment(p, lang).map(s => [p.slice(s.start, s.end), s.role])
ctx.reset()
eq('narrator only', seg('The sun rose over the hills.'), [['The sun rose over the hills.', 'narrator']])
eq('female tagged split', seg('“Come here,” she said. “Now.”'), [['“Come here,”', 'female'], ['she said.', 'narrator'], ['“Now.”', 'female']])
eq('male tagged', seg('"I will not," he replied.'), [['"I will not,"', 'male'], ['he replied.', 'narrator']])
eq('alternation → other speaker', seg('“Why not?”'), [['“Why not?”', 'female']])
eq('alternation again', seg('“Because.”'), [['“Because.”', 'male']])
ctx.reset()
eq('es male', seg('—No lo haré —dijo él—. Nunca.', 'es'), [['—No lo haré', 'male'], ['—dijo él—.', 'narrator'], ['Nunca.', 'male']])
eq('es female', seg('—¿Por qué? —preguntó ella.', 'es'), [['—¿Por qué?', 'female'], ['—preguntó ella.', 'narrator']])
eq('es mixed', seg('Ella miró la ventana. —Es tarde —murmuró.', 'es'), [['Ella miró la ventana.', 'narrator'], ['—Es tarde', 'female'], ['—murmuró.', 'narrator']])
ctx.reset()
eq('multi-sentence quote', seg('“Stop. Don’t move,” she whispered.'), [['“Stop.', 'female'], ['Don’t move,”', 'female'], ['she whispered.', 'narrator']])

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
