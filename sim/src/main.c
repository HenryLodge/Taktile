// taktile-sim: core/ + a WebSocket serial link + keyboard buttons + printed audio. See sim/README.md.

#include <getopt.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "sim.h"
#include "tk_contacts.h"
#include "util.h"

static volatile sig_atomic_t stop;

static void on_signal(int sig) {
    (void)sig;
    if (stop) { // second Ctrl-C: leave now, even mid-flow
        sim_terminal_restore();
        _exit(130);
    }
    stop = 1; // first: finish the current flow, then exit
}

static void usage(void) {
    fprintf(stderr,
            "usage: taktile-sim [options]\n"
            "  --listen ADDR       address to listen on (default 127.0.0.1)\n"
            "  --port N            WebSocket port (default 8765)\n"
            "  --data DIR          where contacts and the dev seed live (default ./sim-data)\n"
            "  --clip-ms N         how long each clip 'plays' (default 300)\n"
            "  --contact NAME=ADDR add a contact (base58 or 64 hex); repeatable\n"
            "  --seed-hex HEX      use this 32-byte dev seed instead of <data>/dev-seed (not saved)\n"
            "  --pin DDDDDD        dev wallet PIN (default 123456)\n"
            "  --unlocked          start with the dev wallet unlocked\n"
            "keys: Up/Down, Enter=OK, Backspace=BACK, c=CONFIRM, r=REJECT, O=long OK (repeat),\n"
            "      R=long REJECT (cancel), q=quit (when idle)\n");
}

static bool save_contacts(const tk_platform_t *p, const tk_contacts_t *book) {
    uint8_t blob[TK_CONTACTS_BLOB_LEN];
    return tk_contacts_save(book, blob, sizeof(blob)) == sizeof(blob) &&
           p->storage_set(p->ctx, TK_STORAGE_CONTACTS, blob, sizeof(blob));
}

static bool load_contacts(const tk_platform_t *p, tk_contacts_t *book) {
    uint8_t blob[TK_CONTACTS_BLOB_LEN + 1];
    size_t len = sizeof(blob);
    tk_contacts_init(book);
    if (!p->storage_get(p->ctx, TK_STORAGE_CONTACTS, blob, &len)) {
        return true; // no saved book yet
    }
    if (tk_contacts_load(book, blob, len) != TK_CONTACTS_OK) {
        fprintf(stderr, "%s/%s is corrupt; move it away to start with an empty contact book\n",
                ((const sim_t *)p->ctx)->data_dir, TK_STORAGE_CONTACTS);
        return false;
    }
    return true;
}

static bool add_contact(tk_contacts_t *book, const char *arg) {
    const char *eq = strchr(arg, '=');
    uint8_t wallet[32];
    if (eq == NULL || !sim_parse_address(eq + 1, wallet)) {
        fprintf(stderr, "--contact expects NAME=ADDRESS (base58 or 64 hex): %s\n", arg);
        return false;
    }
    const size_t name_len = (size_t)(eq - arg);
    const tk_contacts_result_t r = tk_contacts_add(book, (const uint8_t *)arg, name_len, wallet);
    if (r == TK_CONTACTS_NAME_EXISTS || r == TK_CONTACTS_ADDRESS_EXISTS) {
        printf("[SIM] contact %.*s already in the book\n", (int)name_len, arg);
        return true;
    }
    if (r != TK_CONTACTS_OK) {
        fprintf(stderr, "cannot add contact %.*s (name rules: 1-12 of A-Z a-z 0-9 space - ')\n", (int)name_len, arg);
        return false;
    }
    return true;
}

