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

HELLO, GET_PUBKEY, SETUP, SIGN_REQUEST, CONTACT_LIST_COUNT, CANCEL = 0x01, 0x02, 0x03, 0x10, 0x31, 0x7E
CONTACT_ADD = 0x30
UNLOCK = 0x04
EVENT, RESP, ERROR = 0xF0, 0x80, 0xFF
BAD_PAYLOAD = 3
CONTACT_EXISTS = 0x0A
OK, REJECTED, UNKNOWN_RECIPIENT, BUSY, CANCELLED, WALLET_EXISTS = 0, 1, 2, 6, 7, 8
LOCKED_OUT = 4
EV_ANNOUNCING, EV_AWAITING_PIN, EV_AWAITING_CONFIRM = 1, 2, 3
NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
KEY_UP, KEY_OK = b"\x1b[A", b"\n"


def load(name):
    with open(os.path.join(VECTORS, name)) as f:
        return json.load(f)


parser = {v["name"]: v for v in load("parser.json")}
checksum = {v["name"]: v for v in load("checksum.json")["tx"]}
alice = load("contacts.json")["book"][0]
bob = load("contacts.json")["book"][1]
ADDR_WORDS = {v["name"]: v["words"] for v in load("checksum.json")["addr"]}
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
    def __init__(self, extra, seed=True, data=None):
        self.dir = data or tempfile.mkdtemp(prefix="taktile-sim-")
        self.port = free_port()
        args = [SIM, "--port", str(self.port), "--data", self.dir, "--clip-ms", str(CLIP_MS)]
        args += (["--seed-hex", SEED] if seed else []) + extra
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

    def settle(self, quiet=0.15, timeout=15):
        """Wait until nothing has been printed for `quiet` seconds (no clip is playing)."""
        end, n, last = time.time() + timeout, len(self.all), time.time()
        while time.time() < end:
            time.sleep(0.02)
            if len(self.all) != n:
                n, last = len(self.all), time.time()
            elif time.time() - last >= quiet:
                return
        raise AssertionError("sim never went quiet; last lines:\n" + "\n".join(self.all[-10:]))

    def press(self, k):
        """A key pressed after the current clips end (presses during a clip are discarded, I6)."""
        self.settle()
        self.key(k)
        self.settle()

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
    contact_add_tests()
    setup_tests()
    print("e2e: all checks passed")


def add_payload(name, wallet_hex):
    wallet = bytes.fromhex(wallet_hex)
    check(len(wallet) == 32, "vector wallet is not 32 bytes")
    return bytes([len(name)]) + name.encode() + wallet


def addr_phrase(wallet_hex):
    """The 8-word address phrase (AUDIO.md), computed here independently of the device."""
    with open(os.path.join(VECTORS, "..", "..", "tools", "data", "pgp-even-words.txt")) as f:
        words = [l.strip() for l in f if l.strip() and not l.startswith("#")]
    check(len(words) == 256, "word list")
    h = hashlib.sha256(b"TK-ADDR-v1" + bytes.fromhex(wallet_hex)).digest()
    return [words[b] for b in h[:8]]


def announced(sim, start):
    """The public earpiece lines printed since index start."""
    return [l[len("[EARPIECE] "):] for l in sim.all[start:]
            if l.startswith("[EARPIECE] ") and not l.startswith("[EARPIECE] (private)")]


