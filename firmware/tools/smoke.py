#!/usr/bin/env python3
"""Protocol smoke test against the real device over USB (docs/SERIAL_PROTOCOL.md).

usage: python firmware/tools/smoke.py COMx [--setup | --wallet | --contact NAME[=ADDRESS]]
       (Linux: /dev/ttyACM0, macOS: /dev/cu.usbmodem*)

Run it with ESP-IDF's Python (it ships pyserial) against the protocol build, not the bring-up build.
Exits 0 if all pass.

  (no option)  A device with NO wallet: every flow answers NO_WALLET, framing errors, and a SETUP that
               starts (you hear "choose a new PIN") and is then cancelled from here: BUSY and HELLO
               during the flow, CANCEL -> OK, SETUP -> CANCELLED. Needs no button presses.
  --setup      Sends SETUP and waits up to 15 minutes while you do it on the device, then prints
               the result and the new address.
  --wallet     A device WITH a wallet: HELLO state, GET_PUBKEY (prints the address), CONTACT_LIST_COUNT,
               and SETUP refused at once with WALLET_EXISTS (I10).
  --contact    Sends CONTACT_ADD and waits up to 5 minutes while you listen and confirm on the device.
               NAME alone uses that name's public test-vector wallet (Alice, Bob or Carol in
               tests/vectors/contacts.json); NAME=ADDRESS takes base58 or 64 hex. Prints the 8-word
               address phrase you should hear (public: computed from the public address), then the
               reply and the contact count.

The port is opened with DTR and RTS low; the default run's last check confirms that reopening it
never resets the chip (the ROM would print "ESP-ROM" text if it did).
"""

import hashlib
import json
import os
import struct
import sys
import time
import zlib

import serial

HELLO, GET_PUBKEY, SETUP, SIGN_REQUEST, CONTACT_LIST_COUNT, CANCEL = 0x01, 0x02, 0x03, 0x10, 0x31, 0x7E
CONTACT_ADD = 0x30
EVENT, ERROR = 0xF0, 0xFF
OK, NO_WALLET, BUSY, CANCELLED, WALLET_EXISTS = 0x00, 0x05, 0x06, 0x07, 0x08
BAD_FRAME, UNKNOWN_TYPE, BAD_PAYLOAD = 0x01, 0x02, 0x03
AWAITING_PIN = 0x02
STATUS = {0x00: "OK", 0x01: "REJECTED_BY_USER", 0x02: "UNKNOWN_RECIPIENT", 0x03: "PARSE_UNSUPPORTED",
          0x04: "LOCKED_OUT", 0x05: "NO_WALLET", 0x06: "BUSY", 0x07: "CANCELLED", 0x08: "WALLET_EXISTS",
          0x09: "CONTACTS_FULL", 0x0A: "CONTACT_EXISTS", 0x0B: "NOT_FOUND", 0x0C: "DEVICE_ERROR"}
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests", "vectors")
WORDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools", "data", "pgp-even-words.txt")
failures = 0


def frame(t, seq, payload=b"", corrupt_crc=False):
    body = bytes([0xE5, 0x01, t, seq]) + struct.pack("<H", len(payload)) + payload
    crc = zlib.crc32(body) ^ (0xFFFFFFFF if corrupt_crc else 0)
    return body + struct.pack("<I", crc)


def open_port(name):
    s = serial.Serial()
    s.port = name
    s.baudrate = 115200  # ignored on native USB
    s.timeout = 0.05
    s.dtr = False  # set before open: never toggle the chip's reset/boot lines
    s.rts = False
    s.open()
    return s


class Reader:
    def __init__(self, port):
        self.port = port
        self.buf = b""
        self.junk = b""  # bytes seen outside frames (e.g. ROM boot text)

    def next_frame(self, timeout=2.0):
        end = time.monotonic() + timeout
        while True:
            start = self.buf.find(b"\xE5")
            if start < 0:
                self.junk += self.buf
                self.buf = b""
            else:
                self.junk += self.buf[:start]
                self.buf = self.buf[start:]
                if len(self.buf) >= 6:
                    n = struct.unpack_from("<H", self.buf, 4)[0]
                    if len(self.buf) >= 10 + n:
                        f, self.buf = self.buf[: 10 + n], self.buf[10 + n :]
                        if struct.unpack_from("<I", f, 6 + n)[0] != zlib.crc32(f[: 6 + n]):
                            raise AssertionError(f"device sent a frame with a bad CRC: {f.hex()}")
                        return f[2], f[3], f[6 : 6 + n]
            if time.monotonic() > end:
                return None
            self.buf += self.port.read(4096)

    def response(self, timeout=2.0):
        while True:  # EVENT frames are allowed before the reply; skip them
            f = self.next_frame(timeout)
            if f is None or f[0] != EVENT:
                return f


