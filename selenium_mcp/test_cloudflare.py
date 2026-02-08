#!/usr/bin/env python3
"""
Test script for Cloudflare bot detection bypass using undetected-chromedriver.
"""

import undetected_chromedriver as uc
from selenium_stealth import stealth
from pyvirtualdisplay import Display
import time


def test_cloudflare():
    print("=" * 60)
    print("CLOUDFLARE BOT DETECTION BYPASS TEST")
    print("=" * 60)

    print("\n[1/5] Starting Xvfb display...")
    display = Display(visible=False, size=(1920, 1080))
    display.start()
    print("✓ Xvfb started")

    print("\n[2/5] Initializing undetected Chrome...")
    chrome_options = uc.ChromeOptions()
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1920,1080")
    chrome_options.binary_location = "/usr/sbin/chromium-browser"

    driver = uc.Chrome(
        options=chrome_options,
        driver_executable_path="/usr/sbin/chromedriver",
        use_subprocess=True,
    )
    print("✓ Chrome initialized")

    print("\n[3/5] Applying selenium-stealth patches...")
    stealth(
        driver,
        languages=["en-US", "en"],
        vendor="Google Inc.",
        platform="Win32",
        webgl_vendor="Intel Inc.",
        renderer="Intel Iris OpenGL Engine",
        fix_hairline=True,
    )
    print("✓ Stealth patches applied")

    # Test multiple Cloudflare-protected sites
    test_sites = [
        {
            "name": "Cloudflare Challenge Page",
            "url": "https://nopecha.com/demo/cloudflare",
            "check_text": ["challenge", "checking", "browser"],
        },
        {
            "name": "Discord (Cloudflare protected)",
            "url": "https://discord.com",
            "check_text": ["discord", "chat", "login"],
        },
        {
            "name": "Nowsecure.nl Bot Test",
            "url": "https://nowsecure.nl",
            "check_text": ["bot", "detected"],
        },
    ]

    results = []

    for i, site in enumerate(test_sites, 1):
        print(f"\n[4.{i}/5] Testing: {site['name']}")
        print(f"URL: {site['url']}")

        try:
            driver.get(site["url"])
            print(f"  → Waiting for page load...")
            time.sleep(8)  # Wait for any Cloudflare challenge

            page_title = driver.title
            page_source = driver.page_source.lower()

            print(f"  → Page title: {page_title}")

            # Check for Cloudflare challenge indicators
            cf_indicators = [
                "just a moment",
                "checking your browser",
                "challenge-running",
                "cf-browser-verification",
                "ray id",
                "cloudflare",
            ]

            is_challenged = any(indicator in page_source for indicator in cf_indicators)

            # Check for bot detection
            is_bot_detected = False
            for check in site["check_text"]:
                if "bot" in check.lower() and "detected" in page_source:
                    is_bot_detected = True
                    break

            # Determine result
            if is_challenged:
                status = "⚠️  CHALLENGED"
                detail = "Cloudflare challenge detected"
            elif is_bot_detected:
                status = "❌ BLOCKED"
                detail = "Bot detected"
            else:
                # Check if we got actual content
                content_indicators = site["check_text"]
                has_content = any(
                    indicator in page_source
                    for indicator in content_indicators
                    if "bot" not in indicator.lower()
                )

                if has_content or len(page_source) > 5000:
                    status = "✅ PASSED"
                    detail = "Successfully loaded"
                else:
                    status = "⚠️  UNKNOWN"
                    detail = "Unclear result"

            print(f"  → Status: {status}")
            print(f"  → Detail: {detail}")
            print(f"  → Page size: {len(page_source)} bytes")

            results.append(
                {
                    "site": site["name"],
                    "url": site["url"],
                    "status": status,
                    "detail": detail,
                    "title": page_title,
                }
            )

        except Exception as e:
            print(f"  → ❌ ERROR: {str(e)}")
            results.append(
                {
                    "site": site["name"],
                    "url": site["url"],
                    "status": "❌ ERROR",
                    "detail": str(e)[:100],
                    "title": "N/A",
                }
            )

    print("\n[5/5] Cleaning up...")
    driver.quit()
    display.stop()
    print("✓ Cleanup complete")

    # Print summary
    print("\n" + "=" * 60)
    print("TEST RESULTS SUMMARY")
    print("=" * 60)

    for result in results:
        print(f"\n{result['status']} {result['site']}")
        print(f"   URL: {result['url']}")
        print(f"   Title: {result['title']}")
        print(f"   Detail: {result['detail']}")

    # Overall assessment
    print("\n" + "=" * 60)
    passed = sum(1 for r in results if "✅" in r["status"])
    blocked = sum(1 for r in results if "❌" in r["status"])
    challenged = sum(1 for r in results if "⚠️" in r["status"])

    print(
        f"OVERALL: {passed} passed, {challenged} challenged, {blocked} blocked out of {len(results)} tests"
    )

    if passed >= 2:
        print("\n🎉 SUCCESS: Cloudflare bypass is working well!")
    elif challenged > 0 and blocked == 0:
        print("\n⚠️  PARTIAL: Some challenges detected, but not blocked")
    else:
        print("\n❌ FAILED: Bot detection bypass needs improvement")

    print("=" * 60)


if __name__ == "__main__":
    test_cloudflare()
