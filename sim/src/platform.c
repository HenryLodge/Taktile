// tk_platform_t for the simulator. See sim.h.

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include "sim.h"
#include "util.h"

// ---- Terminal ----

static struct termios saved_termios;
static bool termios_saved;

void sim_terminal_raw(void) {
    if (!isatty(STDIN_FILENO) || tcgetattr(STDIN_FILENO, &saved_termios) != 0) {
        return;
    }
    termios_saved = true;
    struct termios t = saved_termios;
    t.c_lflag &= (tcflag_t) ~(ICANON | ECHO); // keep ISIG (Ctrl-C) and output processing
    t.c_cc[VMIN] = 1;
    t.c_cc[VTIME] = 0;
    tcsetattr(STDIN_FILENO, TCSANOW, &t);
}

void sim_terminal_restore(void) {
    if (termios_saved) {
        tcsetattr(STDIN_FILENO, TCSANOW, &saved_termios);
    }
}

// Read whatever stdin has right now into the key buffer, without blocking.
static void fill_keys(sim_t *s) {
    if (s->stdin_eof) {
        return;
    }
    struct pollfd p = {STDIN_FILENO, POLLIN, 0};
    while (s->keylen < sizeof(s->keybuf) && poll(&p, 1, 0) > 0 && (p.revents & (POLLIN | POLLHUP))) {
        const ssize_t n = read(STDIN_FILENO, s->keybuf + s->keylen, sizeof(s->keybuf) - s->keylen);
        if (n <= 0) {
            s->stdin_eof = true;
            return;
        }
        s->keylen += (size_t)n;
    }
}

int sim_read_key(sim_t *s, tk_button_t *button) {
    fill_keys(s);
    for (;;) {
        size_t used = 0;
        const sim_key_kind_t k = sim_decode_key(s->keybuf, s->keylen, &used, button);
        if (k == SIM_KEY_NEED_MORE) {
            if (s->keylen >= 3) { // cannot happen with 3-byte sequences; stay safe
                s->keylen = 0;
            }
            return SIM_KEY_NEED_MORE;
        }
        memmove(s->keybuf, s->keybuf + used, s->keylen - used);
        s->keylen -= used;
        if (k != SIM_KEY_IGNORED) {
            return k;
        }
    }
}

// Throw away every key typed so far (I6: presses during a clip never count).
static void discard_keys(sim_t *s) {
    fill_keys(s);
    s->keylen = 0;
    if (isatty(STDIN_FILENO)) {
        tcflush(STDIN_FILENO, TCIFLUSH);
    }
}

// ---- Platform callbacks ----

static void p_play_clip(void *ctx, uint16_t clip, bool secret) {
    sim_t *s = ctx;
    if (secret) {
#if defined(TK_SIM_INSECURE_AUDIO) && TK_SIM_INSECURE_AUDIO
        printf("[EARPIECE] (private) %s\n", sim_clip_text(clip));
#else
        printf("[EARPIECE] (private)\n"); // I2: never print secret audio
#endif
    } else {
        printf("[EARPIECE] %s\n", sim_clip_text(clip));
    }
    fflush(stdout);
    if (s->clip_ms > 0) {
        struct timespec ts = {(time_t)(s->clip_ms / 1000), (long)(s->clip_ms % 1000) * 1000000L};
        while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
        }
    }
    discard_keys(s);
}

static void p_haptic(void *ctx, tk_haptic_t pattern) {
    (void)ctx;
    static const char *const names[] = {"tick", "success (double pulse)", "reject (long buzz)",
                                        "warning (three pulses)"};
    printf("[HAPTIC] %s\n", (unsigned)pattern < 4 ? names[pattern] : "?");
    fflush(stdout);
}

static uint32_t p_now(void *ctx) {
    (void)ctx;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)((uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u);
}

static tk_button_t p_wait_button(void *ctx, uint32_t timeout_ms) {
    sim_t *s = ctx;
    const uint32_t start = p_now(ctx);
    for (;;) {
        tk_button_t b = TK_BTN_NONE;
        if (sim_read_key(s, &b) == SIM_KEY_BUTTON) {
            return b;
        }
        const uint32_t elapsed = p_now(ctx) - start;
        if (elapsed >= timeout_ms) {
            return TK_BTN_NONE;
        }
        if (s->stdin_eof) {
            struct timespec ts = {0, (long)(timeout_ms - elapsed) * 1000000L};
            nanosleep(&ts, NULL);
            return TK_BTN_NONE;
        }
        struct pollfd p = {STDIN_FILENO, POLLIN, 0};
        poll(&p, 1, (int)(timeout_ms - elapsed));
    }
}

