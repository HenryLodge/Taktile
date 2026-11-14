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
- No spending limits: the user is in control of every transaction. The device's job is to tell the truth and require a PIN plus a physical CONFIRM.
- New contacts are verified with an 8-word address phrase read out on the device and by the contact.
- **Limitations (honest list):** <no secure element; no defense against coercion or scams beyond accurate announcements; devnet only; only SOL and USDC transfers.>

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

<Secure element; NFC contact exchange; enclosure; mainnet.>

## Credits

<Team.>

- **PGP word list** (checksum phrase words) by Patrick Juola and Philip Zimmermann, 1995. See Juola & Zimmermann, "Whole-word phonetic distances and the PGPfone alphabet", ICSLP 96. Our copy comes from [magic-wormhole](https://github.com/magic-wormhole/magic-wormhole) (MIT), transcribed by Warren Guy.
- **trezor-crypto** (MIT).
