// Internal to core/src: the CONTACT_ADD flow, called by tk_flow.c with the payload already checked
// (name passes tk_contacts_validate_name, wallet is 32 bytes) and the flow state set up (in_flow,
// flow_seq, cancel cleared). Returns the status for the CONTACT_ADD reply.

#ifndef TK_ENROLL_H
#define TK_ENROLL_H

#include <stdint.h>

#include "tk_device.h"
#include "tk_proto.h"

tk_status_t tk_enroll_run(tk_device_t *d, uint8_t name_len, const uint8_t *name, const uint8_t wallet[TK_PUBKEY_LEN]);

#endif
