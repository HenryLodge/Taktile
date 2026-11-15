#!/usr/bin/env python3
"""End-to-end test: run taktile-sim, talk to it over WebSocket, press keys on its stdin.

usage: e2e.py <taktile-sim> <tests/vectors dir> <insecure 0|1>

Standard library only. Uses the public test vectors: the "device" seed is
sha256("taktile-vector:device") (never funded), and Alice is the contacts-vector book entry.
"""

import base64
import hashlib
import json
import os
import queue
import re
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib

SIM, VECTORS, INSECURE = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
CLIP_MS = 60

HELLO, GET_PUBKEY, SIGN_REQUEST, CONTACT_LIST_COUNT, CANCEL = 0x01, 0x02, 0x10, 0x31, 0x7E
EVENT, RESP = 0xF0, 0x80
OK, REJECTED, UNKNOWN_RECIPIENT, BUSY, CANCELLED = 0, 1, 2, 6, 7
EV_ANNOUNCING, EV_AWAITING_CONFIRM = 1, 3


def load(name):
    with open(os.path.join(VECTORS, name)) as f:
        return json.load(f)


parser = {v["name"]: v for v in load("parser.json")}
checksum = {v["name"]: v for v in load("checksum.json")["tx"]}
alice = load("contacts.json")["book"][0]
SEED = hashlib.sha256(b"taktile-vector:device").hexdigest()
SOL_OK = bytes.fromhex(parser["sol_ok"]["message_hex"])
DEVICE_PUBKEY = bytes.fromhex(parser["sol_ok"]["device_pubkey"])
SECRET_WORDS = checksum["sol_ok"]["words"]