def check(name, cond, detail=""):
    global failures
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + detail}")
    if not cond:
        failures += 1


def b58(data):
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = B58[rem] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def expect(r, name, seq, want_type, want_payload, timeout=2.0):
    got = r.response(timeout)
    ok = got == (want_type, seq, want_payload)
    check(name, ok, f"expected {(hex(want_type), seq, want_payload.hex())}, got "
          f"{None if got is None else (hex(got[0]), got[1], got[2].hex())}")


def setup_cancelled(r, port):
    """SETUP starts the on-device flow; the host cancels it before anything is stored."""
    print("SETUP: you should hear 'choose a new PIN, pin digit number one, starting at ...' in the earbuds,\n"
          "then 'cancelled'.")
    port.write(frame(SETUP, 20))
    f = r.next_frame(3.0)
    if f == (SETUP | 0x80, 20, bytes([0x0C])):
        check("SETUP started", False, "DEVICE_ERROR: no working audio. Flash the clip pack (tools/out/clips.bin, "
              "firmware/README.md); a pack built for another clip list is refused")
        return
    check("SETUP -> EVENT AWAITING_PIN (flow started)", f == (EVENT, 20, bytes([AWAITING_PIN])),
          f"got {None if f is None else (hex(f[0]), f[1], f[2].hex())}")
    time.sleep(1.5)
    # A reply during the flow can wait for the clip that is playing (at most ~2.4 s).
    port.write(frame(HELLO, 21))
    expect(r, "HELLO during SETUP -> state 0 (no wallet yet)", 21, HELLO | 0x80,
           struct.pack("<HBB", 1, 1, 0), 4.0)
    port.write(frame(GET_PUBKEY, 22))
    expect(r, "GET_PUBKEY during SETUP -> BUSY", 22, GET_PUBKEY | 0x80, bytes([BUSY]), 4.0)
    port.write(frame(CANCEL, 23))
    expect(r, "CANCEL during SETUP -> OK", 23, CANCEL | 0x80, bytes([OK]), 4.0)
    expect(r, "SETUP -> CANCELLED (nothing stored)", 20, SETUP | 0x80, bytes([CANCELLED]), 6.0)
    port.write(frame(HELLO, 24))
    expect(r, "HELLO after the cancel -> still state 0", 24, HELLO | 0x80, struct.pack("<HBB", 1, 1, 0))


def hello_state(r, port, seq):
    port.write(frame(HELLO, seq))
    f = r.response()
    if f is None or f[0] != HELLO | 0x80 or len(f[2]) != 4:
        return None
    return f[2][3]


def run_setup(port):
    r = Reader(port)
    state = hello_state(r, port, 1)
    if state != 0:
        print(f"HELLO state is {state}, not 0 (no wallet): SETUP would be refused. Use --wallet.")
        return 1
    print("Sent SETUP. On the device: choose a PIN, enter it again, then write down all 24 words\n"
          "(OK = next, hold OK = repeat, BACK = previous). Waiting up to 15 minutes...")
    port.write(frame(SETUP, 2))
    f = r.response(15 * 60)
    if f is None or f[0] != SETUP | 0x80 or len(f[2]) != 1:
        print(f"no SETUP reply: {f}")
        return 1
    print(f"SETUP -> {STATUS.get(f[2][0], hex(f[2][0]))}")
    if f[2][0] != OK:
        return 1
    port.write(frame(GET_PUBKEY, 3))
    g = r.response()
    if g is not None and g[0] == GET_PUBKEY | 0x80 and len(g[2]) == 33 and g[2][0] == OK:
        print(f"address: {b58(g[2][1:])}")
    print(f"HELLO state {hello_state(r, port, 4)} (2 = unlocked)")
    return 0


def b58decode(text):
    n = 0
    for c in text:
        if c not in B58:
            raise ValueError(f"not base58: {c!r}")
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(text) - len(text.lstrip("1"))) + raw


def contact_wallet(spec):
    """NAME or NAME=ADDRESS -> (name, 32-byte wallet)."""
    name, _, addr = spec.partition("=")
    if not addr:
        with open(os.path.join(VECTORS, "contacts.json")) as f:
            book = {e["name"].lower(): e for e in json.load(f)["book"]}
        if name.lower() not in book:
            raise ValueError(f"no test-vector wallet named {name!r}; give NAME=ADDRESS")
        return name, bytes.fromhex(book[name.lower()]["wallet"])
    wallet = bytes.fromhex(addr) if len(addr) == 64 and all(c in "0123456789abcdefABCDEF" for c in addr) \
        else b58decode(addr)
    if len(wallet) != 32:
        raise ValueError("the address is not 32 bytes")
    return name, wallet


