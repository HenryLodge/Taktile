# Taktile firmware (ESP-IDF v5.x, Adafruit Metro ESP32-S3). See README.md.
cmake_minimum_required(VERSION 3.16)

# core/ and trezor-crypto are wrapped as components (no copied sources).
set(EXTRA_COMPONENT_DIRS ${CMAKE_CURRENT_LIST_DIR}/components)

# Minimal build: only main and what it REQUIRES (transitively). esp_wifi, bt and esp_phy are never
# part of the build, so nothing can initialize a radio (SECURITY_MODEL I8).
set(COMPONENTS main)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(taktile)
