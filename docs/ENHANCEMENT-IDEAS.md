# Enhancement ideas

Options to extend the feature set and improve the user experience of the
WhatsApp ↔ TeamSpeak/Mumble bridge. They are ranked by value for effort, and
each points to the code it would change.

## Top picks

1. **Limit who can call in.** `autoAcceptIncomingCall` (`bot/whatsapp/calls.js`)
   answers every incoming call, so anyone who calls the bridge number can listen
   to the TeamSpeak channel. Add a `BRIDGE_AUTO_ACCEPT_FROM` allowlist that takes
   numbers or contact groups, plus an option to answer only when someone is in
   the TS channel.
2. **Show call activity on the voice side.** TeamSpeak users get no sign that
   someone joined from WhatsApp. Post a channel message on join and leave, and
   show the participant count in the bridge client's nickname or description
   (e.g. `WA 📞 3`). `getLiveWhatsAppCallStatus` already returns the count.
3. **Hang up idle calls automatically.** End the call when WhatsApp has 0 other
   participants, or when the TS channel has been empty for N minutes. This
   avoids calls that stay open for hours with no one on them.
4. **Show the QR code and alert when logged out.** Add `GET /api/v1/qr` (PNG)
   and a webhook or ntfy alert when `awaitingQr` becomes `true`. Re-pairing
   would then not need noVNC or an SSH tunnel.

## Call control and UX

- `!wa call Alice`: resolve contact names from the WhatsApp address book, not
  just phone numbers.
- Store contact groups in `/data` and edit them at runtime
  (`!wa group add support +49…`) instead of using a JSON env var that needs a
  restart.
- `!wa mute in|out` and `!wa vol <n>` to adjust each direction with `pactl` on
  `ts_mic`/`wa_mic`.
- `!wa here` / `!wa join <channel>`: move the bridge into the commander's
  channel from the TeamSpeak side. Today only WhatsApp can trigger a channel
  switch, via the poll.
- An optional text relay between one WhatsApp group and the TS channel chat.

## Mumble parity

- Mumble mode has no text commands and depends on a GUI client that saves its
  settings only on a clean exit. Replacing it with a headless Mumble bot
  library (audio and text over the protocol) would add `!wa` commands. It would
  also remove the noVNC setup, the Ctrl+Q shutdown workaround and the risk of
  losing settings.

## Audio quality

- Add PulseAudio processing on both paths (`module-echo-cancel` with webrtc for
  AGC and noise suppression, or a limiter). Volume differs a lot between
  WhatsApp participants.
- Optional join/leave chimes, so the voice channel hears them through `ts_out`
  and WhatsApp through `wa_out`.

## Ops and reliability

- Add a Docker `HEALTHCHECK` that calls `/api/v1/health`. When the bot is wedged
  for a while (not ready and not waiting for a QR scan), it should restart
  Chromium.
- Add a Prometheus `/metrics` endpoint covering call duration, participant
  count, reconnects and auto-accept failures.
- Add a write API: `POST /api/v1/calls` and `DELETE /api/v1/calls/active`, so
  Home Assistant or Discord bots can drive the bridge. Put it behind a token,
  because `BRIDGE_API_HOST` defaults to `0.0.0.0` inside the container.
- **Tests:** only `tests/tile-windows` exists. Unit tests for
  `normalizeContactId`, `parseContactGroups`, `tsEscape`/`tsUnescape` and the
  channel-poll paging would be cheap and would catch regressions in the
  2.2k-line bot.

## Maintainability

- ~~Split `bot/bridge-bot.js` into modules~~ (done: `whatsapp/`, `teamspeak/`,
  `mumble/`, `audio/`, `api/`, with all env parsing in `bot/config.js`). Next
  step: a voice-backend interface, which would make Mumble parity and future
  backends (Discord, a headless TS6 client) much easier.
- The README is German-only. An English version would help outside
  contributors.

## Suggested order

Start with #1, since open auto-accept is a real privacy hole. Then do #2 and #3,
which most improve day-to-day use.