static bool p_random(void *ctx, uint8_t *out, size_t len) {
    (void)ctx;
    size_t got = 0;
    while (got < len) {
        const ssize_t n = getrandom(out + got, len - got, 0);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return false;
        }
        got += (size_t)n;
    }
    return true;
}

static bool storage_path(const sim_t *s, const char *key, char *path, size_t cap) {
    if (key[0] == '\0') {
        return false;
    }
    for (const char *k = key; *k; k++) {
        if (!((*k >= 'a' && *k <= 'z') || (*k >= '0' && *k <= '9') || *k == '-' || *k == '_')) {
            return false;
        }
    }
    const int n = snprintf(path, cap, "%s/%s", s->data_dir, key);
    return n > 0 && (size_t)n < cap;
}

static bool p_storage_get(void *ctx, const char *key, void *buf, size_t *len) {
    char path[512];
    if (!storage_path(ctx, key, path, sizeof(path))) {
        return false;
    }
    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        return false;
    }
    const size_t n = fread(buf, 1, *len, f);
    const bool more = fgetc(f) != EOF; // the stored value is bigger than buf
    fclose(f);
    if (more) {
        return false;
    }
    *len = n;
    return true;
}

static bool p_storage_set(void *ctx, const char *key, const void *buf, size_t len) {
    char path[512], tmp[520];
    if (!storage_path(ctx, key, path, sizeof(path))) {
        return false;
    }
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (f == NULL) {
        return false;
    }
    const bool ok = (len == 0 || fwrite(buf, 1, len, f) == len) && fflush(f) == 0;
    fclose(f);
    return ok && rename(tmp, path) == 0;
}

static size_t p_serial_read(void *ctx, uint8_t *buf, size_t cap) {
    sim_t *s = ctx;
    if (s->in_pos == s->in_len) {
        s->in_pos = s->in_len = 0;
        sim_service_link(s);
    }
    size_t n = s->in_len - s->in_pos;
    if (n > cap) {
        n = cap;
    }
    memcpy(buf, s->in + s->in_pos, n);
    s->in_pos += n;
    return n;
}

static void send_all(sim_t *s, const uint8_t *buf, size_t len) {
    while (len > 0 && s->client_fd >= 0) {
        const ssize_t n = send(s->client_fd, buf, len, MSG_NOSIGNAL);
        if (n > 0) {
            buf += n;
            len -= (size_t)n;
        } else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
            struct pollfd p = {s->client_fd, POLLOUT, 0};
            poll(&p, 1, 100);
        } else {
            return;
        }
    }
}

static void p_serial_write(void *ctx, const uint8_t *buf, size_t len) {
    sim_t *s = ctx;
    if (s->client_fd < 0 || !s->client_open) {
        return; // no app connected: replies are dropped, like an unplugged cable
    }
    const size_t n = ws_encode(WS_OP_BINARY, buf, len, s->out, sizeof(s->out));
    if (n > 0) {
        send_all(s, s->out, n);
    }
}

// The sim "plays" every clip as text, and has no speaker mode.
static bool p_audio_ok(void *ctx) {
    (void)ctx;
    return true;
}

static bool p_private_audio_only(void *ctx) {
    (void)ctx;
    return true;
}

const tk_platform_t SIM_PLATFORM_TEMPLATE = {
    NULL, p_play_clip, p_haptic, p_wait_button, p_now, p_random,
    p_storage_get, p_storage_set, p_serial_read, p_serial_write,
    p_audio_ok, p_private_audio_only,
};

// ---- WebSocket link ----

static void set_nonblocking(int fd) {
    const int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

bool sim_listen(sim_t *s, const char *addr, unsigned port) {
    s->client_fd = -1;
    s->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (s->listen_fd < 0) {
        perror("socket");
        return false;
    }
    const int one = 1;
    setsockopt(s->listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in sa;
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, addr, &sa.sin_addr) != 1) {
        fprintf(stderr, "bad --listen address: %s\n", addr);
        return false;
    }
    if (bind(s->listen_fd, (struct sockaddr *)&sa, sizeof(sa)) != 0 || listen(s->listen_fd, 4) != 0) {
        perror("bind/listen");
        return false;
    }
    set_nonblocking(s->listen_fd);
    return true;
}

