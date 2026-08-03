# WhatsApp-Web ↔ TeamSpeak-Audio-Bridge

Ein einzelner Linux-Container mit:

- Chromium + WhatsApp Web
- TeamSpeak 3 Client 3.6.2
- ClientQuery-Plugin als Bot-/Fernsteuerungsschnittstelle
- zwei gekreuzten virtuellen PulseAudio-Geräten
- noVNC-Weboberfläche für QR-Code und GUI
- ChromeDriver/Selenium-Zugriff auf **dieselbe** sichtbare WhatsApp-Sitzung
- persistentem Docker-Volume für WhatsApp-Login und TeamSpeak-Konfiguration

## Audiofluss

```text
TeamSpeak-Wiedergabe -> ts_out -> ts_out.monitor -> ts_mic -> WhatsApp-Mikrofon
WhatsApp-Wiedergabe  -> wa_out -> wa_out.monitor -> wa_mic -> TeamSpeak-Mikrofon
```

Es wird keine physische Soundkarte benötigt.

## Voraussetzungen

- Docker Engine mit Docker Compose v2
- Linux-Host auf `amd64/x86_64`
- mindestens etwa 2 CPU-Kerne und 3–4 GB RAM empfohlen
- ein WhatsApp-Konto und Zugang zum gewünschten TeamSpeak-Server

## 1. Konfiguration

```bash
cp .env.example .env
nano .env
```

Mindestens ändern:

```dotenv
TS3_LICENSE_ACCEPTED=YES
VNC_PASSWORD=ein-langes-zufaelliges-passwort
```

Mit `TS3_LICENSE_ACCEPTED=YES` bestätigst du, dass du die TeamSpeak-Lizenz gelesen hast und akzeptierst. Der Build lädt den proprietären Client direkt von der offiziellen TeamSpeak-Download-Domain; das fertige Image sollte nicht öffentlich weiterverteilt werden, ohne die Lizenzbedingungen zu prüfen.

Optionaler Auto-Connect als Bot-artiger Client:

```dotenv
TS3_URI=ts3server://ts.example.org?port=9987&nickname=WhatsAppBridge
```

Passwörter, Channel-Namen und Sonderzeichen müssen in der URI URL-kodiert werden. Alternativ später im GUI verbinden und als Bookmark mit Auto-Connect speichern.

## 2. Bauen und starten

```bash
docker compose build --pull
docker compose up -d
docker compose logs -f
```

Der TeamSpeak-Installer wird beim Build vollständig nicht-interaktiv ausgeführt. Das Dockerfile speist die erforderliche RETURN-/`y`-Eingabe ein und beendet den Lizenz-Pager automatisch; bei älteren Projektständen führte diese Abfrage zu einer endlosen `Please type y to accept`-Schleife.

Status prüfen:

```bash
docker compose ps
```

Nach Änderungen an den Startskripten oder der PulseAudio-Konfiguration das Image
neu bauen und den Container vollständig ersetzen:

```bash
docker compose down
docker compose build --pull --no-cache
docker compose up -d
```

## 3. WhatsApp-QR-Code öffnen

Auf dem Docker-Host im Browser:

```text
http://127.0.0.1:6080/
```

VNC-Passwort eingeben, in Chromium den WhatsApp-QR-Code scannen und die Mikrofonfreigabe bestätigen. Durch das persistente Volume bleibt die gekoppelte WhatsApp-Sitzung bei Container-Neustarts normalerweise erhalten.

Läuft Docker auf einem entfernten Server, die Ports nicht offen ins Internet stellen. Stattdessen lokal tunneln:

```bash
ssh -L 6080:127.0.0.1:6080 \
    -L 9515:127.0.0.1:9515 \
    -L 25640:127.0.0.1:25640 \
    user@docker-host
```

Danach weiterhin `http://127.0.0.1:6080/` lokal öffnen.

## 4. TeamSpeak einrichten

Der Client startet parallel im selben noVNC-Desktop.

1. Lizenz-/Erstdialoge bestätigen.
2. Server verbinden oder `TS3_URI` verwenden.
3. Unter Audio/Capture und Playback jeweils das **Default-/PulseAudio-Gerät** verwenden.
4. Unter `Tools/Extras -> Options -> Addons/Plugins` prüfen, dass **ClientQuery** aktiv ist.
5. In den ClientQuery-Einstellungen einen API-Key erzeugen bzw. anzeigen lassen.
6. Den Key in `.env` als `TS3_CLIENTQUERY_API_KEY=...` eintragen und neu starten:

