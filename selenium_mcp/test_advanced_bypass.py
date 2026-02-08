#!/usr/bin/env python3
"""
Advanced bot detection bypass test with enhanced configurations.
Tests multiple challenging sites.
"""

import undetected_chromedriver as uc
from selenium_stealth import stealth
from pyvirtualdisplay import Display
import time
import random


def get_random_user_agent():
    """Get a random realistic user agent."""
    user_agents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ]
    return random.choice(user_agents)


def test_advanced_bypass():
    print("=" * 80)
    print("ADVANCED BOT DETECTION BYPASS TEST")
    print("Testing multiple challenging sites with enhanced configuration")
    print("=" * 80)

    print("\n[1/6] Starting Xvfb display...")
    display = Display(visible=False, size=(1920, 1080))
    display.start()
    print("✓ Xvfb started")

    print("\n[2/6] Initializing enhanced undetected Chrome...")
    chrome_options = uc.ChromeOptions()

    # Core anti-detection arguments
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1920,1080")
    chrome_options.add_argument("--start-maximized")

    # Additional stealth arguments
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument("--disable-infobars")
    chrome_options.add_argument("--disable-browser-side-navigation")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--disable-features=VizDisplayCompositor")

    # Randomize user agent
    user_agent = get_random_user_agent()
    chrome_options.add_argument(f"user-agent={user_agent}")

    # Additional preferences to appear more human
    prefs = {
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
        "profile.default_content_setting_values.notifications": 2,
    }
    chrome_options.add_experimental_option("prefs", prefs)

    chrome_options.binary_location = "/usr/sbin/chromium-browser"

    # Use version_main parameter to let UC find the right driver
    driver = uc.Chrome(
        options=chrome_options,
        driver_executable_path="/usr/sbin/chromedriver",
        use_subprocess=True,
        version_main=144,  # Match installed chromium version
    )
    print("✓ Enhanced Chrome initialized")
    print(f"  User-Agent: {user_agent}")

    print("\n[3/6] Applying advanced selenium-stealth patches...")
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

    # Additional JavaScript patches
    print("\n[4/6] Applying custom JavaScript patches...")
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {
            "source": """
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
            
            // Override the permissions API
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
            
            // Override plugin length
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });
            
            // Chrome runtime
            window.chrome = {
                runtime: {}
            };
        """
        },
    )
    print("✓ Custom JavaScript patches applied")

    # Test sites
    test_sites = [
        {
            "name": "NoPecha Cloudflare Demo",
            "url": "https://nopecha.com/demo/cloudflare",
            "wait_time": 35,
            "success_text": ["success", "passed", "nopecha"],
        },
        {
            "name": "Nowsecure Bot Test",
            "url": "https://nowsecure.nl",
            "wait_time": 15,
            "success_text": ["nowsecure", "browser"],
        },
        {
            "name": "Discord",
            "url": "https://discord.com",
            "wait_time": 10,
            "success_text": ["discord", "chat"],
        },
        {
            "name": "OpenAI Platform",
            "url": "https://platform.openai.com",
            "wait_time": 10,
            "success_text": ["openai", "api"],
        },
        {
            "name": "Cloudflare Turnstile Test",
            "url": "https://demo.playwright.dev/",
            "wait_time": 10,
            "success_text": ["playwright", "demo"],
        },
    ]

    results = []

    print("\n[5/6] Testing sites...")
    print("=" * 80)

    for i, site in enumerate(test_sites, 1):
        print(f"\n[Test {i}/{len(test_sites)}] {site['name']}")
        print(f"URL: {site['url']}")
        print(f"Waiting: {site['wait_time']}s")

        try:
            # Navigate
            driver.get(site["url"])
            print("  → Page loaded, waiting for challenges...")

            # Wait with progress indicator
            for sec in range(site["wait_time"]):
                time.sleep(1)
                if sec % 5 == 0 and sec > 0:
                    title = driver.title
                    print(f"    ... {sec}s elapsed - Title: {title[:50]}")

            # Get final state
            final_title = driver.title
            page_source = driver.page_source.lower()
            page_size = len(page_source)

            print(f"\n  Final State:")
            print(f"  → Title: {final_title}")
            print(f"  → Size: {page_size:,} bytes")

            # Check for Cloudflare challenge
            cf_indicators = [
                "just a moment",
                "checking your browser",
                "challenge-running",
                "cf-browser-verification",
            ]

            still_challenged = any(
                indicator in page_source for indicator in cf_indicators
            )

            # Check for bot detection
            bot_detected = (
                "bot detected" in page_source or "access denied" in page_source
            )

            # Check for success
            has_success_content = any(
                text in page_source for text in site["success_text"]
            )

            # Determine status
            if bot_detected:
                status = "❌ BLOCKED"
                detail = "Bot detected"
            elif still_challenged:
                status = "⚠️  CHALLENGED"
                detail = "Still showing Cloudflare challenge"
            elif has_success_content or page_size > 50000:
                status = "✅ PASSED"
                detail = "Successfully loaded"
            else:
                status = "⚠️  UNCLEAR"
                detail = "Unable to determine status"

            print(f"  → Status: {status}")
            print(f"  → Detail: {detail}")

            results.append(
                {
                    "site": site["name"],
                    "url": site["url"],
                    "status": status,
                    "detail": detail,
                    "title": final_title,
                    "size": page_size,
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
                    "size": 0,
                }
            )

        # Small delay between tests
        if i < len(test_sites):
            print("\n  Waiting 3s before next test...")
            time.sleep(3)

    print("\n[6/6] Cleaning up...")
    driver.quit()
    display.stop()
    print("✓ Cleanup complete")

    # Print summary
    print("\n" + "=" * 80)
    print("TEST RESULTS SUMMARY")
    print("=" * 80)

    for result in results:
        print(f"\n{result['status']} {result['site']}")
        print(f"   URL: {result['url']}")
        print(f"   Title: {result['title']}")
        print(f"   Detail: {result['detail']}")
        print(f"   Size: {result['size']:,} bytes")

    # Overall stats
    print("\n" + "=" * 80)
    passed = sum(1 for r in results if "✅" in r["status"])
    blocked = sum(
        1 for r in results if "❌" in r["status"] and "ERROR" not in r["status"]
    )
    challenged = sum(1 for r in results if "⚠️" in r["status"])
    errors = sum(1 for r in results if "ERROR" in r["status"])

    total = len(results)

    print(
        f"RESULTS: {passed} passed, {challenged} challenged, {blocked} blocked, {errors} errors"
    )
    print(f"Success Rate: {(passed / total) * 100:.1f}%")

    if passed >= total * 0.8:
        print("\n🎉 EXCELLENT: Bot detection bypass is working very well!")
    elif passed >= total * 0.6:
        print("\n✅ GOOD: Most sites are successfully bypassed!")
    elif passed >= total * 0.4:
        print("\n⚠️  MODERATE: Some sites bypassed, room for improvement")
    else:
        print("\n❌ NEEDS WORK: Consider additional bypass techniques")

    print("=" * 80)

    return results


if __name__ == "__main__":
    test_advanced_bypass()
