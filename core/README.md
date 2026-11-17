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
| `third_party/` | Vendored trezor-crypto subset (see `trezor-crypto/VENDORED.md`) and the glue that supplies its platform hooks |

## Sanitizers and fuzzing

- `-DTK_SANITIZE=ON` builds everything, trezor-crypto included, with ASan + UBSan; any finding aborts the test. CMake stops early if the compiler can't link sanitized programs (MinGW gcc: build in WSL).
- `-DTK_FUZZ=ON -DCMAKE_C_COMPILER=clang` adds the libFuzzer targets (sanitizers included), the seed corpus, and short smoke runs to `ctest`.
- Seeds are rebuilt on every build from the generated vectors (`tests/gen/tk_parser_vectors.h`) (plus small clip packs) into `build/fuzz/seeds/{parser,frame,clippack}`. New inputs libFuzzer finds go into `tests/corpus/{parser,frame,clippack}`, which is gitignored.

| Target | Input | Aborts if |
| --- | --- | --- |
| `fuzz_parser` | a raw message | two parses of the same input differ; a rejection leaves `*out` non-zero; the result is out of range; an accepted message's amount or destination isn't what its bytes say |
| `fuzz_clippack` | a whole clip pack image | a failed open leaves a usable pack; a clip returned after a successful open lies outside the input, inside the index, or has an odd length |
| `fuzz_frame` | a raw serial byte stream | decoding in one piece and in random chunks gives different events; the decoder over-consumes or stops making progress; an accepted frame doesn't re-encode to itself; the input wrapped in a valid frame doesn't decode to exactly that frame |

Crash files (`crash-*`) land in the current directory; rerun one with `./build/fuzz/fuzz_parser crash-<id>`.

See `docs/SOLANA.md`, `docs/SERIAL_PROTOCOL.md`, and `docs/SECURITY_MODEL.md`.