def contact_add_tests():
    """CONTACT_ADD on the dev wallet (already unlocked, so no PIN): announce, confirm, store."""
    phrase = addr_phrase(alice["wallet"])
    check(phrase == ADDR_WORDS["alice"], "address phrase disagrees with the shared vectors")
    sim = Sim(["--unlocked"])
    data = sim.dir
    try:
        ws = Ws(sim.port)
        n = len(sim.all)
        ws.send(frame(CONTACT_ADD, 1, add_payload("Alice", alice["wallet"])))
        f = ws.frame()
        check(f == (EVENT, 1, bytes([EV_ANNOUNCING])), f"CONTACT_ADD did not start: {f}")
        sim.wait_line(lambda l: "press confirm to add" in l)
        want = ["adding contact", "A", "L", "I", "C", "E", "address phrase"] + phrase
        check(announced(sim, n)[:len(want)] == want, f"announcement: {announced(sim, n)}")
        sim.press(b"c")
        f, _ = ws.until(CONTACT_ADD | RESP, 1)
        check(f[2] == bytes([OK]), f"CONTACT_ADD reply {f[2].hex()}")
        check("[EARPIECE] contact added" in sim.all, "no 'contact added'")
        ws.send(frame(CONTACT_LIST_COUNT, 2))
        f, _ = ws.until(CONTACT_LIST_COUNT | RESP, 2)
        check(f[2] == bytes([1]), "count after CONTACT_ADD")

        # The same wallet again (another name): refused at once, "already a contact".
        ws.send(frame(CONTACT_ADD, 3, add_payload("Al", alice["wallet"])))
        f, seen = ws.until(CONTACT_ADD | RESP, 3)
        check(f[2] == bytes([CONTACT_EXISTS]) and len(seen) == 1, f"duplicate wallet: {f[2].hex()}")
        sim.wait_line(lambda l: l == "[EARPIECE] already a contact")

        # REJECT: nothing stored.
        ws.send(frame(CONTACT_ADD, 4, add_payload("Bob", bob["wallet"])))
        sim.wait_line(lambda l: "press confirm to add" in l)
        sim.press(b"r")
        f, _ = ws.until(CONTACT_ADD | RESP, 4)
        check(f[2] == bytes([REJECTED]), f"rejected CONTACT_ADD: {f[2].hex()}")

        # A name that breaks the rules: ERROR BAD_PAYLOAD, nothing played.
        n = len(sim.all)
        ws.send(frame(CONTACT_ADD, 5, add_payload(" Bob", bob["wallet"])))
        f = ws.frame()
        check(f == (ERROR, 5, bytes([BAD_PAYLOAD])), f"bad name: {f}")
        time.sleep(0.2)
        check(not any(l.startswith("[EARPIECE]") for l in sim.all[n:]), "bad name played audio")
        ws.send(frame(CONTACT_LIST_COUNT, 6))
        f, _ = ws.until(CONTACT_LIST_COUNT | RESP, 6)
        check(f[2] == bytes([1]), "count after the refusals")
    finally:
        sim.stop()

    # Restart on the same data: the contact is saved, and a SOL transfer to it is announced by name.
    sim = Sim(["--unlocked"], data=data)
    try:
        ws = Ws(sim.port)
        ws.send(frame(CONTACT_LIST_COUNT, 1))
        f, _ = ws.until(CONTACT_LIST_COUNT | RESP, 1)
        check(f[2] == bytes([1]), "contact not saved across restart")
        n = len(sim.all)
        ws.send(frame(SIGN_REQUEST, 2, SOL_OK))
        sim.wait_line(lambda l: "press confirm to sign" in l)
        a = announced(sim, n)
        check("to" in a and a[a.index("to") + 1:a.index("to") + 6] == list("ALICE"), f"sign announcement: {a}")
        sim.press(b"c")
        f, _ = ws.until(SIGN_REQUEST | RESP, 2)
        check(f[2][0] == OK and len(f[2]) == 65, f"sign to the added contact: {f[2][:1].hex()}")
    finally:
        sim.stop()


def enter_pin(sim, pin):
    """Rotary PIN entry. Needs the insecure build: the start digit is private audio."""
    for d in pin:
        sim.settle()
        value = next(NUMBERS.index(l.split()[-1]) for l in reversed(sim.all)
                     if l.startswith("[EARPIECE] (private) ") and l.split()[-1] in NUMBERS)
        for _ in range((d - value) % 10):
            sim.press(KEY_UP)
        sim.press(KEY_OK)


