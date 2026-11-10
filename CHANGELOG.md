# Changelog

All notable changes to this project will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Versions remain
under `0.y.z` while the public behavior and configuration may change without
backward compatibility guarantees.

## [Unreleased]

## [0.1.1]

### Fixed

- `bridge-bot` no longer crash-loops after WhatsApp ends the linked-device
  session. The pinned `whatsapp-web.js` fork (`4aa5506`) no longer leaves
  unhandled promise rejections in its `framenavigated` handler, which killed
  the bot on every start with `Execution context was destroyed`. It also
  reports `LOGOUT` once per logout instead of once per navigation.
- After a logout the bot keeps Chromium open on the WhatsApp QR screen, logs
  how to re-link the device via noVNC, and resumes its ready detection once
  the device is linked again.
- A failed WhatsApp readiness check during startup no longer aborts the bot.

### Added

- `awaitingQr` in `GET /api/v1/health` and `!wa status` while WhatsApp waits
  for a QR scan.
- A process-level `unhandledRejection` guard: Puppeteer navigation races are
  logged and ignored; any other unhandled rejection still exits so supervisor
  restarts the bot.

### Changed

- Supervisor retries `bridge-bot` up to 50 times before marking it `FATAL`.

## [0.1.0]

### Added

- Project version validation and bump tooling.
- Runtime version reporting through `GET /api/v1/health`.
- GitHub Actions validation and automated GitHub Releases for version tags.
- Initial development release.

[Unreleased]: https://github.com/lokoamigo/whatsapp-teamspeak-bridge/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/lokoamigo/whatsapp-teamspeak-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lokoamigo/whatsapp-teamspeak-bridge/releases/tag/v0.1.0