def address_phrase(wallet):
    """AUDIO.md: SHA256("TK-ADDR-v1" || wallet), bytes 0..7 pick the PGP even words."""
    with open(WORDS) as f:
        words = [l.strip() for l in f if l.strip() and not l.startswith("#")]
    h = hashlib.sha256(b"TK-ADDR-v1" + wallet).digest()
    return [words[b] for b in h[:8]]


def run_contact(port, spec):
    try:
        name, wallet = contact_wallet(spec)
    except ValueError as e:
        print(e)
        return 2
    r = Reader(port)
    state = hello_state(r, port, 1)
    print(f"HELLO state {state} ({'locked: you will be asked for the PIN' if state == 1 else 'unlocked' if state == 2 else 'no wallet'})")
    print(f"Adding {name!r}, address {b58(wallet)}.\n"
          f"You should hear: \"adding contact, {', '.join(name.upper())}, address phrase,\n"
          f"  {' '.join(address_phrase(wallet))}\"\n"
          "then \"enter pin\" if locked, then \"press confirm to add or reject to cancel\"\n"
          "(hold OK repeats). Waiting up to 5 minutes...")
    port.write(frame(CONTACT_ADD, 2, bytes([len(name)]) + name.encode("ascii", "replace") + wallet))
    deadline = time.time() + 5 * 60
    while time.time() < deadline:
        f = r.next_frame(deadline - time.time())
        if f is None:
            break
        if f[0] == EVENT:
            continue
        if f[0] == ERROR and f[1] == 2:
            print(f"CONTACT_ADD -> ERROR {f[2].hex()} (BAD_PAYLOAD: the name breaks the rules)")
            return 1
        if f[0] == CONTACT_ADD | 0x80 and f[1] == 2 and len(f[2]) == 1:
            print(f"CONTACT_ADD -> {STATUS.get(f[2][0], hex(f[2][0]))}")
            port.write(frame(CONTACT_LIST_COUNT, 3))
            g = r.response()
            print(f"CONTACT_LIST_COUNT -> {g[2][0] if g is not None and len(g[2]) == 1 else g}")
            return 0 if f[2][0] == OK else 1
    print("no CONTACT_ADD reply")
    return 1


