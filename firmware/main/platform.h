// The firmware's tk_platform_t and (until the Day 5-6 key store) a no-wallet tk_wallet_ops_t.

#ifndef TK_FW_PLATFORM_H
#define TK_FW_PLATFORM_H

#include "tk_platform.h"
#include "tk_wallet.h"

extern const tk_platform_t TK_FW_PLATFORM;
extern const tk_wallet_ops_t TK_FW_NO_WALLET;

#endif
