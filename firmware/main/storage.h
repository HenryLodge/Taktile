// Key-value storage in plain NVS (the `nvs` partition, namespace "taktile"). Same contract as the
// simulator's storage (sim/src/platform.c), so core behaves the same on both.
//
// Plain, not encrypted: NVS encryption on the ESP32-S3 burns eFuses, and with one board we burn
// none (docs/HARDWARE.md). Secrets are stored already encrypted under the PIN key (I7).

#ifndef TK_FW_STORAGE_H
#define TK_FW_STORAGE_H

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

#define TK_STORAGE_KEY_MAX 15 // NVS limit

// Opens NVS. Fails closed: on any error (corrupt, full, written by another ESP-IDF version) the
// partition is NEVER erased; storage stays off and every get/set returns false.
bool tk_storage_init(void);

// False if the key is invalid or missing, or the stored value is bigger than *len (nothing partial
// is returned). Otherwise *len is set to the stored length.
bool tk_storage_get(const char *key, void *buf, size_t *len);

// Stores len bytes (0 is allowed) and commits before returning true.
bool tk_storage_set(const char *key, const void *buf, size_t len);

// Bring-up only: the result of tk_storage_init (ESP_OK when storage is on).
esp_err_t tk_storage_init_err(void);

#endif