def setup_tests():
    """SETUP on the sim's key store (no --seed-hex)."""
    # Started, then cancelled from the host: no wallet afterwards. Works in every build.
    sim = Sim([], seed=False)
    try:
        ws = Ws(sim.port)
        ws.send(frame(SETUP, 1))
        f = ws.frame()
        check(f == (EVENT, 1, bytes([EV_AWAITING_PIN])), f"SETUP did not start: {f}")
        sim.wait_line(lambda l: l == "[EARPIECE] choose a new PIN")
        ws.send(frame(HELLO, 2))
        f, _ = ws.until(HELLO | RESP, 2)
        check(f[2] == bytes([1, 0, 1, 0]), "HELLO during SETUP is not state 0")
        ws.send(frame(CANCEL, 3))
        f, _ = ws.until(CANCEL | RESP, 3)
        check(f[2] == bytes([OK]), "CANCEL reply")
        f, _ = ws.until(SETUP | RESP, 1)
        check(f[2] == bytes([CANCELLED]), f"SETUP after CANCEL: {f[2].hex()}")
        check(not os.path.exists(os.path.join(sim.dir, "wallet")), "a cancelled SETUP stored a wallet")
        if not INSECURE:
            private = [l for l in sim.all if l.startswith("[EARPIECE] (private)")]
            check(all(l == "[EARPIECE] (private)" for l in private), "PIN digit printed")
    finally:
        sim.stop()

    if not INSECURE:
        print("e2e: full SETUP skipped (needs -DTK_SIM_INSECURE_AUDIO=ON to read the private start digits)")
        return

    # The whole flow by keystrokes: PIN, PIN again, 24 words, finish.
    sim = Sim([], seed=False)
    data = sim.dir
    try:
        ws = Ws(sim.port)
        ws.send(frame(SETUP, 1))
        sim.wait_line(lambda l: l == "[EARPIECE] choose a new PIN")
        enter_pin(sim, [1, 2, 3, 4, 5, 6])
        sim.wait_line(lambda l: l == "[EARPIECE] enter your PIN again")
        enter_pin(sim, [1, 2, 3, 4, 5, 6])
        sim.wait_line(lambda l: l == "[EARPIECE] write down your recovery words")
        for _ in range(24):
            sim.press(KEY_OK)
        sim.wait_line(lambda l: "press OK to finish" in l)
        sim.press(KEY_OK)
        f, _ = ws.until(SETUP | RESP, 1)
        check(f[2] == bytes([OK]), f"SETUP reply {f[2].hex()}")
        check(sim.all.count("[EARPIECE] recovery word") == 24, "not 24 recovery words")
        letters = [l for l in sim.all if l.startswith("[EARPIECE] (private) ") and len(l.split()[-1]) == 1]
        check(72 <= len(letters) <= 192, f"{len(letters)} recovery letters, want 3-8 per word (whole words)")
        check("[EARPIECE] wallet created" in sim.all, "no 'wallet created'")
        check(os.path.exists(os.path.join(data, "wallet")), "no wallet stored")
        ws.send(frame(HELLO, 2))
        f, _ = ws.until(HELLO | RESP, 2)
        check(f[2] == bytes([1, 0, 1, 2]), "HELLO after SETUP is not state 2 (unlocked)")
        ws.send(frame(GET_PUBKEY, 3))
        f, _ = ws.until(GET_PUBKEY | RESP, 3)
        check(f[2][0] == OK and len(f[2]) == 33, "GET_PUBKEY after SETUP")
        pubkey = f[2][1:]
    finally:
        sim.stop()

    # Restart on the same data: the wallet is there, locked; SETUP is refused (I10).
    sim = Sim([], seed=False, data=data)
    try:
        check(any(l.startswith("wallet: ") and "key store, locked" in l for l in sim.all), "banner after restart")
        ws = Ws(sim.port)
        ws.send(frame(HELLO, 1))
        f, _ = ws.until(HELLO | RESP, 1)
        check(f[2] == bytes([1, 0, 1, 1]), "HELLO after restart is not state 1 (locked)")
        ws.send(frame(GET_PUBKEY, 2))
        f, _ = ws.until(GET_PUBKEY | RESP, 2)
        check(f[2] == bytes([OK]) + pubkey, "pubkey changed across restart")
        n = len(sim.all)
        ws.send(frame(SETUP, 3))
        f, _ = ws.until(SETUP | RESP, 3)
        check(f[2] == bytes([WALLET_EXISTS]), "second SETUP was not refused")
        time.sleep(0.2)
        check(not any(l.startswith("[EARPIECE]") for l in sim.all[n:]), "refused SETUP played audio")
    finally:
        sim.stop()

    unlock_tests(data, pubkey)


def sol_from(pubkey):
    """sol_ok, but sent from this wallet: account key 0 (fee payer and sender) is at offset 4."""
    msg = bytearray(SOL_OK)
    check(msg[3] == 3, "sol_ok layout changed")
    msg[4:36] = pubkey
    return bytes(msg)


