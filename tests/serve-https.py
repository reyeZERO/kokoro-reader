#!/usr/bin/env python3
"""LAN HTTPS server for testing the PWA on an iPhone before deploying.
Service workers + Add-to-Home-Screen require HTTPS (localhost excepted, but the phone isn't localhost).

  python3 tests/serve-https.py            # serves dist/ on https://<lan-ip>:8443

First run generates a self-signed cert (needs openssl). On the iPhone: open the URL, accept the
certificate warning (Show Details → visit website). For the service worker to register on iOS you
must trust the cert: AirDrop/email cert.pem to the phone → Settings → Profile Downloaded → Install,
then Settings → General → About → Certificate Trust Settings → enable.
"""
import http.server, ssl, os, subprocess, socket, sys

root = sys.argv[1] if len(sys.argv) > 1 else 'dist'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8443
certdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.certs')
os.makedirs(certdir, exist_ok=True)
crt, key = os.path.join(certdir, 'cert.pem'), os.path.join(certdir, 'key.pem')

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.connect(('10.255.255.255', 1)); return s.getsockname()[0]
    except Exception: return '127.0.0.1'
    finally: s.close()

ip = lan_ip()
if not os.path.exists(crt):
    subprocess.check_call(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
                           '-keyout', key, '-out', crt, '-subj', f'/CN={ip}',
                           '-addext', f'subjectAltName=IP:{ip},DNS:localhost'], stderr=subprocess.DEVNULL)
    print(f'generated self-signed cert for {ip} → {crt}')

os.chdir(root)
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def log_message(self, fmt, *a): pass
H.extensions_map.update({'.wasm': 'application/wasm', '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json'})

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(crt, key)
srv = http.server.ThreadingHTTPServer(('0.0.0.0', port), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print(f'serving {root} at https://{ip}:{port}  (cert: {crt})')
srv.serve_forever()
