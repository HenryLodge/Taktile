cmake_minimum_required(VERSION 3.20)
project(taktile_core LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_subdirectory(third_party)

# Flags for Taktile's own code (not third-party).
set(TK_WARNINGS -Wall -Wextra -Werror -Wvla -Wshadow -Wstrict-prototypes)

add_library(tk_core STATIC
    src/tk_crc32.c
    src/tk_proto.c
    src/tk_util.c
)
target_include_directories(tk_core PUBLIC include)
target_link_libraries(tk_core PUBLIC trezor_crypto)
target_compile_options(tk_core PRIVATE ${TK_WARNINGS})

include(CTest)
if(BUILD_TESTING)
    add_subdirectory(tests)
endif()
