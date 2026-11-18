#!/usr/bin/env python3
"""SIGN_REQUEST end to end on the real device and Solana DEVNET (docs/SOLANA.md, SERIAL_PROTOCOL.md).

usage: python firmware/tools/sign_devnet.py COMx --to ADDRESS --sol AMOUNT [--dry-run | --reject]
       python firmware/tools/sign_devnet.py COMx --unknown
       python firmware/tools/sign_devnet.py COMx --airdrop SOL
       python firmware/tools/sign_devnet.py COMx --balance

Run it with ESP-IDF's Python (it ships pyserial) against the protocol firmware.

  --to --sol   If the device is locked, sends UNLOCK first and waits while you enter the PIN ("wallet
               unlocked"). Only then does it fetch a fresh devnet blockhash (valid ~60 s), build a
               legacy SOL transfer from the device's wallet (SOLANA.md Shape A), print the amount and
               the 3 checksum words you should hear, and send SIGN_REQUEST: you listen and press
               CONFIRM (no PIN: the session is unlocked). Only an OK reply with a signature is
               broadcast; then it waits for devnet to confirm and prints the explorer link. The
               recipient must be a contact on the device.
  --dry-run    Same, but never broadcasts.
  --reject     Same, but you press REJECT: expects REJECTED_BY_USER; never broadcasts. (The session
               stays unlocked until a signature, 5 minutes, unplugging or a reboot.)
  --unknown    Sends a transfer to a fresh random address (not a contact): expects UNKNOWN_RECIPIENT.
  --airdrop    Asks the devnet faucet for SOL for the device's wallet (rate-limited; if it refuses,
               use https://faucet.solana.com with the printed address).
  --balance    Prints the device's address and devnet balance.

DEVNET ONLY (SECURITY_MODEL I9): the RPC endpoint is a constant, not an option. Nothing secret is
sent or printed: the address, message, signature and checksum words are all public (the app speaks
the same words from the same bytes).
"""

import base64
import hashlib
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation

RPC_URL = "https://api.devnet.solana.com"  # devnet only (I9); deliberately not configurable
EXPLORER = "https://explorer.solana.com/tx/{}?cluster=devnet"

HERE = os.path.dirname(os.path.abspath(__file__))
WORDS_FILE = os.path.join(HERE, "..", "..", "tools", "data", "pgp-even-words.txt")

LAMPORTS_PER_SOL = 1_000_000_000
MAX_SOL = Decimal(1)  # typo guard: refuse more than 1 SOL in one transfer
FEE_LAMPORTS = 5000

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
SYSTEM_PROGRAM = bytes(32)
TOKEN_PROGRAM_B58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
DEVNET_USDC_MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

HELLO, GET_PUBKEY, UNLOCK, SIGN_REQUEST = 0x01, 0x02, 0x04, 0x10
EVENT, ERROR, RESP = 0xF0, 0xFF, 0x80
OK, REJECTED, UNKNOWN_RECIPIENT = 0x00, 0x01, 0x02
UNKNOWN_TYPE = 0x02  # an ERROR code
EVENTS = {1: "ANNOUNCING", 2: "AWAITING_PIN", 3: "AWAITING_CONFIRM", 4: "SIGNING"}


# ---- Encoding (pure; tested by test_sign_devnet.py) ----

def b58encode(data):
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def b58decode(text):
    n = 0
    for c in text:
        if c not in B58:
            raise ValueError(f"not base58: {c!r}")
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(text) - len(text.lstrip("1"))) + raw


def pubkey(text):
    """A base58 address -> 32 bytes."""
    key = b58decode(text)
    if len(key) != 32:
        raise ValueError(f"not a 32-byte address: {text}")
    return key