static void drop_client(sim_t *s) {
    if (s->client_fd >= 0) {
        close(s->client_fd);
    }
    s->client_fd = -1;
    s->client_open = false;
    s->hs_len = 0;
    s->in_len = s->in_pos = 0;
    ws_decoder_init(&s->ws);
    if (s->dev != NULL) {
        tk_device_link_reset(s->dev);
    }
}

static void control_reply(sim_t *s, uint8_t opcode, const uint8_t *payload, size_t len) {
    uint8_t frame[2 + 125];
    const size_t n = ws_encode(opcode, payload, len, frame, sizeof(frame));
    send_all(s, frame, n);
}

static void handle_ws_bytes(sim_t *s, const uint8_t *buf, size_t len) {
    while (len > 0 && s->client_fd >= 0) {
        const size_t took = ws_feed(&s->ws, buf, len);
        buf += took;
        len -= took;
        const uint8_t *payload;
        size_t plen;
        ws_event_t e;
        while (s->client_fd >= 0 && (e = ws_next(&s->ws, &payload, &plen)) != WS_NEED_MORE) {
            if (e == WS_DATA) {
                const size_t room = sizeof(s->in) - s->in_len;
                if (plen > room) {
                    fprintf(stderr, "[SIM] app sent too much at once; dropping the connection\n");
                    drop_client(s);
                    return;
                }
                memcpy(s->in + s->in_len, payload, plen);
                s->in_len += plen;
            } else if (e == WS_PING) {
                control_reply(s, WS_OP_PONG, payload, plen);
            } else if (e == WS_CLOSE) {
                control_reply(s, WS_OP_CLOSE, NULL, 0);
                printf("[SIM] app disconnected\n");
                drop_client(s);
                return;
            } else if (e == WS_ERROR) {
                printf("[SIM] WebSocket protocol error; dropping the connection\n");
                drop_client(s);
                return;
            }
        }
        if (took == 0) {
            drop_client(s); // cannot happen: ws_next always frees a frame or errors
            return;
        }
    }
}

void sim_service_link(sim_t *s) {
    // A new connection replaces the current one.
    const int fd = accept(s->listen_fd, NULL, NULL);
    if (fd >= 0) {
        if (s->client_fd >= 0) {
            printf("[SIM] new app connection replaces the old one\n");
        }
        drop_client(s);
        s->client_fd = fd;
        set_nonblocking(fd);
    }
    if (s->client_fd < 0) {
        return;
    }
    uint8_t buf[4096];
    for (;;) {
        const ssize_t n = recv(s->client_fd, buf, sizeof(buf), 0);
        if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
            if (s->client_open) {
                printf("[SIM] app disconnected\n");
            }
            drop_client(s);
            return;
        }
        if (n < 0) {
            return; // nothing more right now
        }
        size_t off = 0;
        if (!s->client_open) {
            size_t take = (size_t)n;
            if (take > sizeof(s->hs) - s->hs_len) {
                take = sizeof(s->hs) - s->hs_len;
            }
            memcpy(s->hs + s->hs_len, buf, take);
            s->hs_len += take;
            char resp[256];
            size_t used = 0;
            const ws_hs_result_t r = ws_handshake(s->hs, s->hs_len, resp, sizeof(resp), &used);
            if (r == WS_HS_NEED_MORE) {
                continue;
            }
            send_all(s, (const uint8_t *)resp, strlen(resp));
            if (r != WS_HS_OK) {
                printf("[SIM] refused a connection (%s)\n", r == WS_HS_FORBIDDEN ? "Origin not allowed" : "bad request");
                drop_client(s);
                return;
            }
            s->client_open = true;
            printf("[SIM] app connected\n");
            fflush(stdout);
            // Bytes after the request are already WebSocket frames.
            const size_t extra = s->hs_len - used;
            if (extra > 0) {
                handle_ws_bytes(s, (const uint8_t *)s->hs + used, extra);
            }
            s->hs_len = 0;
            off = take; // anything beyond hs capacity is not expected during a handshake
        }
        if (s->client_fd >= 0 && s->client_open && off < (size_t)n) {
            handle_ws_bytes(s, buf + off, (size_t)n - off);
        }
        fflush(stdout);
    }
}
