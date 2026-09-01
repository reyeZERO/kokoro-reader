#!/usr/bin/env python3
"""Static server for dist/ with COOP/COEP so SharedArrayBuffer (multi-threaded WASM) is available."""
import http.server, sys, os
os.chdir(sys.argv[1] if len(sys.argv) > 1 else 'dist')
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def log_message(self, *a): pass
H.extensions_map.update({'.wasm': 'application/wasm', '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json'})
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2]) if len(sys.argv) > 2 else 4173), H).serve_forever()