def compact_u16(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def sol_to_lamports(text):
    """'0.01' -> 10_000_000, exactly. Refuses junk, negatives, > 9 decimals and > MAX_SOL."""
    try:
        d = Decimal(text)
    except InvalidOperation:
        raise ValueError(f"not an amount: {text!r}") from None
    if not d.is_finite() or d < 0:
        raise ValueError(f"not an amount: {text!r}")
    if d > MAX_SOL:
        raise ValueError(f"refusing more than {MAX_SOL} SOL in one transfer")
    lamports = d * LAMPORTS_PER_SOL
    if lamports != lamports.to_integral_value():
        raise ValueError("SOL has 9 decimals; that amount has more")
    return int(lamports)


def _web3_key_order(key):
    # web3.js (legacy Transaction.compileMessage) orders accounts of the same kind by their base58
    # string with localeCompare: case-insensitive first, lowercase before uppercase on a tie.
    s = b58encode(key)
    return (s.lower(), [c.isupper() for c in s])


def _legacy_message(payer, writable, readonly, blockhash, program, accounts, data):
    """payer: the only signer. writable/readonly: the other keys. accounts: keys, in order."""
    keys = [payer] + sorted(writable, key=_web3_key_order) + sorted(readonly, key=_web3_key_order)
    if len(set(keys)) != len(keys):
        raise ValueError("an account appears twice (e.g. sending to the device itself)")
    ix = (bytes([keys.index(program)]) + compact_u16(len(accounts)) + bytes(keys.index(a) for a in accounts) +
          compact_u16(len(data)) + data)
    return (bytes([1, 0, len(readonly)]) + compact_u16(len(keys)) + b"".join(keys) + blockhash +
            compact_u16(1) + ix)


def sol_transfer_message(device, to, lamports, blockhash):
    """Shape A: System Program Transfer from the device (fee payer, only signer) to `to`."""
    data = struct.pack("<IQ", 2, lamports)
    return _legacy_message(device, [to], [SYSTEM_PROGRAM], blockhash, SYSTEM_PROGRAM, [device, to], data)


def usdc_transfer_message(device, source_ata, dest_ata, amount, blockhash):
    """Shape B: SPL Token TransferChecked of devnet USDC (6 decimals). Not broadcast yet (setup-devnet)."""
    mint, token = pubkey(DEVNET_USDC_MINT_B58), pubkey(TOKEN_PROGRAM_B58)
    data = bytes([12]) + struct.pack("<Q", amount) + bytes([6])
    return _legacy_message(device, [dest_ata, source_ata], [mint, token], blockhash, token,
                           [source_ata, mint, dest_ata, device], data)


def load_words():
    with open(WORDS_FILE) as f:
        words = [l.strip() for l in f if l.strip() and not l.startswith("#")]
    if len(words) != 256:
        raise ValueError("word list must have 256 words")
    return words


def checksum_words(message):
    """AUDIO.md tx phrase: SHA256("TK-TX-v1" || message), bytes 0..2."""
    words = load_words()
    h = hashlib.sha256(b"TK-TX-v1" + message).digest()
    return [words[b] for b in h[:3]]


def transaction(signature, message):
    """A one-signer transaction: compact-u16 1, the signature, the message."""
    if len(signature) != 64:
        raise ValueError("signature must be 64 bytes")
    return compact_u16(1) + signature + message


# ---- Devnet RPC ----

def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            reply = json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"devnet RPC {method}: HTTP {e.code} {e.read()[:300]!r}") from None
    if "error" in reply:
        raise RuntimeError(f"devnet RPC {method}: {reply['error']}")
    return reply["result"]


def balance(address):
    return rpc("getBalance", [address, {"commitment": "confirmed"}])["value"]


def sol(lamports):
    return f"{Decimal(lamports) / LAMPORTS_PER_SOL:f} SOL"


# ---- Device ----

def device_pubkey(r, port):
    from smoke import frame
    port.write(frame(HELLO, 1))
    f = r.response()
    if f is None or f[0] != HELLO | RESP or len(f[2]) != 4:
        raise RuntimeError(f"no HELLO reply: {f}")
    if f[2][3] == 0:
        raise RuntimeError("the device has no wallet: run smoke.py --setup first")
    port.write(frame(GET_PUBKEY, 2))
    g = r.response()
    if g is None or g[0] != GET_PUBKEY | RESP or len(g[2]) != 33 or g[2][0] != OK:
        raise RuntimeError(f"GET_PUBKEY failed: {g}")
    return g[2][1:]


