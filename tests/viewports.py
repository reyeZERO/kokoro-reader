#!/usr/bin/env python3
"""Screenshot the app at iPhone SE 1st gen → 17 Pro Max viewports via CDP device metrics."""
import json, subprocess, sys, time, urllib.request, base64
from websocket_min import WS

CHROME = "/home/reye/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
VIEWPORTS = [
    ("se1",    320, 568, 2),   # iPhone SE 1st gen
    ("mini",   375, 812, 3),   # 12/13 mini
    ("std",    390, 844, 3),   # 14/15/16
    ("promax", 440, 956, 3),   # 17 Pro Max
    ("land",   956, 440, 3),   # Pro Max landscape
]
URL = "http://127.0.0.1:4173/"

def launch():
    p = subprocess.Popen([CHROME, "--headless=new", "--remote-debugging-port=9337", "--no-sandbox",
                          "--disable-dev-shm-usage", "--user-data-dir=/tmp/kr-shot-profile", "about:blank"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: return p, json.load(urllib.request.urlopen("http://127.0.0.1:9337/json"))[0]["webSocketDebuggerUrl"]
        except Exception: time.sleep(0.2)
    sys.exit("chrome didn't start")

p, url = launch()
try:
    ws = WS(url)
    ws.call("Page.enable"); ws.call("Runtime.enable")
    for name, w, h, dpr in VIEWPORTS:
        ws.call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=dpr, mobile=True)
        ws.call("Emulation.setTouchEmulationEnabled", enabled=True)
        ws.call("Page.navigate", url=URL); time.sleep(3.5)
        shot = ws.call("Page.captureScreenshot", format="png")["data"]
        open(f"/tmp/kr-shot-{name}.png", "wb").write(base64.b64decode(shot))
        # overflow check: horizontal scroll = layout bug
        ow = ws.call("Runtime.evaluate", expression="document.documentElement.scrollWidth - document.documentElement.clientWidth", returnByValue=True)["result"]["value"]
        print(f"{name}: {w}x{h}@{dpr} overflowX={ow}")
finally:
    p.terminate()
