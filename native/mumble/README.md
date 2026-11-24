# Native Mumble audio and chat

`bridge-mumble` replaces the Mumble GUI and its separate command account when
`BRIDGE_VOICE_BACKEND=mumble` and `BRIDGE_MUMBLE_CLIENT=native`. GUI remains the
default and is available in the same image for rollback. See the root README
for migration, certificate import, settings, and operator commands.

The helper owns one Mumble TLS/UDP session. Node owns WhatsApp and handles the
existing commands over a mode-0600 Unix socket in a mode-0700 runtime directory.
Only one command consumer can attach; independent status peers are bounded.
Voice capture and playback use dedicated threads and explicit PulseAudio
devices (`wa_mic` and `ts_out`), so default-device microphone nudges cannot
change this client's routing. The combined `teamspeak-mumble` backend selects
the same helper and identity with dedicated devices `mumble_mic` and `mumble_out`.

The protocol dependency is pinned to
`Mumcord/mumble-client-protocol@3d883aa4d8d9a1b8910dc4fb6b8bdf8cff788503`.
`Cargo.lock` pins transitive dependencies. The Docker builder uses Rust 1.93
on Bookworm and links the runtime's `libopus` and `libpulse-simple`. The runtime
contains the binary and library dependencies, without Cargo or Rust tooling.
The upstream protocol supports legacy and protobuf voice packets, encrypted
UDP, and automatic TCP fallback. The helper supplies Opus, jitter buffering,
mixing, persistent identity, server pinning, and the local control interface.

## Build and tests

```sh
# The build stage runs rustfmt, unit tests, Clippy, then a release build.
docker build --target mumble-native-build -t bridge-mumble-native-build:local .
mkdir -p native/mumble/target/release
docker create --name bridge-native-artifact bridge-mumble-native-build:local
docker cp bridge-native-artifact:/build/target/release/bridge-mumble native/mumble/target/release/bridge-mumble
docker rm bridge-native-artifact
bash tests/mumble-native/run.sh
BRIDGE_TEST_THREE_WAY=1 bash tests/mumble-native/run.sh
```

The end-to-end runner creates an internal Docker network and disposable Mumble
and audio-test containers; no production data or published ports are used.
It tests identity migration, one-account chat and authorization, channel moves,
UDP/TCP transport, synthetic two-way PCM, simultaneous speakers, restart
recovery, changed certificate rejection, and bounded memory. `BRIDGE_TEST_IMAGE`
selects another compatible Bookworm image; `MUMBLE_SERVER_IMAGE` selects a
server version for compatibility testing (default: pinned Mumble 1.5.939,
matching the infrastructure deployment). With no test image present, the
runner builds the small fixture image in `tests/mumble-native/Dockerfile`.

On a compatible native development host, install Rust 1.93+, `libopus-dev`,
`libpulse-dev`, OpenSSL, and pkg-config, then run:

```sh
cargo fmt --manifest-path native/mumble/Cargo.toml -- --check
cargo test --locked --manifest-path native/mumble/Cargo.toml
cargo clippy --locked --manifest-path native/mumble/Cargo.toml -- -D warnings
cargo build --release --locked --manifest-path native/mumble/Cargo.toml
```

## Bounds and recovery

- 20-ms, 48-kHz mono frames; 120-ms initial receive jitter buffer so delayed
  speech has time to arrive. Late multi-frame packets can still contribute
  their unplayed audio, and the mixer keeps buffered speech across packet gaps.
  PulseAudio paces playback with an 80-ms target buffer and a 60-ms prebuffer.
- Capture transmits only above roughly -50 dBFS RMS, with 20 ms of lead-in
  and a 300-ms release. Silence sends a Mumble transmission terminator and
  stops Opus encoding; `transmitting` in status reports current sound activity.
- At most 32 speakers and 24 encoded packets per speaker; speaker state expires
  after two seconds without packets. Late/duplicate packets are discarded.
- Bounded capture, playback, RPC, event and IPC queues. A stalled control link
  is disconnected rather than retaining unlimited audio. Delayed audio is
  dropped instead of replaying after a stall.
- Packet-loss concealment is limited; Opus decoders stay separate per speaker.
  Mixed samples saturate to signed 16-bit PCM.
- Network reconnect uses bounded backoff. PulseAudio stream failures reopen
  independently. Channel and connection changes discard old jitter buffers.
- Server mute/deafen/suppress state is respected. Audio starts only after the
  configured initial channel has been confirmed.

`bridge-mumble --status` works independently of Node and exits nonzero if the
Mumble connection or either PulseAudio stream is unavailable. No HTTP listener
or externally accessible control port is added.