def unlock_device(r, port):
    """UNLOCK if HELLO says locked (the PIN on the device); returns the status name, or raises."""
    from smoke import frame, STATUS
    port.write(frame(HELLO, 5))
    f = r.response()
    if f is None or f[0] != HELLO | RESP or len(f[2]) != 4:
        raise RuntimeError(f"no HELLO reply: {f}")
    if f[2][3] == 2:
        print("device already unlocked")
        return "OK"
    print("Unlocking: enter the PIN on the device (you hear \"wallet unlocked\").")
    port.write(frame(UNLOCK, 4))
    deadline = time.time() + 5 * 60
    while time.time() < deadline:
        f = r.next_frame(deadline - time.time())
        if f is None:
            break
        if f[0] == EVENT and len(f[2]) == 1:
            print(f"  device: {EVENTS.get(f[2][0], hex(f[2][0]))}")
            continue
        if f[0] == ERROR and f[1] == 4:
            if f[2] == bytes([UNKNOWN_TYPE]):
                raise RuntimeError("the firmware has no UNLOCK (0x04): reflash it (idf.py -p PORT flash)")
            raise RuntimeError(f"device ERROR {f[2].hex()}")
        if f[0] == UNLOCK | RESP and f[1] == 4 and len(f[2]) == 1:
            return STATUS.get(f[2][0], hex(f[2][0]))
    raise RuntimeError("no UNLOCK reply within 5 minutes")


def sign_on_device(r, port, message):
    """SIGN_REQUEST; prints events; returns (status, signature or None)."""
    from smoke import frame
    port.write(frame(SIGN_REQUEST, 3, message))
    deadline = time.time() + 5 * 60
    while time.time() < deadline:
        f = r.next_frame(deadline - time.time())
        if f is None:
            break
        if f[0] == EVENT and len(f[2]) == 1:
            print(f"  device: {EVENTS.get(f[2][0], hex(f[2][0]))}")
            continue
        if f[0] == ERROR:
            raise RuntimeError(f"device ERROR {f[2].hex()}")
        if f[0] == SIGN_REQUEST | RESP and f[1] == 3 and len(f[2]) >= 1:
            status = f[2][0]
            if status == OK and len(f[2]) == 65:
                return status, f[2][1:]
            return status, None
    raise RuntimeError("no SIGN_REQUEST reply within 5 minutes")


