# Vendored trezor-crypto subset. See trezor-crypto/VENDORED.md.
# Third-party code: warnings on, but not -Werror, so upstream warnings don't break our build.

set(TREZOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/trezor-crypto)

add_library(trezor_crypto STATIC
    ${TREZOR_DIR}/bip39.c
    ${TREZOR_DIR}/bip39_english.c
    ${TREZOR_DIR}/consteq.c
    ${TREZOR_DIR}/hmac.c
    ${TREZOR_DIR}/memzero.c
    ${TREZOR_DIR}/pbkdf2.c
    ${TREZOR_DIR}/sha2.c
    ${TREZOR_DIR}/ed25519-donna/curve25519-donna-32bit.c
    ${TREZOR_DIR}/ed25519-donna/curve25519-donna-helpers.c
    ${TREZOR_DIR}/ed25519-donna/curve25519-donna-scalarmult-base.c
    ${TREZOR_DIR}/ed25519-donna/ed25519-donna-32bit-tables.c
    ${TREZOR_DIR}/ed25519-donna/ed25519-donna-basepoint-table.c
    ${TREZOR_DIR}/ed25519-donna/ed25519-donna-impl-base.c
    ${TREZOR_DIR}/ed25519-donna/ed25519.c
    ${TREZOR_DIR}/ed25519-donna/modm-donna-32bit.c
    ${CMAKE_CURRENT_SOURCE_DIR}/tk_trezor_glue.c
)

target_include_directories(trezor_crypto PUBLIC
    ${TREZOR_DIR}
    ${TREZOR_DIR}/ed25519-donna
)

target_compile_definitions(trezor_crypto
    PUBLIC
        # Don't keep mnemonic -> seed results in a static cache; seeds must not linger in RAM.
        USE_BIP39_CACHE=0
    PRIVATE
        # memzero.c uses explicit_bzero(), which glibc only declares with _DEFAULT_SOURCE under -std=c11.
        _DEFAULT_SOURCE
)

target_compile_options(trezor_crypto PRIVATE -Wall)
