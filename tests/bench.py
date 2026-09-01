#!/usr/bin/env python3
"""Benchmark the TTS worker in headless Chromium: where does the time go?"""
import json, subprocess, sys, time, urllib.request
from websocket_min import WS

CHROME = "/home/reye/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
URL = "http://127.0.0.1:4173/"
flags = sys.argv[1:]
proc = subprocess.Popen([CHROME, "--headless=new", "--remote-debugging-port=9333", "--no-sandbox",
                         "--user-data-dir=/tmp/kr-chrome-profile", *flags, "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: targets = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json")); break
        except Exception: time.sleep(0.2)
    ws = WS(next(t for t in targets if t["type"] == "page")["webSocketDebuggerUrl"])
    logs = []
    ws.on_event = lambda m: logs.append(" ".join(str(a.get("value", "")) for a in m["params"]["args"])) if m.get("method") == "Runtime.consoleAPICalled" else None
    ws.call("Runtime.enable"); ws.call("Page.navigate", url=URL); time.sleep(2)
    js = lambda e: ws.call("Runtime.evaluate", expression=e, returnByValue=True, awaitPromise=True)["result"].get("value")
    print("SAB:", js("typeof SharedArrayBuffer"), "cores:", js("navigator.hardwareConcurrency"), "webgpu:", js("!!navigator.gpu"))
    t0 = time.time()
    import os
    dev = os.environ.get('DEV', 'webgpu'); dt = os.environ.get('DTYPE', 'fp32' if dev == 'webgpu' else 'q8')
    js(f"void __engine.loadModel({{dtype:'{dt}', device:'{dev}'}}); 1")
    while js("__engine.getState()") == 'loading-model' and time.time() - t0 < 900: time.sleep(1)
    print(f"model ready in {time.time()-t0:.0f}s state={js('__engine.getState()')} backend={js('JSON.stringify(__engine.backend)')}")
    js("__engine.bench()")
    for _ in range(300):
        r = js("JSON.stringify(globalThis.__bench || null)")
        if r and r != 'null': print("bench:", r); break
        time.sleep(1)
    for l in logs[-10:]: print(" ", l)
finally:
    proc.terminate()
