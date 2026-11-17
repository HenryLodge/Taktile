// Taktile firmware entry point. See README.md and docs/ARCHITECTURE.md.

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "audio.h"
#include "bringup.h"
#include "buttons.h"
#include "haptics.h"
#include "link.h"
#include "platform.h"
#include "rng.h"
#include "tk_contacts.h"
#include "tk_device.h"

#if !CONFIG_TK_BRINGUP

static tk_device_t dev;
static tk_contacts_t book;

static void load_contacts(const tk_platform_t *p) {
    static uint8_t blob[TK_CONTACTS_BLOB_LEN + 1];
    size_t len = sizeof(blob);
    tk_contacts_init(&book);
    if (p->storage_get(p->ctx, TK_STORAGE_CONTACTS, blob, &len) &&
        tk_contacts_load(&book, blob, len) != TK_CONTACTS_OK) {
        tk_contacts_init(&book); // corrupt: start empty rather than trust it
    }
}

static void run_device(void) {
    const tk_platform_t *p = &TK_FW_PLATFORM;
    if (!tk_link_init()) {
        for (;;) { // no link means no way to reach the host: halt quietly
            vTaskDelay(portMAX_DELAY);
        }
    }
    load_contacts(p);
    tk_device_init(&dev, p, &TK_FW_NO_WALLET, &book);
    for (;;) {
        tk_device_poll(&dev);
        if (tk_link_should_reset(p->now_ms(p->ctx))) {
            tk_device_link_reset(&dev);
        }
        vTaskDelay(1); // 1 ms (FREERTOS_HZ=1000): lets the idle task run and feed the watchdog
    }
}

#endif

void app_main(void) {
    // I11: the hardware RNG is only truly random with radios off once the internal entropy source
    // is on. First thing, before anything can use randomness; never disabled. tk_rng_start's first
    // statement is bootloader_random_enable(); randomness is refused until it has run (rng.c).
    tk_rng_start();
    tk_audio_spk_off(); // speaker amp off until a public clip in speaker mode turns it on (#9)

    // Drivers. A failed init is fail-closed: no presses are reported, clips are silent, haptics
    // are off.
    (void)tk_buttons_init();
    (void)tk_audio_init();
    (void)tk_haptics_init();

#if CONFIG_TK_BRINGUP
    tk_bringup_main();
#else
    run_device();
#endif
}
