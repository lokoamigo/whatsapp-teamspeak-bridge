FROM debian:12-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG TS3_VERSION=3.6.2
ARG TS3_LICENSE_ACCEPTED=NO
ARG CLIENTQUERY_PLUGIN_URL=https://addons-content.teamspeak.com/943dd816-7ef2-48d7-82b8-d60c3b9b10b3/files/10/clientquerypluginlinuxamd64_649166b4af7f6.ts3_plugin

ENV DISPLAY=:99 \
    HOME=/data/home \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_RUNTIME_DIR=/tmp/runtime-bridge \
    PULSE_SERVER=unix:/tmp/runtime-bridge/pulse/native \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN test "$TS3_LICENSE_ACCEPTED" = "YES" || \
    (echo >&2 "Build abgebrochen: TeamSpeak-Lizenz zuerst lesen und mit --build-arg TS3_LICENSE_ACCEPTED=YES bestätigen."; exit 1)

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget unzip bzip2 xz-utils less tini tzdata \
      git nodejs npm \
      chromium chromium-driver \
      xvfb x11vnc x11-xserver-utils xauth openbox xterm \
      novnc websockify \
      pulseaudio pulseaudio-utils pavucontrol alsa-utils \
      dbus-x11 supervisor socat netcat-openbsd \
      python3 python3-selenium \
      fonts-liberation fonts-noto-color-emoji \
      libasound2 libdbus-1-3 libevent-2.1-7 libglib2.0-0 libnss3 libxss1 \
      libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
      libxext6 libxfixes3 libxi6 libxkbcommon0 libxkbcommon-x11-0 \
      libxrandr2 libxrender1 libxtst6 libxcb-keysyms1 libxcb-image0 \
      libxcb-render-util0 libxcb-icccm4 libxcb-xinerama0 libxcb-xkb1 \
      libxcb-util1 libpulse0 libopengl0 libgl1 libunwind8 libpci3 \
      libxslt1.1 libatomic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/whatsapp-teamspeak-bridge
COPY package.json package-lock.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --omit=dev

# TeamSpeak 3 wird von der offiziellen Download-Domain geladen. Das Build-Argument
# dient als ausdrückliche Zustimmung; die erwarteten Installer-Eingaben werden danach
# reproduzierbar über stdin eingespeist. LESS=+q beendet den Lizenz-Pager sofort.
RUN set -eux; \
    curl -fL --retry 5 --retry-delay 2 \
      -o /tmp/teamspeak.run \
      "https://files.teamspeak-services.com/releases/client/${TS3_VERSION}/TeamSpeak3-Client-linux_amd64-${TS3_VERSION}.run"; \
    chmod +x /tmp/teamspeak.run; \
    mkdir -p /tmp/teamspeak-extract /opt/teamspeak3; \
    printf '\ny\n' | LESS='+q' /tmp/teamspeak.run \
      --nox11 --noexec --target /tmp/teamspeak-extract; \
    TS3_SCRIPT="$(find /tmp/teamspeak-extract -type f -name ts3client_runscript.sh -print -quit)"; \
    test -n "$TS3_SCRIPT"; \
    cp -a "$(dirname "$TS3_SCRIPT")"/. /opt/teamspeak3/; \
    chmod +x /opt/teamspeak3/ts3client_runscript.sh /opt/teamspeak3/ts3client_linux_amd64; \
    ldd /opt/teamspeak3/ts3client_linux_amd64 | tee /tmp/teamspeak-ldd.txt; \
    if grep -q "not found" /tmp/teamspeak-ldd.txt; then \
      echo >&2 "TeamSpeak hat nicht aufgelöste Laufzeitbibliotheken:"; \
      grep >&2 "not found" /tmp/teamspeak-ldd.txt; \
      exit 1; \
    fi; \
    rm -rf /tmp/teamspeak.run /tmp/teamspeak-extract /tmp/teamspeak-ldd.txt

# ClientQuery ist die Bot-/Fernsteuerungs-Schnittstelle des TS3-Clients.
# .ts3_plugin ist ein ZIP-Container; die Plugin-Dateien werden global installiert.
RUN set -eux; \
    curl -fL --retry 5 --retry-delay 2 -o /tmp/clientquery.ts3_plugin "$CLIENTQUERY_PLUGIN_URL"; \
    mkdir -p /tmp/clientquery /opt/teamspeak3/plugins; \
    unzip -q /tmp/clientquery.ts3_plugin -d /tmp/clientquery; \
    test -d /tmp/clientquery/plugins; \
    cp -a /tmp/clientquery/plugins/. /opt/teamspeak3/plugins/; \
    test -f /opt/teamspeak3/plugins/libclientquery_plugin_linux_amd64.so; \
    rm -rf /tmp/clientquery /tmp/clientquery.ts3_plugin

RUN useradd --create-home --uid 1000 --shell /bin/bash bridge \
    && mkdir -p /data /tmp/runtime-bridge /var/log/supervisor \
    && chown -R bridge:bridge /data /tmp/runtime-bridge /var/log/supervisor \
    && chmod 0700 /tmp/runtime-bridge \
    && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

COPY bot/ ./bot/
COPY rootfs/ /
RUN chmod +x /usr/local/bin/*

VOLUME ["/data"]
EXPOSE 6080 9515 25640

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null \
   && curl -fsS http://127.0.0.1:9222/json/version >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/container-entrypoint"]
