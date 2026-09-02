declare module 'espeak-ng' {
  interface ESpeakModule {
    FS: { readFile(path: string, options: { encoding: 'utf8' }): string }
  }
  interface ESpeakOptions { arguments: string[] }
  export default function ESpeakNG(options: ESpeakOptions): Promise<ESpeakModule>
}
