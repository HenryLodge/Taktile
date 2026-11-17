# Device test app: runs the core/ host tests (core/tests) on the ESP32-S3. Never shipped; holds no
# key. See ../README.md ("Device tests").
cmake_minimum_required(VERSION 3.16)

# The same tk_core and trezor_crypto components as the product firmware.
set(EXTRA_COMPONENT_DIRS ${CMAKE_CURRENT_LIST_DIR}/../components)

# Minimal build, as in the product firmware: no radio component is ever part of it.
set(COMPONENTS main)

# The product defaults first (no eFuses, no radios, plain NVS), then this app's overlay.
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../sdkconfig.defaults;${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(taktile_tests)
