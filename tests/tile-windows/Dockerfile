FROM debian:12-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb openbox tint2 xterm wmctrl x11-utils python3 procps \
 && rm -rf /var/lib/apt/lists/*
