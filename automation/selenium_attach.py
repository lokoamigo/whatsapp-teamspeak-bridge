#!/usr/bin/env python3
"""An die bereits sichtbare WhatsApp-Chromium-Sitzung im Container anhängen.

Installation auf dem Docker-Host:
    python3 -m pip install selenium

Aufruf:
    python3 automation/selenium_attach.py
"""

from __future__ import annotations

from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

CHROMEDRIVER_URL = "http://127.0.0.1:9515"

options = Options()
# Dieser Hostname wird von ChromeDriver *im Container* ausgewertet.
options.add_experimental_option("debuggerAddress", "127.0.0.1:9222")

driver = webdriver.Remote(command_executor=CHROMEDRIVER_URL, options=options)
try:
    print(f"Titel: {driver.title}")
    print(f"URL:   {driver.current_url}")
    print(f"Tabs:  {len(driver.window_handles)}")

    output = Path("whatsapp-current.png")
    driver.save_screenshot(str(output))
    print(f"Screenshot gespeichert: {output.resolve()}")
finally:
    # Nicht driver.quit(): Das würde unter Umständen die sichtbare Sitzung schließen.
    pass