int main(int argc, char **argv) {
    static sim_t sim;
    static tk_contacts_t book;
    static tk_device_t dev;
    static sim_wallet_t wallet;

    const char *listen_addr = "127.0.0.1", *seed_hex = NULL, *pin = NULL;
    unsigned port = 8765;
    bool unlocked = false;
    const char *contacts_args[TK_CONTACTS_MAX];
    size_t ncontacts = 0;
    sim.data_dir = "sim-data";
    sim.clip_ms = 300;

    enum { O_LISTEN = 1, O_PORT, O_DATA, O_CLIP, O_CONTACT, O_SEED, O_PIN, O_UNLOCKED, O_HELP };
    static const struct option opts[] = {
        {"listen", required_argument, NULL, O_LISTEN}, {"port", required_argument, NULL, O_PORT},
        {"data", required_argument, NULL, O_DATA},     {"clip-ms", required_argument, NULL, O_CLIP},
        {"contact", required_argument, NULL, O_CONTACT}, {"seed-hex", required_argument, NULL, O_SEED},
        {"pin", required_argument, NULL, O_PIN},       {"unlocked", no_argument, NULL, O_UNLOCKED},
        {"help", no_argument, NULL, O_HELP},           {NULL, 0, NULL, 0},
    };
    int c;
    while ((c = getopt_long(argc, argv, "", opts, NULL)) != -1) {
        switch (c) {
        case O_LISTEN: listen_addr = optarg; break;
        case O_PORT: port = (unsigned)strtoul(optarg, NULL, 10); break;
        case O_DATA: sim.data_dir = optarg; break;
        case O_CLIP: sim.clip_ms = (unsigned)strtoul(optarg, NULL, 10); break;
        case O_CONTACT:
            if (ncontacts == TK_CONTACTS_MAX) {
                fprintf(stderr, "at most %u contacts\n", TK_CONTACTS_MAX);
                return 2;
            }
            contacts_args[ncontacts++] = optarg;
            break;
        case O_SEED: seed_hex = optarg; break;
        case O_PIN: pin = optarg; break;
        case O_UNLOCKED: unlocked = true; break;
        default: usage(); return c == O_HELP ? 0 : 2;
        }
    }
    setvbuf(stdout, NULL, _IOLBF, 0);
    mkdir(sim.data_dir, 0700);

    tk_platform_t platform = SIM_PLATFORM_TEMPLATE;
    platform.ctx = &sim;
    if (!sim_wallet_init(&wallet, &platform, seed_hex, pin, unlocked)) {
        return 2;
    }
    tk_wallet_ops_t wallet_ops = SIM_WALLET_OPS_TEMPLATE;
    wallet_ops.ctx = &wallet;

    if (!load_contacts(&platform, &book)) {
        return 2;
    }
    for (size_t i = 0; i < ncontacts; i++) {
        if (!add_contact(&book, contacts_args[i])) {
            return 2;
        }
    }
    if (ncontacts > 0 && !save_contacts(&platform, &book)) {
        fprintf(stderr, "cannot save contacts in %s\n", sim.data_dir);
        return 2;
    }

    ws_decoder_init(&sim.ws);
    if (!sim_listen(&sim, listen_addr, port)) {
        return 2;
    }
    tk_device_init(&dev, &platform, &wallet_ops, &book);
    sim.dev = &dev;

    printf("taktile-sim: ws://%s:%u  data: %s\n", listen_addr, port, sim.data_dir);
    printf("WARNING: INSECURE development wallet (plaintext seed%s). Devnet only.\n",
           seed_hex ? " from --seed-hex" : " in <data>/dev-seed");
#if defined(TK_SIM_INSECURE_AUDIO) && TK_SIM_INSECURE_AUDIO
    printf("WARNING: built with TK_SIM_INSECURE_AUDIO: private audio (checksum words, PIN digits) is printed.\n");
#endif
    if (wallet.has_wallet) {
        char b58[45];
        sim_base58_encode32(wallet.pubkey, b58);
        printf("wallet: %s (%s)\n", b58, wallet.unlocked ? "unlocked" : "locked");
    } else {
        printf("wallet: none (wiped)\n");
    }
    printf("contacts: %u\n", book.count);
    for (uint8_t i = 0; i < book.count; i++) {
        char b58[45];
        sim_base58_encode32(book.items[i].wallet, b58);
        printf("  %u. %s  %s\n", i, book.items[i].name, b58);
    }
    printf("keys: Up/Down, Enter=OK, Backspace=BACK, c=CONFIRM, r=REJECT, O=repeat, R=cancel, q=quit\n");

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    sim_terminal_raw();
    atexit(sim_terminal_restore);

    while (!stop) {
        tk_device_poll(&dev);
        struct pollfd fds[3];
        nfds_t n = 0;
        fds[n++] = (struct pollfd){sim.listen_fd, POLLIN, 0};
        if (sim.client_fd >= 0) {
            fds[n++] = (struct pollfd){sim.client_fd, POLLIN, 0};
        }
        if (!sim.stdin_eof) {
            fds[n++] = (struct pollfd){STDIN_FILENO, POLLIN, 0};
        }
        poll(fds, n, 50);
        tk_button_t b;
        int k;
        while ((k = sim_read_key(&sim, &b)) != 0 /* SIM_KEY_NEED_MORE */) {
            if (k == SIM_KEY_QUIT) {
                stop = 1;
            }
            // Other keys pressed while idle do nothing.
        }
    }
    printf("taktile-sim: bye\n");
    return 0;
}
