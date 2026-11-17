# Builds every core/ test (the list in core/tests/tests.cmake, shared with the host) into this app.
# Each test file's main() is renamed to tk_test_<name>() and listed in a generated header.

set(TESTS_DIR ${CMAKE_CURRENT_LIST_DIR}/../../../core/tests)
include(${TESTS_DIR}/tests.cmake)

set(srcs runner.c)
set(list_h "")
foreach(t ${TK_TESTS})
    list(APPEND srcs ${TESTS_DIR}/${t}.c)
    string(APPEND list_h "TK_TEST(${t})\n")
endforeach()
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/tk_test_list.h "${list_h}")

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS . ${CMAKE_CURRENT_BINARY_DIR}
    PRIV_INCLUDE_DIRS ${TESTS_DIR} ${TESTS_DIR}/gen
    REQUIRES tk_core bootloader_support esp_timer esp_driver_usb_serial_jtag vfs esp_psram
    LDFRAGMENTS linker.lf
)

foreach(t ${TK_TESTS})
    set_source_files_properties(${TESTS_DIR}/${t}.c PROPERTIES COMPILE_DEFINITIONS "main=tk_test_${t}")
endforeach()
# TK_TEST_ITERS reads its divisor from runner.c (short or full run).
target_compile_definitions(${COMPONENT_LIB} PRIVATE TK_TEST_DEVICE)

# Same flags as the host tests (core/CMakeLists.txt TK_WARNINGS).
target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wall -Wextra -Werror -Wvla -Wshadow -Wstrict-prototypes)
