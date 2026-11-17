// Plain NVS storage. See storage.h.
//
// Never calls nvs_flash_erase: the ESP-IDF examples erase NVS when it won't open, which for a
// wallet would silently delete the seed and contacts. Erasing is a manual step (firmware/README.md).

#include "storage.h"

#include "nvs.h"
#include "nvs_flash.h"

#define NAMESPACE "taktile"

static nvs_handle_t handle;
static bool ready;
static esp_err_t init_err = ESP_ERR_INVALID_STATE; // until tk_storage_init runs

bool tk_storage_init(void) {
    init_err = nvs_flash_init();
    if (init_err == ESP_OK) {
        init_err = nvs_open(NAMESPACE, NVS_READWRITE, &handle);
    }
    ready = init_err == ESP_OK;
    return ready;
}

// Same characters as the simulator, within NVS's key length.
static bool key_ok(const char *key) {
    if (key == NULL || key[0] == '\0') {
        return false;
    }
    size_t n = 0;
    for (const char *k = key; *k; k++, n++) {
        if (n >= TK_STORAGE_KEY_MAX ||
            !((*k >= 'a' && *k <= 'z') || (*k >= '0' && *k <= '9') || *k == '-' || *k == '_')) {
            return false;
        }
    }
    return true;
}

bool tk_storage_get(const char *key, void *buf, size_t *len) {
    if (!ready || !key_ok(key) || len == NULL || (buf == NULL && *len != 0)) {
        return false;
    }
    size_t stored = 0;
    if (nvs_get_blob(handle, key, NULL, &stored) != ESP_OK || stored > *len) {
        return false; // missing, or too big for buf: return nothing rather than part of it
    }
    if (stored > 0 && nvs_get_blob(handle, key, buf, &stored) != ESP_OK) {
        return false;
    }
    *len = stored;
    return true;
}

bool tk_storage_set(const char *key, const void *buf, size_t len) {
    if (!ready || !key_ok(key) || (buf == NULL && len != 0)) {
        return false;
    }
    static const uint8_t empty = 0;
    return nvs_set_blob(handle, key, len ? buf : &empty, len) == ESP_OK && nvs_commit(handle) == ESP_OK;
}

esp_err_t tk_storage_init_err(void) {
    return init_err;
}
