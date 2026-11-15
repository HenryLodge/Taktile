# Wraps the vendored trezor-crypto subset in core/third_party (same files and definitions as
# core/third_party/CMakeLists.txt; see trezor-crypto/VENDORED.md). No sources are copied.

set(TP ${CMAKE_CURRENT_LIST_DIR}/../../../core/third_party)
set(TC ${TP}/trezor-crypto)

idf_component_register(
    SRCS
        ${TC}/bip39.c
        ${TC}/bip39_english.c
        ${TC}/consteq.c
        ${TC}/hmac.c
        ${TC}/memzero.c
        ${TC}/pbkdf2.c
        ${TC}/sha2.c
        ${TC}/ed25519-donna/curve25519-donna-32bit.c
        ${TC}/ed25519-donna/curve25519-donna-helpers.c
        ${TC}/ed25519-donna/curve25519-donna-scalarmult-base.c
        ${TC}/ed25519-donna/ed25519-donna-32bit-tables.c
        ${TC}/ed25519-donna/ed25519-donna-basepoint-table.c
        ${TC}/ed25519-donna/ed25519-donna-impl-base.c
        ${TC}/ed25519-donna/ed25519.c
        ${TC}/ed25519-donna/modm-donna-32bit.c
        ${TP}/tk_trezor_glue.c
        ${TP}/tk_ed25519_point.c
    INCLUDE_DIRS
        ${TC}
        ${TC}/ed25519-donna
        ${TP}
)

# No static mnemonic -> seed cache: seeds must not linger in RAM.
target_compile_definitions(${COMPONENT_LIB} PUBLIC USE_BIP39_CACHE=0)
# Third-party code: warnings shown but never fatal, as on the host.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error)
