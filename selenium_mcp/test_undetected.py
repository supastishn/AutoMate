#!/usr/bin/env python3
"""
Test script for undetected-chromedriver with Xvfb integration.
"""

import undetected_chromedriver as uc
from selenium_stealth import stealth
from pyvirtualdisplay import Display
import time


def test_undetected():
    print("Starting Xvfb display...")
    display = Display(visible=False, size=(1920, 1080))
    display.start()

    print("Initializing undetected Chrome...")
    chrome_options = uc.ChromeOptions()
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1920,1080")

    # Specify chromium-browser binary
    chrome_options.binary_location = "/usr/sbin/chromium-browser"

    # Let undetected-chromedriver handle the patching automatically
    driver = uc.Chrome(
        options=chrome_options,
        driver_executable_path="/usr/sbin/chromedriver",
        use_subprocess=True,
    )

    print("Applying selenium-stealth...")
    stealth(
        driver,
        languages=["en-US", "en"],
        vendor="Google Inc.",
        platform="Win32",
        webgl_vendor="Intel Inc.",
        renderer="Intel Iris OpenGL Engine",
        fix_hairline=True,
    )

    print("Testing on bot detection site...")
    driver.get("https://nowsecure.nl")
    time.sleep(5)

    print("Page title:", driver.title)

    # Check for bot detection
    page_source = driver.page_source.lower()
    if "bot" in page_source and "detected" in page_source:
        print("❌ Bot detected!")
    else:
        print("✅ Successfully passed bot detection!")

    driver.quit()
    display.stop()
    print("Test complete!")


if __name__ == "__main__":
    test_undetected()
