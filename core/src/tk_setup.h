// Internal to core/src: the SETUP flow, called by tk_flow.c with the flow state already set up
// (in_flow, flow_seq, cancel cleared). Returns the status for the SETUP reply.

#ifndef TK_SETUP_H
#define TK_SETUP_H

#include "tk_device.h"
#include "tk_proto.h"

tk_status_t tk_setup_run(tk_device_t *d);

#endif
