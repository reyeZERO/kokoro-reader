"""Minimal RFC6455 WebSocket client for CDP (stdlib only)."""
import socket, os, base64, struct, json, threading
from urllib.parse import urlparse

class WS:
    def __init__(self, url):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=None)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf: buf += self.sock.recv(4096)
        self.id = 0
        self.pending = {}
        self.on_event = None
        self.lock = threading.Lock()
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        threading.Thread(target=self._reader, daemon=True).start()

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk: raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _read_frame(self):
        h = self._recv_exact(2)
        fin = h[0] & 0x80; op = h[0] & 0x0F; ln = h[1] & 0x7F
        if ln == 126: ln = struct.unpack(">H", self._recv_exact(2))[0]
        elif ln == 127: ln = struct.unpack(">Q", self._recv_exact(8))[0]
        data = self._recv_exact(ln)
        return fin, op, data

    def _reader(self):
        msg = b""
        while True:
            try: fin, op, data = self._read_frame()
            except Exception: return
            if op == 8: return
            if op == 9: self._send(data, 0xA); continue
            msg += data
            if not fin: continue
            try: m = json.loads(msg)
            except Exception: msg = b""; continue
            msg = b""
            if "id" in m:
                ev = self.pending.get(m["id"])
                if ev: ev[1] = m; ev[0].set()
            elif self.on_event: self.on_event(m)

    def _send(self, data, op=1):
        hdr = bytes([0x80 | op])
        n = len(data)
        if n < 126: hdr += bytes([0x80 | n])
        elif n < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else: hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        with self.lock: self.sock.sendall(hdr + mask + masked)

    def call(self, method, timeout=120, **params):
        self.id += 1
        ev = [threading.Event(), None]
        self.pending[self.id] = ev
        self._send(json.dumps({"id": self.id, "method": method, "params": params}).encode())
        if not ev[0].wait(timeout): raise TimeoutError(method)
        del self.pending[self.id]
        m = ev[1]
        if "error" in m: raise RuntimeError(m["error"])
        return m.get("result", {})
