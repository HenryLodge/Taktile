# The core/ test list, shared by the host build (core/tests/CMakeLists.txt) and the device test app
# (firmware/test_app), so every host test also runs on the ESP32-S3. Add new tests here.

set(TK_TESTS
    test_util
    test_crypto
    test_crc32
    test_ata
    test_checksum
    test_clippack
    test_contacts
    test_speech
    test_pin_entry
    test_flow
    test_parser
    test_proto
    test_rng_health
    test_solana_consts
)
