cmake_minimum_required(VERSION 3.20)
project(taktile_sim LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

option(TK_SIM_INSECURE_AUDIO "Print private audio (checksum words, PIN digits). Development only (I2)" OFF)

# -DTK_SANITIZE=ON: core sets its sanitizer flags for its own directory only, so the sim's
# targets need them too (or they fail to link against the instrumented core).
if(TK_SANITIZE)
    add_compile_options(-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer -g)
    add_link_options(-fsanitize=address,undefined)
endif()

# core/ (and its TK_SANITIZE option) without core's own tests.
set(BUILD_TESTING OFF)
add_subdirectory(../core core)

set(SIM_WARNINGS -Wall -Wextra -Werror -Wvla -Wshadow -Wstrict-prototypes)

add_library(sim_lib STATIC src/ws.c src/util.c src/platform.c src/wallet.c)
target_include_directories(sim_lib PUBLIC src)
target_link_libraries(sim_lib PUBLIC tk_core)
target_compile_options(sim_lib PRIVATE ${SIM_WARNINGS})
# POSIX: poll, termios, sockets, getrandom, clock_gettime under -std=c11.
target_compile_definitions(sim_lib PUBLIC _GNU_SOURCE)
if(TK_SIM_INSECURE_AUDIO)
    target_compile_definitions(sim_lib PRIVATE TK_SIM_INSECURE_AUDIO=1)
endif()

add_executable(taktile-sim src/main.c)
target_link_libraries(taktile-sim PRIVATE sim_lib)
target_compile_options(taktile-sim PRIVATE ${SIM_WARNINGS})
if(TK_SIM_INSECURE_AUDIO)
    target_compile_definitions(taktile-sim PRIVATE TK_SIM_INSECURE_AUDIO=1)
endif()

enable_testing()
add_executable(test_ws tests/test_ws.c)
target_link_libraries(test_ws PRIVATE sim_lib)
target_include_directories(test_ws PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../core/tests)
target_compile_options(test_ws PRIVATE ${SIM_WARNINGS})
add_test(NAME test_ws COMMAND test_ws)

find_program(PYTHON3 python3)
if(PYTHON3)
    set(SIM_INSECURE_FLAG 0)
    if(TK_SIM_INSECURE_AUDIO)
        set(SIM_INSECURE_FLAG 1)
    endif()
    add_test(NAME sim_e2e
             COMMAND ${PYTHON3} ${CMAKE_CURRENT_SOURCE_DIR}/tests/e2e.py $<TARGET_FILE:taktile-sim>
                     ${CMAKE_CURRENT_SOURCE_DIR}/../tests/vectors ${SIM_INSECURE_FLAG})
    set_tests_properties(sim_e2e PROPERTIES TIMEOUT 120)
endif()
