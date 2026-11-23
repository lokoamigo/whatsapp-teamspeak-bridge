FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      nodejs openssl pulseaudio pulseaudio-utils libopus0 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 bridge
USER bridge