def unlock_tests(data, pubkey):
    """PIN unlock on the key store (I7): counted attempts, one signature per unlock, lockout wipe."""
    sim = Sim(["--contact", "Alice=" + alice["wallet"]], seed=False, data=data)
    try:
        ws = Ws(sim.port)
        msg = sol_from(pubkey)

        # One wrong PIN, then the right one: "wrong pin, nine, attempts remaining", then it signs.
        ws.send(frame(SIGN_REQUEST, 1, msg))
        sim.wait_line(lambda l: l == "[EARPIECE] enter pin")
        enter_pin(sim, [0, 0, 0, 0, 0, 0])
        sim.wait_line(lambda l: l == "[EARPIECE] wrong pin")
        sim.wait_line(lambda l: l == "[EARPIECE] nine")
        sim.wait_line(lambda l: l == "[EARPIECE] enter pin")
        enter_pin(sim, [1, 2, 3, 4, 5, 6])
        sim.wait_line(lambda l: "press confirm" in l)
        sim.press(b"c")
        f, _ = ws.until(SIGN_REQUEST | RESP, 1)
        check(f[2][0] == OK and len(f[2]) == 65, f"key-store sign reply {f[2][:1].hex()}")
        check(sim.all.count("[EARPIECE] please wait") >= 2, "no 'please wait' before the PIN checks")

        # One unlock, one signature: locked again.
        ws.send(frame(HELLO, 2))
        f, _ = ws.until(HELLO | RESP, 2)
        check(f[2] == bytes([1, 0, 1, 1]), "not locked after the signature")

        # CONTACT_ADD on the locked key store: the PIN after the announcement, then CONFIRM. Adding
        # a contact is not a signature, so the session stays unlocked.
        ws.send(frame(CONTACT_ADD, 20, add_payload("Bob", bob["wallet"])))
        sim.wait_line(lambda l: l == "[EARPIECE] enter pin")
        enter_pin(sim, [1, 2, 3, 4, 5, 6])
        sim.wait_line(lambda l: "press confirm to add" in l)
        sim.press(b"c")
        f, _ = ws.until(CONTACT_ADD | RESP, 20)
        check(f[2] == bytes([OK]), f"key-store CONTACT_ADD {f[2].hex()}")
        ws.send(frame(HELLO, 21))
        f, _ = ws.until(HELLO | RESP, 21)
        check(f[2] == bytes([1, 0, 1, 2]), "CONTACT_ADD ended the unlocked session")

        # Disconnecting locks it again (the USB host went away).
        ws.s.close()
        time.sleep(0.3)
        ws = Ws(sim.port)
        ws.send(frame(HELLO, 22))
        f, _ = ws.until(HELLO | RESP, 22)
        check(f[2] == bytes([1, 0, 1, 1]), "not locked after the app disconnected")

        # UNLOCK first (the PIN, "wallet unlocked"), then SIGN_REQUEST: no PIN, still CONFIRM (I5).
        ws.send(frame(UNLOCK, 23))
        sim.wait_line(lambda l: l == "[EARPIECE] enter pin")
        enter_pin(sim, [1, 2, 3, 4, 5, 6])
        f, _ = ws.until(UNLOCK | RESP, 23)
        check(f[2] == bytes([OK]), f"UNLOCK {f[2].hex()}")
        check("wallet unlocked" in sim.all, "no 'wallet unlocked'")
        ws.send(frame(UNLOCK, 24))
        f, _ = ws.until(UNLOCK | RESP, 24)
        check(f[2] == bytes([OK]), "UNLOCK while unlocked is not OK at once")
        pins_before = sim.all.count("[EARPIECE] enter pin")
        ws.send(frame(SIGN_REQUEST, 25, msg))
        sim.wait_line(lambda l: "press confirm" in l)
        sim.press(b"c")
        f, _ = ws.until(SIGN_REQUEST | RESP, 25)
        check(f[2][0] == OK and len(f[2]) == 65, f"sign after UNLOCK {f[2][:1].hex()}")
        check(sim.all.count("[EARPIECE] enter pin") == pins_before, "PIN asked again after UNLOCK")
        ws.send(frame(HELLO, 26))
        f, _ = ws.until(HELLO | RESP, 26)
        check(f[2] == bytes([1, 0, 1, 1]), "not locked after the signature that followed UNLOCK")

        # Ten wrong PINs in a row: wallet and contacts wiped, LOCKED_OUT.
        ws.send(frame(SIGN_REQUEST, 3, msg))
        for i in range(10):
            sim.wait_line(lambda l: l == "[EARPIECE] enter pin", 30)
            enter_pin(sim, [0, 0, 0, 0, 0, 0])
        f, _ = ws.until(SIGN_REQUEST | RESP, 3)
        check(f[2] == bytes([LOCKED_OUT]), f"10 wrong PINs: {f[2].hex()}")
        check("[EARPIECE] wallet wiped" in sim.all, "no 'wallet wiped'")
        ws.send(frame(HELLO, 4))
        f, _ = ws.until(HELLO | RESP, 4)
        check(f[2] == bytes([1, 0, 1, 0]), "a wallet is still there after the lockout")
        ws.send(frame(CONTACT_LIST_COUNT, 5))
        f, _ = ws.until(CONTACT_LIST_COUNT | RESP, 5)
        check(f[2] == bytes([0]), "contacts survived the lockout")
        with open(os.path.join(data, "wallet"), "rb") as fh:
            check(fh.read() == b"", "wallet file not cleared")

        # And a new SETUP is accepted (I10's documented exception); cancel it.
        ws.send(frame(SETUP, 6))
        f = ws.frame()
        check(f == (EVENT, 6, bytes([EV_AWAITING_PIN])), f"SETUP after the wipe: {f}")
        ws.send(frame(CANCEL, 7))
        f, _ = ws.until(SETUP | RESP, 6)
        check(f[2] == bytes([CANCELLED]), "SETUP after the wipe did not cancel")
    finally:
        sim.stop()


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("e2e FAILED:", e)
        sys.exit(1)
