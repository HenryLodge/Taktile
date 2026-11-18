"""Unit tests for sign_devnet.py (standard library only; no device, no network).

python -m unittest firmware/tools/test_sign_devnet.py    (from the repo root)
"""

import base64
import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sign_devnet as sd  # noqa: E402

VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests", "vectors")


def load(name):
    with open(os.path.join(VECTORS, name)) as f:
        return json.load(f)


PARSER = {v["name"]: v for v in load("parser.json")}
CHECKSUM = {v["name"]: v for v in load("checksum.json")["tx"]}


def keys_of(msg):
    n = msg[3]
    return [msg[4 + 32 * i: 4 + 32 * i + 32] for i in range(n)], msg[4 + 32 * n: 4 + 32 * n + 32]


class Builders(unittest.TestCase):
    def test_sol_matches_web3js_vector(self):
        v = PARSER["sol_ok"]
        want = bytes.fromhex(v["message_hex"])
        keys, blockhash = keys_of(want)
        device = bytes.fromhex(v["device_pubkey"])
        to = bytes.fromhex(v["expect"]["destination"])
        self.assertEqual(keys[0], device)
        got = sd.sol_transfer_message(device, to, int(v["expect"]["amount"]), blockhash)
        self.assertEqual(got.hex(), want.hex())

    def test_usdc_matches_web3js_vector(self):
        v = PARSER["usdc_ok"]
        want = bytes.fromhex(v["message_hex"])
        _, blockhash = keys_of(want)
        got = sd.usdc_transfer_message(bytes.fromhex(v["device_pubkey"]), bytes.fromhex(v["device_usdc_ata"]),
                                       bytes.fromhex(v["expect"]["destination"]), int(v["expect"]["amount"]),
                                       blockhash)
        self.assertEqual(got.hex(), want.hex())

    def test_sending_to_self_is_refused(self):
        device = bytes.fromhex(PARSER["sol_ok"]["device_pubkey"])
        with self.assertRaises(ValueError):
            sd.sol_transfer_message(device, device, 1, bytes(32))

    def test_checksum_words_match_vectors(self):
        for name in ("sol_ok", "usdc_ok"):
            msg = bytes.fromhex(PARSER[name]["message_hex"])
            self.assertEqual(sd.checksum_words(msg), CHECKSUM[name]["words"], name)

    def test_transaction_framing(self):
        msg = bytes.fromhex(PARSER["sol_ok"]["message_hex"])
        sig = bytes(range(64))
        tx = sd.transaction(sig, msg)
        self.assertEqual(tx, b"\x01" + sig + msg)
        self.assertEqual(base64.b64decode(base64.b64encode(tx)), tx)
        with self.assertRaises(ValueError):
            sd.transaction(sig[:63], msg)

    def test_compact_u16(self):
        self.assertEqual(sd.compact_u16(0), b"\x00")
        self.assertEqual(sd.compact_u16(0x7F), b"\x7f")
        self.assertEqual(sd.compact_u16(0x80), b"\x80\x01")
        self.assertEqual(sd.compact_u16(0xFFFF), b"\xff\xff\x03")


class Base58(unittest.TestCase):
    def test_known_keys(self):
        self.assertEqual(sd.pubkey("11111111111111111111111111111111"), bytes(32))
        self.assertEqual(sd.b58encode(bytes(32)), "11111111111111111111111111111111")
        token = sd.pubkey(sd.TOKEN_PROGRAM_B58)
        self.assertEqual(sd.b58encode(token), sd.TOKEN_PROGRAM_B58)

    def test_round_trip(self):
        for v in PARSER.values():
            k = bytes.fromhex(v["device_pubkey"])
            self.assertEqual(sd.pubkey(sd.b58encode(k)), k)

    def test_bad_input(self):
        for bad in ("0OIl", "abc", ""):
            with self.assertRaises(ValueError):
                sd.pubkey(bad)


class Amounts(unittest.TestCase):
    def test_exact(self):
        self.assertEqual(sd.sol_to_lamports("0.01"), 10_000_000)
        self.assertEqual(sd.sol_to_lamports("1"), 1_000_000_000)
        self.assertEqual(sd.sol_to_lamports("0.000000001"), 1)
        self.assertEqual(sd.sol_to_lamports("0"), 0)

    def test_refused(self):
        for bad in ("0.0000000001", "-0.01", "1.000000001", "2", "abc", "", "nan", "inf", "1e3"):
            with self.assertRaises(ValueError, msg=bad):
                sd.sol_to_lamports(bad)


class DevnetOnly(unittest.TestCase):
    def test_rpc_is_devnet_constant(self):
        self.assertEqual(sd.RPC_URL, "https://api.devnet.solana.com")
        with open(sd.__file__) as f:
            src = f.read()
        self.assertNotRegex(src, re.compile("mainnet", re.I))
        self.assertEqual(src.count("https://api."), 1)  # one endpoint, the constant
        self.assertNotIn("RPC_URL =", src.split("RPC_URL = ", 1)[1])  # never reassigned

    def test_explorer_is_devnet(self):
        self.assertTrue(sd.EXPLORER.endswith("?cluster=devnet"))


if __name__ == "__main__":
    unittest.main()