def wait_confirmed(sig, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        st = rpc("getSignatureStatuses", [[sig]])["value"][0]
        if st is not None:
            if st.get("err") is not None:
                raise RuntimeError(f"transaction failed on devnet: {st['err']}")
            if st.get("confirmationStatus") in ("confirmed", "finalized"):
                return st["confirmationStatus"]
        time.sleep(1.5)
    return None


# ---- Modes ----

def run_balance(addr):
    print(f"device address: {addr}\nbalance: {sol(balance(addr))} (devnet)")
    return 0


def run_airdrop(addr, amount_text):
    lamports = sol_to_lamports(amount_text)
    print(f"requesting {sol(lamports)} from the devnet faucet for {addr} ...")
    try:
        sig = rpc("requestAirdrop", [addr, lamports])
    except RuntimeError as e:
        print(f"{e}\nThe faucet refused (it is rate-limited). Use https://faucet.solana.com with the address above.")
        return 1
    print(f"airdrop: {sig}\nconfirmed: {wait_confirmed(sig)}\nbalance: {sol(balance(addr))}")
    return 0


def run_send(r, port, device, to, lamports, mode):
    """mode: 'send', 'dry-run', 'reject' or 'unknown'."""
    addr = b58encode(device)
    before = balance(addr)
    print(f"device {addr}: {sol(before)}")
    if mode == "send" and before < lamports + FEE_LAMPORTS:
        print(f"not enough SOL for {sol(lamports)} plus the fee: use --airdrop first")
        return 1
    if mode != "unknown":  # the PIN first, so the blockhash below is fetched after it (~60 s life)
        unlocked = unlock_device(r, port)
        print(f"UNLOCK -> {unlocked}")
        if unlocked != "OK":
            return 1
    bh = rpc("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]  # as late as possible
    message = sol_transfer_message(device, to, lamports, pubkey(bh["blockhash"]))
    print(f"\nSending {sol(lamports)} to {b58encode(to)}"
          f"{' (NOT a contact: expect UNKNOWN_RECIPIENT)' if mode == 'unknown' else ''}.\n"
          f"You should hear: \"send {sol(lamports)} to <the contact's name, spelled>, checksum ...\"\n"
          f"Checksum words: {' '.join(checksum_words(message))}\n"
          f"{'Then press REJECT.' if mode == 'reject' else 'Then press CONFIRM.'}\n")
    t0 = time.time()
    status, sig = sign_on_device(r, port, message)
    from smoke import STATUS
    print(f"SIGN_REQUEST -> {STATUS.get(status, hex(status))} after {time.time() - t0:.0f} s")
    if mode == "unknown":
        return 0 if status == UNKNOWN_RECIPIENT else 1
    if mode == "reject":
        return 0 if status == REJECTED else 1
    if status != OK or sig is None:
        return 1
    tx = transaction(sig, message)
    if mode == "dry-run":
        print(f"signature {b58encode(sig)} (dry run: not broadcast)")
        return 0
    height = rpc("getBlockHeight", [{"commitment": "confirmed"}])
    if height > bh["lastValidBlockHeight"]:
        print("too slow: the blockhash expired before the device signed. Nothing was sent; run again.")
        return 1
    print(f"blockhash still valid for {bh['lastValidBlockHeight'] - height} blocks (about 0.4 s each)")
    txid = rpc("sendTransaction", [base64.b64encode(tx).decode(),
                                   {"encoding": "base64", "preflightCommitment": "confirmed"}])
    if txid != b58encode(sig):
        print(f"warning: devnet returned {txid}, expected {b58encode(sig)}")
    print(f"sent: {txid}\n{EXPLORER.format(txid)}")
    print(f"devnet: {wait_confirmed(txid) or 'not confirmed within 60 s (check the link)'}")
    print(f"device balance: {sol(balance(addr))} (was {sol(before)})")
    return 0


def main():
    argv = sys.argv[1:]

    def opt(name):
        if name not in argv:
            return None
        i = argv.index(name)
        if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
            raise SystemExit(__doc__)
        return argv[i + 1]

    flags = {a for a in argv if a.startswith("--")}
    values = {opt(n) for n in ("--to", "--sol", "--airdrop")} - {None}
    ports = [a for a in argv if not a.startswith("--") and a not in values]
    if len(ports) != 1 or not flags or not flags <= {"--to", "--sol", "--airdrop", "--balance", "--unknown",
                                                    "--dry-run", "--reject"}:
        print(__doc__)
        return 2
    try:
        to_text, sol_text, airdrop = opt("--to"), opt("--sol"), opt("--airdrop")
        lamports = sol_to_lamports(sol_text if sol_text is not None else "0.01")
        to = pubkey(to_text) if to_text is not None else None
    except ValueError as e:
        print(e)
        return 2
    mode = "unknown" if "--unknown" in flags else "reject" if "--reject" in flags else \
        "dry-run" if "--dry-run" in flags else "send"
    sending = "--to" in flags or mode == "unknown"
    if mode != "unknown" and sending and to is None:
        print("--to ADDRESS is required")
        return 2
    if not sending and "--airdrop" not in flags and "--balance" not in flags:
        print(__doc__)
        return 2

    from smoke import Reader, open_port  # pyserial (ESP-IDF's Python)
    try:
        port = open_port(ports[0])
    except Exception as e:  # serial.SerialException: wrong port, or a monitor still has it open
        print(f"could not open {ports[0]}: {e}")
        return 1
    try:
        time.sleep(0.3)
        r = Reader(port)
        r.buf += port.read(4096)
        r.buf = b""  # drop anything that was waiting
        device = device_pubkey(r, port)
        if "--balance" in flags:
            return run_balance(b58encode(device))
        if "--airdrop" in flags:
            return run_airdrop(b58encode(device), airdrop)
        if mode == "unknown":
            to = os.urandom(32)
        return run_send(r, port, device, to, lamports, mode)
    except (RuntimeError, ValueError) as e:
        print(e)
        return 1
    finally:
        port.close()


if __name__ == "__main__":
    sys.exit(main())
