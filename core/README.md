# core/

Portable C11 library holding all of Taktile's security logic: transaction parser, ATA derivation, contacts, checksum phrases, the sign-request flow, and protocol framing.

- **No ESP-IDF or OS headers.** `core/` talks to the outside world only through `tk_platform_t` (`include/tk_platform.h`). The same code builds for the host (tests, `sim/`) and the device (`firmware/`).
- Bounds-check every read. No recursion and no allocation in parse paths.
- Tests run under ASan + UBSan; the parser and frame decoder have libFuzzer targets.

| Folder | Contents |
| --- | --- |
| `include/` | Public headers (`tk_*.h`) |
| `src/` | Implementation |
| `tests/` | ctest cases, driven by `tests/vectors/` at the repo root |
| `fuzz/` | libFuzzer targets (`-DTK_FUZZ=ON`, clang) |

See `docs/SOLANA.md`, `docs/SERIAL_PROTOCOL.md`, and `docs/SECURITY_MODEL.md`.
