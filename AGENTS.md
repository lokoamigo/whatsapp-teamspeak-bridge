# AGENTS.md

Hinweise fuer Coding-Agents in diesem Repository.

## Projektkontext

Dieses Projekt baut einen einzelnen Docker-Container als WhatsApp-Web-zu-TeamSpeak-Audio-Bridge. Im Container laufen Chromium/WhatsApp Web, TeamSpeak 3 Client, ClientQuery, PulseAudio, Xvfb, noVNC und ein Node-Bot auf Basis eines gepinnten `whatsapp-web.js`-Forks.

Der Node-Bot in `bot/bridge-bot.js` ist der Besitzer der sichtbaren Chromium-Instanz. Keine zweite Selenium-, ChromeDriver- oder parallele Browsersteuerung einfuehren.

## Wichtige Sicherheitsregeln

- Keine persistenten WhatsApp- oder TeamSpeak-Daten loeschen.
- Niemals `docker compose down -v` ausfuehren.
- Das Docker-Volume `bridge-data` enthaelt Login-, Profil- und TeamSpeak-Konfigurationsdaten und muss erhalten bleiben.
- `.env` kann echte Secrets enthalten. Werte daraus nicht in Antworten, Logs, Commits oder Dokumentation uebernehmen.
- Keine unaufgeforderten destruktiven Git-Kommandos wie `git reset --hard` oder `git checkout -- <file>` verwenden.

## Wichtige Dateien

- `Dockerfile`: Multi-Stage-Build. `node-deps` installiert Node-Abhaengigkeiten; die Runtime enthaelt Node, Chromium, TeamSpeak, PulseAudio, Supervisor und noVNC, aber kein npm/git.
- `docker-compose.yml`: Container-Konfiguration, persistentes Volume, noVNC-Port `6080`, ClientQuery-Relay-Port `25640`.
- `bot/bridge-bot.js`: TeamSpeak-Textbefehle und WhatsApp-Web-Call-Automation.
- `rootfs/etc/pulse/bridge.pa`: Virtuelle PulseAudio-Geraete und Audio-Routen.
- `rootfs/etc/supervisor/conf.d/bridge.conf`: Prozessliste fuer Supervisor.
- `rootfs/usr/local/bin/start-*`: Startskripte fuer die einzelnen Dienste.
- `README.md`: Bedienung, Audiofluss und Diagnose.

## TeamSpeak-Befehle

Der Standard-Prefix ist `!wa`.

- `!wa status`: WhatsApp-/Bot-Status.
- `!wa accept`: Eingehenden WhatsApp-Anruf annehmen, falls die aktuelle WhatsApp-Web-Version eine passende interne Accept-/Answer-Methode bereitstellt.
- `!wa call <nummer|kontaktgruppe> [...mehr]`: Neuen WhatsApp-Call starten. Wenn bereits ein Call laeuft, automatisch Teilnehmer zum aktiven Call hinzufuegen.
- `!wa callgroup <kontaktgruppe>` / `!wa groupcall ...`: Gruppen-Call mit mehreren einzelnen Kontakten starten.
- `!wa add <nummer> [...mehr]`: Kontakte zum aktiven WhatsApp-Call einladen.
- `!wa hangup`: Aktiven Call beenden.

`BRIDGE_CONTACT_GROUPS` ist eine JSON-Map aus lokal benannten Gruppen auf Telefonnummern, z. B. `{"support":["+491701234567","+491761234567"]}`. Das sind keine WhatsApp-Chatgruppen; `@g.us` bleibt absichtlich abgewiesen.

## Audio-Routing

Erwarteter Audiofluss:

```text
TeamSpeak-Wiedergabe -> ts_out -> ts_out.monitor -> ts_mic -> WhatsApp-Mikrofon
WhatsApp-Wiedergabe  -> wa_out -> wa_out.monitor -> wa_mic -> TeamSpeak-Mikrofon
```

Typische GUI-Einstellungen:

- TeamSpeak Playback: `whatsapp_to_teamspeak`
- TeamSpeak Capture: `whatsapp_to_teamspeak_Microphone`
- WhatsApp/Chromium Microphone: `teamspeak_to_whatsapp_Microphone`

## Validierung

Nach Codeaenderungen am Bot:

```bash
node --check bot/bridge-bot.js
docker compose config
docker compose up -d --force-recreate --build
docker compose ps
docker compose exec bridge supervisorctl status
```

Nach PulseAudio-/Routing-Aenderungen zusaetzlich:

```bash
docker compose exec -u bridge bridge pactl list short sinks
docker compose exec -u bridge bridge pactl list short sources
docker compose exec -u bridge bridge pactl list short sink-inputs
docker compose exec -u bridge bridge pactl list short source-outputs
```

Runtime-Image grob pruefen:

```bash
docker compose exec bridge sh -lc 'command -v node'
docker compose exec bridge sh -lc 'command -v npm'
docker compose exec bridge sh -lc 'command -v git'
```

Fuer das aktuelle Multi-Stage-Image ist `node` erwartet, `npm` und `git` in der Runtime nicht.

## Build-/Betriebshinweise

- Fuer normale Aenderungen `docker compose up -d --force-recreate --build` verwenden.
- Kein Volume-Reset fuer Tests.
- noVNC ist lokal auf `127.0.0.1:6080` gebunden.
- ClientQuery ist extern als `127.0.0.1:25640` erreichbar und wird intern zum TeamSpeak-Plugin-Port weitergeleitet.
- WhatsApp-Web-Call-Funktionen sind von internen WhatsApp-Web-APIs abhaengig. Bei Call-Automation defensive Fehlertexte bevorzugen und nicht stillschweigend falsches Verhalten annehmen.
