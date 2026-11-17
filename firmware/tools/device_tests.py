#!/usr/bin/env python3
"""Runs the core/ tests on the device (the firmware/test_app build) and reports the result.

usage: python firmware/tools/device_tests.py COMx [--full]
       (Linux: /dev/ttyACM0, macOS: /dev/cu.usbmodem*)

Run it with ESP-IDF's Python (it ships pyserial) after flashing firmware/test_app. Opens the port
without resetting the chip and asks for a run: short by default (the seeded random loops at 1/20,
a few minutes), or --full (the host's iteration counts, about 40 minutes). Prints the output and
exits 0 only if that run's summary line says PASS. Flash the protocol firmware back afterwards.
"""

import sys
import time

import serial


def main(port, full):
    timeout_s = 3600 if full else 900
    want = "(full)" if full else "(short"
    s = serial.Serial()
    s.port = port
    s.timeout = 0.2
    s.dtr = False  # DTR/RTS low: opening the port must not reset the chip
    s.rts = False
    s.open()
    time.sleep(0.3)
    s.reset_input_buffer()
    s.write(b"f" if full else b"r")
    started = False  # seen the header of the run we asked for (a run already going may finish first)
    pending = ""
    end = time.time() + timeout_s
    while time.time() < end:
        chunk = s.read(4096)
        if not chunk:
            continue
        text = chunk.decode(errors="replace")
        sys.stdout.write(text)
        sys.stdout.flush()
        pending += text
        *lines, pending = pending.split("\n")
        for line in lines:
            if line.startswith("DEVICE TESTS: running") and want in line:
                started = True
            elif started and line.startswith("DEVICE TESTS:"):
                s.close()
                return 0 if " PASS " in line + " " else 1
    s.close()
    print(f"\nno summary line within {timeout_s} s (is firmware/test_app flashed?)")
    return 1


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--full"]
    if len(args) != 1:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(args[0], "--full" in sys.argv[1:]))