```bash
docker compose up -d --force-recreate
```

Der Plugin-Port `127.0.0.1:25639` wird im Container über `socat` auf den lokal gebundenen Host-Port `127.0.0.1:25640` weitergereicht.

Test vom Docker-Host:

```bash
nc 127.0.0.1 25640
```

Dann beispielsweise:

```text
auth apikey=DEIN_API_KEY
whoami
```

## 5. WhatsApp-Call-Bot per TeamSpeak steuern

Der Container startet Chromium jetzt über einen Node-Bot auf Basis des
gepinnten `whatsapp-web.js`-Forks mit experimenteller Web-Call-Unterstützung.
Der Bot beendet vor dem Start alte Chromium-Prozesse, entfernt nur flüchtige
Profil-Locks und öffnet WhatsApp Web anschließend frisch im persistenten Profil.
So entsteht nicht mehr neben einem vorhandenen WhatsApp-Web-Fenster ein zweites
wwebjs-Fenster.

Der Chromium-Debug-Port `9222` bleibt aktiv; ChromeDriver/Selenium hängen sich
weiterhin an diese eine sichtbare Browser-Instanz.

Voraussetzung ist ein gesetzter `TS3_CLIENTQUERY_API_KEY`. Ohne Key bleibt der
TeamSpeak-Kommandokanal deaktiviert; WhatsApp Web startet trotzdem sichtbar,
damit QR-Code, Login und Audio weiterhin funktionieren.

Optional kannst du die Steuerung auf konkrete TeamSpeak-Identitäten begrenzen:

```dotenv
BRIDGE_COMMAND_PREFIX=!wa
BRIDGE_COMMANDER_UIDS=abcDEFghiJklMNOpqrSTUvwxYz=,zweiteUid=
```

Bleibt `BRIDGE_COMMANDER_UIDS` leer, darf jeder TeamSpeak-Nutzer Befehle
ausführen, der den Bridge-Client per Textnachricht erreichen kann.

Private Textnachricht an den TeamSpeak-Bridge-Client:

```text
!wa help
!wa status
!wa add +491701234567
!wa add +491701234567 +491761234567
!wa call +491701234567
!wa groupcall +491701234567 +491761234567
!wa hangup
```

`!wa add ...` lädt ausschließlich die ausdrücklich genannten Nummern in den
aktuell aktiven WhatsApp-Anruf ein. Nummern werden auf WhatsApp-IDs im Format
`<digits>@c.us` normalisiert; Gruppen-IDs werden abgewiesen.

## 6. Selenium verwenden

Die sichtbare Chromium-Sitzung läuft mit Remote Debugging auf Port 9222. ChromeDriver ist auf dem lokal gebundenen Host-Port 9515 verfügbar und verbindet Selenium mit genau dieser Sitzung.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install selenium
python automation/selenium_attach.py
```

Das Beispiel zeigt Titel/URL an und speichert einen Screenshot. Bei eigenen Skripten `driver.quit()` mit Vorsicht verwenden, weil dadurch die gekoppelte sichtbare Browser-Sitzung beendet werden kann.

## Diagnose

Die folgenden Meldungen aus älteren Builds wurden korrigiert:

- `_XSERVTransmkdir: euid != 0`: `/tmp/.X11-unix` wird jetzt vor Xvfb als `root:root` mit Modus `1777` angelegt.
- PulseAudio-Fehler zu `/run/dbus/system_bus_socket`, `RLIMIT_NICE` oder `RTPRIO`: PulseAudio startet jetzt mit einer minimalen, hardwarefreien Konfiguration ohne D-Bus- und Realtime-Probes.
- Supervisor-Warnungen zu Root und fehlender HTTP-Authentifizierung: Root-Betrieb ist explizit deklariert und der lokale Unix-Socket ist authentifiziert.

Prozessstatus:

```bash
docker compose exec bridge supervisorctl status
```

Virtuelle Geräte:

```bash
docker compose exec -u bridge bridge pactl list short sinks
docker compose exec -u bridge bridge pactl list short sources
```

Erwartet werden mindestens:

```text
ts_out
wa_out
ts_out.monitor
wa_out.monitor
ts_mic
wa_mic
```

PulseAudio-Ströme prüfen:

```bash
docker compose exec -u bridge bridge pactl list short sink-inputs
docker compose exec -u bridge bridge pactl list short source-outputs
```

Grafischen Audiomixer öffnen:

```bash
docker compose exec -d -u bridge bridge \
  env DISPLAY=:99 PULSE_SERVER=unix:/tmp/runtime-bridge/pulse/native pavucontrol