def run_wallet(port):
    r = Reader(port)
    state = hello_state(r, port, 1)
    check("HELLO -> state 1 or 2 (a wallet exists)", state in (1, 2), f"got {state}")
    print(f"      state {state} ({'locked' if state == 1 else 'unlocked' if state == 2 else '?'})")
    port.write(frame(GET_PUBKEY, 2))
    g = r.response()
    ok = g is not None and g[0] == GET_PUBKEY | 0x80 and len(g[2]) == 33 and g[2][0] == OK
    check("GET_PUBKEY -> OK", ok, f"got {g}")
    if ok:
        print(f"      address: {b58(g[2][1:])}")
    port.write(frame(CONTACT_LIST_COUNT, 5))
    c = r.response()
    check("CONTACT_LIST_COUNT -> answered", c is not None and c[0] == CONTACT_LIST_COUNT | 0x80 and len(c[2]) == 1)
    if c is not None and len(c[2]) == 1:
        print(f"      contacts: {c[2][0]}")
    port.write(frame(SETUP, 3))
    expect(r, "SETUP -> WALLET_EXISTS at once, no audio (I10)", 3, SETUP | 0x80, bytes([WALLET_EXISTS]), 1.0)
    port.write(frame(HELLO, 4))
    f = r.response()
    check("HELLO after the refused SETUP -> same state", f is not None and len(f[2]) == 4 and f[2][3] == state)
    print(f"\n{'ALL PASS' if failures == 0 else f'{failures} FAILED'}")
    return 0 if failures == 0 else 1


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = [a for a in sys.argv[1:] if a.startswith("--")]
    contact = None
    if "--contact" in opts:  # --contact takes the next argument
        i = sys.argv.index("--contact")
        if i + 1 >= len(sys.argv) or sys.argv[i + 1].startswith("--"):
            print(__doc__)
            return 2
        contact = sys.argv[i + 1]
        args.remove(contact)
    if len(args) != 1 or len(opts) > 1 or any(o not in ("--setup", "--wallet", "--contact") for o in opts):
        print(__doc__)
        return 2
    if opts:
        port = open_port(args[0])
        time.sleep(0.3)
        port.read(4096)  # drain anything already waiting
        try:
            if opts[0] == "--contact":
                return run_contact(port, contact)
            return run_setup(port) if opts[0] == "--setup" else run_wallet(port)
        finally:
            port.close()
    with open(os.path.join(VECTORS, "parser.json")) as f:
        sol_ok = bytes.fromhex(next(v for v in json.load(f) if v["name"] == "sol_ok")["message_hex"])

    port = open_port(args[0])
    r = Reader(port)
    time.sleep(0.3)
    r.buf += port.read(4096)  # drain anything already waiting

    # The default run is for a device with no wallet. Say so plainly instead of failing every check.
    state = hello_state(r, port, 30)
    if state != 0:
        print(f"HELLO state is {state} ({'a wallet exists' if state in (1, 2) else 'no answer'}): this run needs a\n"
              "device with no wallet. Use --wallet for a device that has one, or erase NVS first (deletes the\n"
              "wallet; firmware/README.md) if it is a disposable test wallet.")
        port.close()
        return 1
    # A wallet-less SIGN_REQUEST never reaches the audio check, so test the clip pack with SETUP below:
    # a missing or stale pack makes SETUP answer DEVICE_ERROR at once.

    port.write(frame(HELLO, 1))
    expect(r, "HELLO -> fw 0x0001, proto 1, state 0 (no wallet)", 1, HELLO | 0x80,
           struct.pack("<HBB", 0x0001, 1, 0))
    port.write(frame(GET_PUBKEY, 2))
    expect(r, "GET_PUBKEY -> NO_WALLET", 2, GET_PUBKEY | 0x80, bytes([NO_WALLET]))
    port.write(frame(SIGN_REQUEST, 3, sol_ok))
    expect(r, "SIGN_REQUEST(sol_ok) -> NO_WALLET", 3, SIGN_REQUEST | 0x80, bytes([NO_WALLET]))
    port.write(frame(CONTACT_LIST_COUNT, 4))
    expect(r, "CONTACT_LIST_COUNT -> 0", 4, CONTACT_LIST_COUNT | 0x80, bytes([0]))
    port.write(frame(CANCEL, 5))
    expect(r, "CANCEL (no flow) -> OK", 5, CANCEL | 0x80, bytes([OK]))
    port.write(frame(SETUP, 6, b"\x00"))
    expect(r, "SETUP with a payload -> ERROR BAD_PAYLOAD", 6, ERROR, bytes([BAD_PAYLOAD]))
    alice = contact_wallet("Alice")[1]
    port.write(frame(CONTACT_ADD, 11, b"\x05Alice" + alice))
    expect(r, "CONTACT_ADD -> NO_WALLET (silent)", 11, CONTACT_ADD | 0x80, bytes([NO_WALLET]))
    port.write(frame(CONTACT_ADD, 12, b"\x05Al!ce" + alice))
    expect(r, "CONTACT_ADD with a bad name -> ERROR BAD_PAYLOAD", 12, ERROR, bytes([BAD_PAYLOAD]))
    setup_cancelled(r, port)

    port.write(b"hello garbage\r\n" + frame(HELLO, 7))
    expect(r, "garbage then HELLO -> answered", 7, HELLO | 0x80, struct.pack("<HBB", 1, 1, 0))
    port.write(frame(HELLO, 8, corrupt_crc=True))
    expect(r, "bad CRC -> ERROR BAD_FRAME", 8, ERROR, bytes([BAD_FRAME]))

    port.write(frame(SIGN_REQUEST, 9, sol_ok)[:20])  # half a frame, then silence
    time.sleep(1.5)
    port.write(frame(HELLO, 10))
    expect(r, "half frame + 1.5 s idle, then HELLO -> answered", 10, HELLO | 0x80,
           struct.pack("<HBB", 1, 1, 0))

    r.junk = b""  # only look at what arrives after a reopen
    for i in range(3):  # R8: reopening the port must not reset the chip
        port.close()
        time.sleep(0.3)
        port = open_port(args[0])
        r.port = port
        time.sleep(0.5)
        r.junk += port.read(4096)
        port.write(frame(HELLO, 11 + i))
        expect(r, f"reopen #{i + 1}: HELLO answered", 11 + i, HELLO | 0x80, struct.pack("<HBB", 1, 1, 0))
    check("reopening the port never reset the chip (no ESP-ROM text)",
          b"ESP-ROM" not in r.junk, repr(r.junk[:200]))
    port.close()

    print(f"\n{'ALL PASS' if failures == 0 else f'{failures} FAILED'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
