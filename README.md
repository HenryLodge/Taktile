# Taktile

**A hardware wallet you can use without seeing a screen or trusting your computer.**

Built for the UBC 2026 Hackathon · Consumer Applications track · Best use of Solana · ElevenLabs bounty

> Demo video: <link> · Devpost: <link>

## What it is

<2–3 sentences: the problem (hardware wallets depend on a screen blind users can't read), what Taktile does, and the one-line security claim.>

## How it works

<Architecture diagram or link to docs/ARCHITECTURE.md. Walk through the send flow in 5–6 steps.>

## Security model

- The laptop is untrusted. The device parses raw transactions itself and speaks the real amount and recipient through a private earpiece.
- Recipients are resolved address → name from the device's own contact book; anything else is announced as "unknown recipient."
- PIN entry uses a private random start digit, so watching button presses reveals nothing.
- Firmware enforces spending caps, a rolling 24 h limit, and limits on new contacts.
- **Limitations (honest list):** <no secure element; time from a single team-run signer; devnet only; only SOL and USDC transfers.>

Full details: [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)

## How we use Solana

- Network: devnet
- Programs used (we deploy none): System Program `11111111111111111111111111111111`, SPL Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, Associated Token Account `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`
- Devnet USDC mint: `<verified address>`
- <What the device parses and why; on-device ATA derivation; Ed25519 signing with SLIP-10 path m/44'/501'/0'/0'.>

## How we use ElevenLabs

- **Speech to Text:** <how voice commands are captured>
- **Text to Speech:** every word the device speaks was generated with ElevenLabs and stored on the device; the app also speaks its own checksum phrase as a second channel
- <Agents, if used>

## Hardware

<Parts list and photo. Link to docs/HARDWARE.md.>

## Setup

```bash
# prerequisites: ESP-IDF v5.x, Node 20+, CMake, Chrome
git clone <repo> && cd taktile
cp server/.env.example server/.env   # add ELEVENLABS_API_KEY and voice ID
<build + flash + run steps>
```

## What's next

<Secure element; multi-server time; NFC contact exchange; enclosure; mainnet.>

## Credits

<Team. PGP word list attribution. trezor-crypto (MIT).>
