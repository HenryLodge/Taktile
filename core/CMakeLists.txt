cmake_minimum_required(VERSION 3.20)
project(taktile_core LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

option(TK_SANITIZE "Build core, tests and third_party with ASan + UBSan" OFF)
option(TK_FUZZ "Build the libFuzzer targets in fuzz/ (clang only; implies TK_SANITIZE)" OFF)

if(TK_FUZZ)
    if(NOT CMAKE_C_COMPILER_ID MATCHES "Clang")
        message(FATAL_ERROR "TK_FUZZ needs clang (libFuzzer): add -DCMAKE_C_COMPILER=clang")
    endif()
    set(TK_SANITIZE ON)
endif()

# Set globally, before third_party, so trezor-crypto is instrumented too. Any UBSan finding
# aborts (-fno-sanitize-recover=all), so a ctest fails instead of printing a warning.
if(TK_SANITIZE)
    set(TK_SANITIZE_FLAGS -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
    include(CheckCSourceCompiles)
    set(CMAKE_REQUIRED_FLAGS "-fsanitize=address,undefined")
    set(CMAKE_REQUIRED_LINK_OPTIONS "-fsanitize=address,undefined")
    check_c_source_compiles("int main(void) { return 0; }" TK_HAVE_SANITIZERS)
    unset(CMAKE_REQUIRED_FLAGS)
    unset(CMAKE_REQUIRED_LINK_OPTIONS)
    if(NOT TK_HAVE_SANITIZERS)
        message(FATAL_ERROR "TK_SANITIZE: ${CMAKE_C_COMPILER_ID} can't link ASan/UBSan programs "
                            "(MinGW gcc has no ASan). On Windows, build core/ in WSL.")
    endif()
    add_compile_options(${TK_SANITIZE_FLAGS} -g)
    add_link_options(${TK_SANITIZE_FLAGS})
endif()

# Coverage instrumentation for libFuzzer on every target; only fuzz/ links the fuzzer runtime.
if(TK_FUZZ)
    add_compile_options(-fsanitize=fuzzer-no-link)
    add_link_options(-fsanitize=fuzzer-no-link)
endif()

add_subdirectory(third_party)

# Flags for Taktile's own code (not third-party).
set(TK_WARNINGS -Wall -Wextra -Werror -Wvla -Wshadow -Wstrict-prototypes)

add_library(tk_core STATIC
    src/tk_ata.c
    src/tk_checksum.c
    src/tk_clippack.c
    src/tk_contacts.c
    src/tk_crc32.c
    src/tk_flow.c
    src/tk_keystore.c
    src/tk_parser.c
    src/tk_pin_entry.c
    src/tk_proto.c
    src/tk_rng_health.c
    src/tk_seed.c
    src/tk_solana_consts.c
    src/tk_speech.c
    src/tk_util.c
    src/tk_words.c
)
target_include_directories(tk_core PUBLIC include)
target_link_libraries(tk_core PUBLIC trezor_crypto)
target_compile_options(tk_core PRIVATE ${TK_WARNINGS})

include(CTest)
if(BUILD_TESTING)
    add_subdirectory(tests)
endif()

if(TK_FUZZ)
    add_subdirectory(fuzz)
endif()
