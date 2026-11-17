idf_component_register(
    SRCS main.c link.c platform.c rng.c buttons.c audio.c haptics.c storage.c bringup.c
    INCLUDE_DIRS .
    # Keep this list narrow: anything not reachable from here is not in the build (no radios, I8).
    REQUIRES tk_core esp_driver_usb_serial_jtag esp_driver_gpio esp_timer bootloader_support
             esp_driver_i2s esp_partition esp_driver_i2c nvs_flash
)

target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wall -Wextra -Werror -Wvla -Wshadow -Wstrict-prototypes)
