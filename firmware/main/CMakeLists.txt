idf_component_register(
    SRCS main.c link.c platform.c rng.c bringup.c
    INCLUDE_DIRS .
    # Keep this list narrow: anything not reachable from here is not in the build (no radios, I8).
    REQUIRES tk_core esp_driver_usb_serial_jtag esp_driver_gpio esp_timer bootloader_support
)

target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wall -Wextra -Werror -Wvla -Wshadow -Wstrict-prototypes)