```

### Kein ClientQuery-Port

Im TeamSpeak-GUI prüfen, ob das Plugin aktiviert ist. Anschließend TeamSpeak oder den Container neu starten. Das Plugin lauscht intern standardmäßig auf `127.0.0.1:25639`; der Container-Relay erscheint außen als Port `25640`.

### Kein Ton in einer Richtung

Im noVNC-Desktop `pavucontrol` öffnen und prüfen:

- Chromium-Wiedergabe muss auf `WhatsApp_to_TeamSpeak`/`wa_out` liegen.
- Chromium-Aufnahme muss `TeamSpeak_to_WhatsApp_Microphone`/`ts_mic` nutzen.
- TeamSpeak-Wiedergabe muss auf `TeamSpeak_to_WhatsApp`/`ts_out` liegen.
- TeamSpeak-Aufnahme muss `WhatsApp_to_TeamSpeak_Microphone`/`wa_mic` nutzen.

Die Startskripte setzen diese Zuordnung per `PULSE_SINK` und `PULSE_SOURCE`; die sichtbaren Mikrofone sind normale PulseAudio-Remap-Sources, damit Chromium und TeamSpeak sie als Eingabegeräte erkennen. Manche GUI-Profile speichern jedoch eine zuvor manuell gewählte Hardwarequelle und müssen einmal auf „Default“ zurückgestellt werden.

## Wichtige Grenzen

- Das ist eine bidirektionale Telefon-/VoIP-Brücke. Teilnehmer können ihr eigenes Signal zeitversetzt zurückbekommen; Echo und Rückkopplung sind möglich. Headsets, Push-to-Talk oder eine moderierte Halbduplex-Nutzung helfen.
- WhatsApp-Web-DOM und Medienverhalten können sich jederzeit ändern. UI-Automatisierung ist dadurch grundsätzlich wartungsanfällig.
- Automatisiere keine unerwünschten Nachrichten, kein Spam und keine Massenkontakte. Für reguläre geschäftliche Nachrichtenautomation ist die offizielle WhatsApp Business Platform die stabilere Lösung.
- noVNC, ChromeDriver und ClientQuery sind mächtige Fernsteuerungsschnittstellen. Die Compose-Datei bindet sie deshalb standardmäßig nur an `127.0.0.1`.

## Laufzeitfix: Chromium-Profillock, TeamSpeak `libpci.so.3`, PulseAudio-Race

Bei persistenten Docker-Volumes können Chromium-Lockdateien aus einer vorherigen
Containerinstanz erhalten bleiben. Da sie den alten Container-Hostnamen und eine
alte PID enthalten, verweigert Chromium danach den Start mit
`The profile appears to be in use by another Chromium process`.

Diese Version entfernt beim Containerstart ausschließlich folgende flüchtige
Chromium-Dateien; Cookies, WhatsApp-Login und das restliche Profil bleiben erhalten:

- `SingletonLock`
- `SingletonSocket`
- `SingletonCookie`
- `DevToolsActivePort`

Zusätzlich installiert das Image `libpci3`, das der TeamSpeak-3-Client als
`libpci.so.3` benötigt. Während des Builds wird nun mit `ldd` geprüft, ob noch
eine direkt verlinkte TeamSpeak-Laufzeitbibliothek fehlt. Der Build bricht dann
mit der konkreten Liste ab, statt erst beim Containerstart zu scheitern.

PulseAudio-Autospawn ist global deaktiviert. Dadurch können `pactl`, der
Audio-Router und die Anwendungs-Warteskripte beim parallelen Start keinen zweiten
PulseAudio-Daemon erzeugen. Veraltete Runtime-Sockets werden vor dem Start des
verwalteten PulseAudio-Prozesses entfernt.

Nach dem Aktualisieren der Dateien ist ein Image-Neubau erforderlich:

```bash
docker compose down
docker compose build --pull --no-cache
docker compose up -d
docker compose logs -f bridge
```

Das benannte `/data`-Volume bleibt dabei erhalten. Nicht `docker compose down -v`
verwenden, wenn die bestehende WhatsApp-Sitzung erhalten bleiben soll.

Anschließend prüfen:

```bash
docker compose exec bridge supervisorctl status
```

`chromium`, `teamspeak`, `pulseaudio` und `chromedriver` sollten nach einigen
Sekunden jeweils `RUNNING` anzeigen.
