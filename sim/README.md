# sim/

Host simulator: `core/` + a WebSocket server on `ws://localhost:8765` (same frames as USB serial) + keyboard buttons + audio as printed text. Get every flow working here before flashing hardware.

| Key | Button |
| --- | --- |
| Up / Down arrows | UP / DOWN |
| Enter | OK |
| Backspace | BACK |
| `c` | CONFIRM |
| `r` | REJECT |

Secret audio (checksum words, PIN digits, recovery words) is never printed unless built with `-DTK_SIM_INSECURE_AUDIO=1` for development (I2).

```bash
cmake -S sim -B build/sim && cmake --build build/sim && ./build/sim/taktile-sim
```
