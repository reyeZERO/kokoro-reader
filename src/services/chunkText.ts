/** Split at clause boundaries (; : , — ) preferring the split closest to max, falling back to spaces. */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    let cut = -1
    for (const re of [/[;:—–]\s/g, /,\s/g, /\s/g]) {
      let m: RegExpExecArray | null
      while ((m = re.exec(rest)) && m.index < max) cut = m.index + m[0].length
      if (cut > max * 0.4) break
      cut = -1
    }
    if (cut <= 0) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

