#!/usr/bin/env python3
"""
Enhanced Cloudflare test with longer wait times for automatic challenge solving.
"""

import undetected_chromedriver as uc
from selenium_stealth import stealth
from pyvirtualdisplay import Display
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.by import By
import time


def wait_for_cloudflare(driver, timeout=30):
    """Wait for Cloudflare challenge to complete."""
    print(f"  → Waiting up to {timeout}s for Cloudflare challenge...")

    start_time = time.time()
    while time.time() - start_time < timeout:
        page_source = driver.page_source.lower()
        page_title = driver.title.lower()

        # Check if challenge is still active
        if "just a moment" in page_title or "checking your browser" in page_source:
            print(
                f"    ... Challenge detected, waiting (elapsed: {int(time.time() - start_time)}s)"
            )
            time.sleep(2)
            continue
        else:
            print(f"  → Challenge completed in {int(time.time() - start_time)}s!")
            return True

    print(f"  → Timeout after {timeout}s")
    return False


def test_cloudflare_enhanced():
    print("=" * 70)
    print("ENHANCED CLOUDFLARE BOT DETECTION BYPASS TEST")
    print("(With automatic challenge solving)")
    print("=" * 70)

    print("\n[1/5] Starting Xvfb display...")
    display = Display(visible=False, size=(1920, 1080))
    display.start()
    print("✓ Xvfb started")

    print("\n[2/5] Initializing undetected Chrome...")
    chrome_options = uc.ChromeOptions()
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1920,1080")

    # Additional arguments for better Cloudflare bypass
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument("--start-maximized")

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

    # Test sites with Cloudflare
    test_sites = [
        {
            "name": "Discord (Cloudflare protected)",
            "url": "https://discord.com",
            "success_indicators": ["discord", "chat", "login", "download"],
        },
        {
            "name": "Cloudflare Challenge Demo",
            "url": "https://nopecha.com/demo/cloudflare",
            "success_indicators": ["success", "passed", "nopecha"],
        },
        {
            "name": "OpenAI (Cloudflare protected)",
            "url": "https://platform.openai.com",
            "success_indicators": ["openai", "api", "platform"],
        },
    ]

    results = []

    for i, site in enumerate(test_sites, 1):
        print(f"\n[4.{i}/5] Testing: {site['name']}")
        print(f"URL: {site['url']}")

        try:
            driver.get(site["url"])

            # Wait for Cloudflare challenge to complete
            cf_passed = wait_for_cloudflare(driver, timeout=30)

            page_title = driver.title
            page_source = driver.page_source.lower()

            print(f"  → Final page title: {page_title}")

            # Check if we're still on challenge page
            cf_indicators = [
                "just a moment",
                "checking your browser",
                "challenge-running",
            ]

            still_challenged = any(
                indicator in page_source for indicator in cf_indicators
            )

            # Check for successful content
            has_content = any(
                indicator in page_source for indicator in site["success_indicators"]
            )

            if still_challenged:
                status = "⚠️  CHALLENGED"
                detail = "Still on Cloudflare challenge page"
            elif has_content and len(page_source) > 5000:
                status = "✅ PASSED"
                detail = "Successfully bypassed Cloudflare"
            elif len(page_source) > 50000:
                status = "✅ LIKELY PASSED"
                detail = "Large page loaded (likely successful)"
            else:
                status = "❌ BLOCKED"
                detail = "No expected content found"

            print(f"  → Status: {status}")
            print(f"  → Detail: {detail}")
            print(f"  → Page size: {len(page_source):,} bytes")

            results.append(
                {
                    "site": site["name"],
                    "url": site["url"],
                    "status": status,
                    "detail": detail,
                    "title": page_title,
                    "size": len(page_source),
                }
            )

            # Small delay between tests
            time.sleep(2)

        except Exception as e:
            print(f"  → ❌ ERROR: {str(e)}")
            results.append(
                {
                    "site": site["name"],
                    "url": site["url"],
                    "status": "❌ ERROR",
                    "detail": str(e)[:100],
                    "title": "N/A",
                    "size": 0,
                }
            )

    print("\n[5/5] Cleaning up...")
    driver.quit()
    display.stop()
    print("✓ Cleanup complete")

    # Print summary
    print("\n" + "=" * 70)
    print("TEST RESULTS SUMMARY")
    print("=" * 70)

    for result in results:
        print(f"\n{result['status']} {result['site']}")
        print(f"   URL: {result['url']}")
        print(f"   Title: {result['title']}")
        print(f"   Detail: {result['detail']}")
        print(f"   Size: {result['size']:,} bytes")

    # Overall assessment
    print("\n" + "=" * 70)
    passed = sum(1 for r in results if "✅" in r["status"])
    blocked = sum(
        1 for r in results if "❌" in r["status"] and "ERROR" not in r["status"]
    )
    challenged = sum(1 for r in results if "⚠️" in r["status"])
    errors = sum(1 for r in results if "ERROR" in r["status"])

    print(
        f"RESULTS: {passed} passed, {challenged} challenged, {blocked} blocked, {errors} errors"
    )
    print(f"         (out of {len(results)} total tests)")

    if passed >= 2:
        print("\n🎉 SUCCESS: Cloudflare bypass is working excellently!")
        print("   The undetected-chromedriver is successfully evading bot detection.")
    elif passed >= 1 and challenged > 0:
        print("\n✅ GOOD: Cloudflare bypass is working on most sites!")
        print("   Some challenges may require manual solving or longer wait times.")
    elif challenged > 0 and blocked == 0:
        print("\n⚠️  PARTIAL: Challenges detected but not blocked.")
        print("   Consider increasing wait times or using challenge solvers.")
    else:
        print("\n❌ NEEDS WORK: Bot detection bypass needs improvement.")

    print("=" * 70)

    return results


if __name__ == "__main__":
    test_cloudflare_enhanced()
