#!/usr/bin/env python3
"""Kleiner Bot-Watchdog für das TeamSpeak-ClientQuery-Plugin.

Er authentifiziert sich optional mit TS3_CLIENTQUERY_API_KEY und prüft zyklisch
mit `whoami`, ob die Bot-/Fernsteuerungsschnittstelle lebt. Die eigentliche
Serververbindung des TS-Clients wird über TS3_URI aufgebaut.
"""

from __future__ import annotations

import os
import socket
import time

HOST = "127.0.0.1"
PORT = 25639
API_KEY = os.getenv("TS3_CLIENTQUERY_API_KEY", "").strip()


def recv_some(sock: socket.socket) -> str:
    sock.settimeout(2.0)
    chunks: list[bytes] = []
    try:
        while True:
            data = sock.recv(4096)
            if not data:
                break
            chunks.append(data)
            if b"error id=" in b"".join(chunks):
                break
    except TimeoutError:
        pass
    return b"".join(chunks).decode("utf-8", errors="replace")


def command(sock: socket.socket, text: str) -> str:
    sock.sendall((text + "\n").encode("utf-8"))
    return recv_some(sock)


def run_once() -> None:
    with socket.create_connection((HOST, PORT), timeout=5) as sock:
        banner = recv_some(sock).strip().replace("\n", " | ")
        if banner:
            print(f"ClientQuery: {banner}", flush=True)

        if not API_KEY:
            print("ClientQuery-Watchdog: Plugin erreichbar; API-Key noch nicht gesetzt.", flush=True)
            return

        response = command(sock, f"auth apikey={API_KEY}")
        if "error id=0" not in response:
            raise RuntimeError(f"ClientQuery-Authentifizierung fehlgeschlagen: {response!r}")

        response = command(sock, "whoami")
        if "error id=0" not in response:
            raise RuntimeError(f"ClientQuery whoami fehlgeschlagen: {response!r}")
        print("ClientQuery-Watchdog: authentifiziert und OK", flush=True)


if __name__ == "__main__":
    while True:
        try:
            run_once()
            time.sleep(30)
        except (OSError, RuntimeError) as exc:
            print(f"ClientQuery-Watchdog wartet: {exc}", flush=True)
            time.sleep(5)