def frame(t, seq, payload=b""):
    body = bytes([0xE5, 0x01, t, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<I", zlib.crc32(body))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Sim:
    def __init__(self, extra):
        self.dir = tempfile.mkdtemp(prefix="taktile-sim-")
        self.port = free_port()
        args = [SIM, "--port", str(self.port), "--data", self.dir, "--clip-ms", str(CLIP_MS),
                "--seed-hex", SEED] + extra
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, bufsize=0)
        self.lines = queue.Queue()
        self.all = []
        threading.Thread(target=self._read, daemon=True).start()
        self.wait_line(lambda l: l.startswith("keys:"), 10)

    def _read(self):
        for raw in iter(self.p.stdout.readline, b""):
            line = raw.decode(errors="replace").rstrip("\n")
            self.all.append(line)
            self.lines.put(line)

    def wait_line(self, pred, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            try:
                line = self.lines.get(timeout=end - time.time())
            except queue.Empty:
                break
            if pred(line):
                return line
        raise AssertionError("timed out waiting for sim output; got:\n" + "\n".join(self.all[-30:]))

    def key(self, k):
        self.p.stdin.write(k)
        self.p.stdin.flush()

    def stop(self):
        self.p.terminate()
        try:
            self.p.wait(5)
        except subprocess.TimeoutExpired:
            self.p.kill()


class Ws:
    def __init__(self, port, origin="http://localhost:5173"):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n")
        self.s.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.s.recv(1024)
            if not chunk:
                break
            resp += chunk
        head, _, self.buf = resp.partition(b"\r\n\r\n")
        self.status = int(head.split(b" ")[1]) if head else 0
        if self.status == 101:
            want = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            assert want in head, "bad Sec-WebSocket-Accept"
        self.stream = b""

    def send(self, data):
        mask = os.urandom(4)
        n = len(data)
        hdr = bytes([0x82]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _recv_ws(self):
        while True:
            if len(self.buf) >= 2:
                n, h = self.buf[1] & 0x7F, 2
                if n == 126 and len(self.buf) >= 4:
                    n, h = struct.unpack(">H", self.buf[2:4])[0], 4
                if n != 126 and len(self.buf) >= h + n:
                    payload, self.buf = self.buf[h:h + n], self.buf[h + n:]
                    return payload
            chunk = self.s.recv(4096)
            if not chunk:
                raise AssertionError("connection closed")
            self.buf += chunk

    def frame(self):
        while True:
            if len(self.stream) >= 6:
                n = struct.unpack("<H", self.stream[4:6])[0]
                if len(self.stream) >= 10 + n:
                    f, self.stream = self.stream[:10 + n], self.stream[10 + n:]
                    assert zlib.crc32(f[:6 + n]) == struct.unpack("<I", f[6 + n:])[0], "bad CRC from sim"
                    return f[2], f[3], f[6:6 + n]
            self.stream += self._recv_ws()

    def until(self, t, seq):
        """Frames until (and including) the first of this type and seq."""
        seen = []
        while True:
            f = self.frame()
            seen.append(f)
            if f[0] == t and f[1] == seq:
                return f, seen


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def main():
    sim = Sim(["--unlocked", "--contact", "Alice=" + alice["wallet"]])
    try:
        ws = Ws(sim.port)
        check(ws.status == 101, "handshake failed")

        ws.send(frame(HELLO, 1))
        t, seq, p = ws.frame()
        check((t, seq) == (HELLO | RESP, 1) and p == bytes([1, 0, 1, 2]), f"HELLO reply {p.hex()}")

        ws.send(frame(GET_PUBKEY, 2))
        t, seq, p = ws.frame()
        check(p == bytes([OK]) + DEVICE_PUBKEY, "GET_PUBKEY is not the vector device key")

        ws.send(frame(CONTACT_LIST_COUNT, 3))
        t, seq, p = ws.frame()
        check(p == bytes([1]), "contact count")

        # Full sign: a 'c' pressed during the announcement must not count (I6), then mid-flow BUSY,
        # then CONFIRM after the prompt.
        ws.send(frame(SIGN_REQUEST, 4, SOL_OK))
        sim.wait_line(lambda l: l == "[EARPIECE] send")
        sim.key(b"c")  # during the announcement: discarded
        f, seen = ws.until(EVENT, 4)
        while f[2] != bytes([EV_AWAITING_CONFIRM]):
            f, s2 = ws.until(EVENT, 4)
        ws.send(frame(GET_PUBKEY, 5))
        f, _ = ws.until(GET_PUBKEY | RESP, 5)
        check(f[2] == bytes([BUSY]), "mid-flow GET_PUBKEY is not BUSY")
        sim.wait_line(lambda l: "press confirm" in l)
        time.sleep(CLIP_MS * 3 / 1000)
        sim.key(b"c")
        f, _ = ws.until(SIGN_REQUEST | RESP, 4)
        check(f[2][0] == OK and len(f[2]) == 65, f"sign reply {f[2][:1].hex()}")
        check(sim.all.count("[HAPTIC] success (double pulse)") == 1, "success haptic")

        # Early 'c' only: the device must not sign; REJECT after the prompt ends it.
        ws.send(frame(SIGN_REQUEST, 6, SOL_OK))
        sim.wait_line(lambda l: l == "[EARPIECE] send")
        sim.key(b"c")
        sim.wait_line(lambda l: "press confirm" in l)
        time.sleep(CLIP_MS * 3 / 1000)
        sim.key(b"r")
        f, _ = ws.until(SIGN_REQUEST | RESP, 6)
        check(f[2] == bytes([REJECTED]), f"early CONFIRM was counted: {f[2][:1].hex()}")

        # R (long REJECT) cancels.
        ws.send(frame(SIGN_REQUEST, 7, SOL_OK))
        sim.wait_line(lambda l: "press confirm" in l)
        time.sleep(CLIP_MS * 3 / 1000)
        sim.key(b"R")
        f, _ = ws.until(SIGN_REQUEST | RESP, 7)
        check(f[2] == bytes([CANCELLED]), "R did not cancel")

        # Host CANCEL during the confirm window.
        ws.send(frame(SIGN_REQUEST, 8, SOL_OK))
        sim.wait_line(lambda l: "press confirm" in l)
        ws.send(frame(CANCEL, 9))
        f, _ = ws.until(CANCEL | RESP, 9)
        check(f[2] == bytes([OK]), "CANCEL reply")
        f, _ = ws.until(SIGN_REQUEST | RESP, 8)
        check(f[2] == bytes([CANCELLED]), "SIGN_REQUEST after CANCEL")

        # A web page from elsewhere cannot connect.
        bad = Ws(sim.port, origin="https://evil.example")
        check(bad.status == 403, f"bad Origin got {bad.status}")

        # I2: without the insecure build, no secret audio is printed.
        private = [l for l in sim.all if l.startswith("[EARPIECE] (private)")]
        check(len(private) >= 12, "checksum words were not played as private")
        if not INSECURE:
            check(all(l == "[EARPIECE] (private)" for l in private), "secret clip text printed")
            for w in SECRET_WORDS:
                check(not any(re.search(r"\b%s\b" % re.escape(w), l) for l in sim.all), f"checksum word {w} printed")
    finally:
        sim.stop()

    # Unknown recipient: same message, empty contact book.
    sim = Sim(["--unlocked"])
    try:
        ws = Ws(sim.port)
        ws.send(frame(SIGN_REQUEST, 1, SOL_OK))
        f, seen = ws.until(SIGN_REQUEST | RESP, 1)
        check(f[2] == bytes([UNKNOWN_RECIPIENT]), "unknown recipient")
        check(len(seen) == 1, "events sent for an unknown recipient")
        sim.wait_line(lambda l: "unknown recipient" in l)
    finally:
        sim.stop()
    print("e2e: all checks passed")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("e2e FAILED:", e)
        sys.exit(1)
