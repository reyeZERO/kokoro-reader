#!/usr/bin/env python3
"""E2E smoke test via raw CDP: open app, import EPUB, load model, synthesize & play first sentences."""
import json, subprocess, sys, time, urllib.request, base64, threading
from websocket_min import WS  # tiny local ws client

CHROME = "/home/reye/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
URL = "http://127.0.0.1:4173/?device=wasm&dtype=q8"
EPUB = sys.argv[1] if len(sys.argv) > 1 else "/tmp/alice.epub"

proc = subprocess.Popen([CHROME, "--headless=new", "--remote-debugging-port=9333", "--no-sandbox",
                         "--autoplay-policy=no-user-gesture-required", "--user-data-dir=/tmp/kr-chrome-profile",
                         "--window-size=430,932", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            targets = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json")); break
        except Exception: time.sleep(0.2)
    page = next(t for t in targets if t["type"] == "page")
    ws = WS(page["webSocketDebuggerUrl"])
    logs = []
    def ev(m):
        if m.get("method") == "Runtime.consoleAPICalled":
            args = m["params"]["args"]
            logs.append(" ".join(str(a.get("value", a.get("description", ""))) for a in args)[:300])
        if m.get("method") == "Runtime.exceptionThrown":
            logs.append("EXC " + json.dumps(m["params"]["exceptionDetails"].get("exception", {}).get("description", ""))[:400])
    ws.on_event = ev
    ws.call("Runtime.enable"); ws.call("Page.enable"); ws.call("DOM.enable")
    ws.call("Page.navigate", url=URL)
    time.sleep(3)

    def js(expr, await_=False):
        r = ws.call("Runtime.evaluate", expression=expr, awaitPromise=await_, returnByValue=True)
        if "exceptionDetails" in r: return "EXC: " + json.dumps(r["exceptionDetails"])[:500]
        return r["result"].get("value")

    print("title:", js("document.title"))
    print("body:", js("document.body.innerText.slice(0,200).replace(/\\n+/g,' | ')"))

    # Inject the EPUB into the hidden file input
    data = base64.b64encode(open(EPUB, "rb").read()).decode()
    js(f"""window.__epub = Uint8Array.from(atob("{data}"), c => c.charCodeAt(0)); window.NAME = {json.dumps(EPUB.split("/")[-1])};""")
    r = ws.call("Runtime.evaluate", expression="""(async () => {
      const f = new File([window.__epub], NAME, {type:''});
      const input = document.querySelector('input[type=file]');
      const dt = new DataTransfer(); dt.items.add(f);
      input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles:true}));
      return 'dispatched';
    })()""", awaitPromise=True, returnByValue=True)
    print("import:", r["result"].get("value"))
    for _ in range(60):
        time.sleep(0.5)
        if js("document.querySelectorAll('.grid button').length") > 0: break
    print("library:", js("document.body.innerText.replace(/\\n+/g,' | ').slice(0,300)"))

    # Open the book
    js("document.querySelector('.grid button').click()")
    time.sleep(1.5)
    hdr = js("document.querySelector('header')?.innerText.replace(/\\n+/g,' | ')")
    print("reader header:", hdr)
    nch = js("__engine.debug() && document.querySelectorAll('.fixed button').length")  # noqa
    book_stats = js("(() => { const b = __engine['book']; return b && {chapters: b.chapters.length, sentences: b.sentences.length, cover: !!b.coverBlob, lang: b.language, roles: b.sentences.reduce((a,s)=>(a[s.role]=(a[s.role]||0)+1,a),{})} })()")
    print("book:", json.dumps(book_stats))
    if EPUB.endswith('.epub'):
        assert book_stats and book_stats['chapters'] >= 5, "EPUB chapter extraction failed"
        assert book_stats['cover'], "cover missing"
        assert book_stats['roles'].get('female', 0) + book_stats['roles'].get('male', 0) > 20, "dialogue detection produced too few speaker segments"
    print("paragraphs:", js("document.querySelectorAll('.paragraph').length"), "sentences:", js("document.querySelectorAll('.sentence').length"))
    roles = js("""(() => { const s = [...document.querySelectorAll('.paragraph')].slice(0,60).map(p => p.innerText.slice(0,80)); return s.filter(t => /[“"]/.test(t)).slice(0,3) })()""")
    print("sample dialogue paragraphs:", roles)

    # Wait for the model to load (App warms it), then press play
    print("waiting for model…")
    t0 = time.time()
    while time.time() - t0 < 600:
        st = js("document.body.innerText.includes('Model ready') || !!document.querySelector('.animate-spin') ? 'loading' : 'unknown'")
        prog = [l for l in logs if 'progress' in l.lower()][-1:] 
        time.sleep(3)
        # Ask engine directly via a global we expose in dev? Use the state pill text in library instead: we're in reader. Trigger play:
        js("document.querySelector('.sentence')?.click()")
        time.sleep(2)
        mini = js("document.querySelector('.fixed.bottom-0')?.innerText.replace(/\\n+/g,' | ')")
        if mini and 'ahead' in mini: print("mini-player:", mini); break
        if int(time.time() - t0) % 30 < 4: print(f"  t+{int(time.time()-t0)}s mini={mini!r}")
    # Observe karaoke advancing
    seen = []
    for _ in range(90):
        seen.append([js("document.querySelector('.sentence.active')?.innerText.slice(0,40)"), js("JSON.stringify(__engine.debug())")])
        time.sleep(2)
    print("active sentence over time:", json.dumps(seen, ensure_ascii=False, indent=0))
    print("SAB:", js("typeof SharedArrayBuffer"), "cores:", js("navigator.hardwareConcurrency"))
    print("audio ctx:", js("(() => { const a = document.querySelector('audio'); return a ? `keepalive paused=${a.paused}` : 'no keepalive' })()"))
    print("\n-- console (last 25) --")
    for l in logs[-25:]: print(" ", l)
    print("worker logs need Target.attach; grabbing via performance API instead")
    ws.call("Page.captureScreenshot")
    shot = ws.call("Page.captureScreenshot", format="png")["data"]
    open("/tmp/kr-reader.png", "wb").write(base64.b64decode(shot))
    print("screenshot: /tmp/kr-reader.png")
finally:
    proc.terminate()
