# Wraps core/ (the portable security logic) as a component. Same sources as core/CMakeLists.txt;
# no ESP-IDF code lives here.

set(CORE ${CMAKE_CURRENT_LIST_DIR}/../../../core)
# Plain GLOB (ESP-IDF also runs this file in CMake script mode, where CONFIGURE_DEPENDS is invalid):
# after adding a file to core/src, run `idf.py reconfigure`.
file(GLOB TK_CORE_SRCS ${CORE}/src/*.c)

idf_component_register(
    SRCS ${TK_CORE_SRCS}
    INCLUDE_DIRS ${CORE}/include
    REQUIRES trezor_crypto
)

# Same flags as Taktile's own code on the host.
target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wall -Wextra -Werror -Wvla -Wshadow -Wstrict-prototypes)
