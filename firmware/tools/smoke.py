#!/usr/bin/env python3
"""Protocol smoke test against the real device over USB (docs/SERIAL_PROTOCOL.md).

usage: python firmware/tools/smoke.py COMx        (Linux: /dev/ttyACM0, macOS: /dev/cu.usbmodem*)

Run it with ESP-IDF's Python (it ships pyserial) against the protocol build, not the bring-up build.
Expects the Day 3-4 firmware: no wallet yet, so every flow answers NO_WALLET. Exits 0 if all pass.
The port is opened with DTR and RTS low; the last check confirms that reopening it never resets
the chip (the ROM would print "ESP-ROM" text if it did).
"""

import json
import os
import struct
import sys
import time
import zlib

import serial

HELLO, GET_PUBKEY, SETUP, SIGN_REQUEST, CONTACT_LIST_COUNT, CANCEL = 0x01, 0x02, 0x03, 0x10, 0x31, 0x7E
EVENT, ERROR = 0xF0, 0xFF
OK, NO_WALLET = 0x00, 0x05
BAD_FRAME, UNKNOWN_TYPE = 0x01, 0x02

VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests", "vectors")
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


def expect(r, name, seq, want_type, want_payload):
    got = r.response()
    ok = got == (want_type, seq, want_payload)
    check(name, ok, f"expected {(hex(want_type), seq, want_payload.hex())}, got "
          f"{None if got is None else (hex(got[0]), got[1], got[2].hex())}")


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    with open(os.path.join(VECTORS, "parser.json")) as f:
        sol_ok = bytes.fromhex(next(v for v in json.load(f) if v["name"] == "sol_ok")["message_hex"])

    port = open_port(sys.argv[1])
    r = Reader(port)
    time.sleep(0.3)
    r.buf += port.read(4096)  # drain anything already waiting

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
    port.write(frame(SETUP, 6))
    expect(r, "SETUP -> ERROR UNKNOWN_TYPE (not implemented yet)", 6, ERROR, bytes([UNKNOWN_TYPE]))

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
        port = open_port(sys.argv[1])
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
