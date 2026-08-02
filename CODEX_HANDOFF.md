Projekt: whatsapp-teamspeak-bridge

Ziel:
Ein Docker-Container soll Chromium mit WhatsApp Web und den TeamSpeak-3-Client parallel ausführen. Die Audioausgabe von TeamSpeak soll als Mikrofoneingang für WhatsApp dienen; die Audioausgabe von WhatsApp soll als Mikrofoneingang für TeamSpeak dienen. WhatsApp Web soll über noVNC sichtbar sein, damit der QR-Code gescannt werden kann. Chromium soll über ChromeDriver/Selenium fernsteuerbar sein. TeamSpeak soll mit ClientQuery-Plugin als botartig steuerbarer Client laufen.

Architektur:

* Debian 12 slim
* supervisord als Prozessmanager
* Xvfb :99
* Openbox
* x11vnc auf 5900
* noVNC auf 6080
* Chromium mit persistentem Profil unter /data/chromium
* ChromeDriver auf 9515
* TeamSpeak 3 Client 3.6.2 unter /opt/teamspeak3
* PulseAudio im Benutzerkontext bridge
* Virtuelle Null-Sinks:

  * ts_out; ts_out.monitor wird WhatsApp-Mikrofon
  * wa_out; wa_out.monitor wird TeamSpeak-Mikrofon
* ClientQuery lokal auf 25639, optionaler Relay-Port 25640
* Persistente Daten unter /data

Bisher behobene Probleme:

1. TeamSpeak-.run-Installer blieb interaktiv bei der Lizenzabfrage.

Lösung:
printf '\ny\n' | LESS='+q' /tmp/teamspeak.run --nox11 --noexec --target /tmp/teamspeak-extract

2. Xvfb konnte /tmp/.X11-unix nicht anlegen.

Lösung:
Das Verzeichnis vor dem Benutzerwechsel als root:root mit Modus 1777 anlegen und alte X-Sockets beziehungsweise Lockdateien entfernen.

3. PulseAudio erzeugte D-Bus-, Realtime- und Cookie-Warnungen.

Lösung:
Minimale containergeeignete PulseAudio-Konfiguration, kein Hardware-Detect, kein D-Bus, kein Realtime/Nice, anonymer Unix-Socket und autospawn=no.

4. TeamSpeak startete nicht:

./ts3client_linux_amd64: error while loading shared libraries: libpci.so.3

Lösung:
Debian-Paket libpci3 installieren.

Zusätzlich beim Build:
ldd /opt/teamspeak3/ts3client_linux_amd64

Bei fehlenden Bibliotheken soll der Build abbrechen.

5. Chromium startete nicht:

The profile appears to be in use by another Chromium process.

Ursache:
Persistente Singleton-Lockdateien aus einer alten Containerinstanz.

Lösung:
Vor Chromium-Start ausschließlich folgende flüchtige Dateien entfernen:

/data/chromium/SingletonLock
/data/chromium/SingletonSocket
/data/chromium/SingletonCookie
/data/chromium/DevToolsActivePort

Cookies und WhatsApp-Login nicht löschen.

6. PulseAudio meldete:

bind(): Address already in use

Ursache:
pactl konnte während des parallelen Starts einen zweiten PulseAudio-Daemon autostarten.

Lösung:
autospawn=no setzen und pactl erst verwenden, nachdem /tmp/runtime-bridge/pulse/native existiert.

Letzter Diagnosezustand vor Fix v3:

* xvfb RUNNING
* pulseaudio RUNNING
* audio-router RUNNING
* openbox RUNNING
* x11vnc RUNNING
* novnc RUNNING
* chromedriver RUNNING, wartete jedoch auf den Chromium-Debug-Port
* chromium FATAL wegen Singleton-Profillock
* teamspeak FATAL wegen fehlendem libpci.so.3
* PulseAudio-Sinks vorhanden:

  * ts_out
  * wa_out
* PulseAudio-Sources vorhanden:

  * ts_out.monitor
  * wa_out.monitor
* /tmp/.X11-unix war root:root 1777

Aktuell bereitgestellte korrigierte Projektversion:

* whatsapp-teamspeak-bridge-fix-v3.zip
* whatsapp-teamspeak-bridge-fix-v3.tar.gz
* whatsapp-teamspeak-bridge-fix.patch
* whatsapp-teamspeak-bridge-fix-v3.sha256

Empfohlener Neustart:

docker compose down
docker compose build --pull --no-cache
docker compose up -d
docker compose logs -f bridge

Nicht verwenden:

docker compose down -v

Dadurch würde das persistente /data-Volume inklusive WhatsApp-Profil gelöscht.

Erwartete Kontrolle:

docker compose exec bridge supervisorctl status

Erwartet:

* chromium RUNNING
* teamspeak RUNNING
* pulseaudio RUNNING
* chromedriver RUNNING

Fehlerprüfung:

docker compose logs --tail=200 bridge | grep -E 'not found|profile appears|Address already in use'

Der Befehl soll keine Treffer liefern.

Wichtiger Hinweis:
Ein Hashwert allein enthält keinen Kontext und kann von Codex nicht zurückgerechnet werden. Er dient nur zur Integritätsprüfung dieses Textblocks.
