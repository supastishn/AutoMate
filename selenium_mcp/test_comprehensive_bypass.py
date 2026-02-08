#!/usr/bin/env python3
"""
Comprehensive bot detection bypass test.

IMPORTANT: This test focuses on bypassing bot DETECTION, not solving CAPTCHAs.
- ✅ We can bypass: Cloudflare browser checks, bot fingerprinting
- ❌ We cannot/should not bypass: CAPTCHAs (use legitimate solving services)

This demonstrates ethical automation and what undetected-chromedriver can do.
"""

import undetected_chromedriver as uc
from selenium_stealth import stealth
from pyvirtualdisplay import Display
import time
import random


def get_realistic_user_agent():
    """Get a realistic user agent string."""
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def test_comprehensive_bypass():
    print("=" * 90)
    print("COMPREHENSIVE BOT DETECTION BYPASS TEST")
    print("Testing legitimate bot detection bypasses (not CAPTCHA solving)")
    print("=" * 90)

    print("\n⚠️  ETHICAL NOTE:")
    print(
        "   This test bypasses bot DETECTION (browser fingerprinting, Cloudflare checks)"
    )
    print(
        "   It does NOT solve CAPTCHAs - use legitimate services for that (NopeCHA API, etc.)"
    )
    print("=" * 90)

    print("\n[1/7] Starting Xvfb display...")
    display = Display(visible=False, size=(1920, 1080))
    display.start()
    print("✓ Xvfb started")

    print("\n[2/7] Initializing maximum stealth Chrome...")
    chrome_options = uc.ChromeOptions()

    # Maximum stealth configuration
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1920,1080")
    chrome_options.add_argument("--start-maximized")
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument("--disable-infobars")
    chrome_options.add_argument("--disable-browser-side-navigation")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--disable-features=VizDisplayCompositor")
    chrome_options.add_argument("--lang=en-US,en")

    # Realistic user agent
    user_agent = get_realistic_user_agent()
    chrome_options.add_argument(f"user-agent={user_agent}")

    # Enhanced preferences
    prefs = {
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
        "profile.default_content_setting_values.notifications": 2,
        "profile.default_content_settings.popups": 0,
        "profile.managed_default_content_settings.images": 1,
    }
    chrome_options.add_experimental_option("prefs", prefs)
    # Note: useAutomationExtension not supported in all Chrome versions

    chrome_options.binary_location = "/usr/sbin/chromium-browser"

    driver = uc.Chrome(
        options=chrome_options,
        driver_executable_path="/usr/sbin/chromedriver",
        use_subprocess=True,
        version_main=144,
    )
    print("✓ Chrome initialized with maximum stealth")

    print("\n[3/7] Applying selenium-stealth...")
    stealth(
        driver,
        languages=["en-US", "en"],
        vendor="Google Inc.",
        platform="Win32",
        webgl_vendor="Intel Inc.",
        renderer="Intel Iris OpenGL Engine",
        fix_hairline=True,
    )
    print("✓ Selenium-stealth applied")

    print("\n[4/7] Applying advanced JavaScript patches...")
    try:
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {
                "source": """
                // Remove webdriver property
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
                
                // Override permissions
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                        Promise.resolve({ state: Notification.permission }) :
                        originalQuery(parameters)
                );
                
                // Add plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [
                        {name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer'},
                        {name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
                        {name: 'Native Client', description: '', filename: 'internal-nacl-plugin'}
                    ]
                });
                
                // Chrome runtime
                window.chrome = {
                    runtime: {},
                    loadTimes: function() {},
                    csi: function() {},
                    app: {}
                };
                
                // Languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en']
                });
            """
            },
        )
        print("✓ Advanced JavaScript patches applied")
    except Exception as e:
        print(f"⚠️  JavaScript patches partially applied: {e}")

    # Test sites - focusing on bot detection, not CAPTCHAs
    test_sites = [
        {
            "name": "Bot.Sannysoft.com (Bot Detection Test)",
            "url": "https://bot.sannysoft.com",
            "wait_time": 5,
            "type": "detection_test",
            "check_method": "inspect_page",
        },
        {
            "name": "BrowserLeaks.com WebRTC Test",
            "url": "https://browserleaks.com/webrtc",
            "wait_time": 8,
            "type": "fingerprint_test",
            "check_method": "page_load",
        },
        {
            "name": "Discord (Cloudflare Protected)",
            "url": "https://discord.com",
            "wait_time": 10,
            "type": "cloudflare",
            "check_method": "content",
        },
        {
            "name": "Nowsecure.nl Bot Test",
            "url": "https://nowsecure.nl",
            "wait_time": 12,
            "type": "bot_detection",
            "check_method": "content",
        },
        {
            "name": "OpenAI Platform (Cloudflare)",
            "url": "https://platform.openai.com",
            "wait_time": 10,
            "type": "cloudflare",
            "check_method": "content",
        },
        {
            "name": "GitHub.com",
            "url": "https://github.com",
            "wait_time": 8,
            "type": "standard",
            "check_method": "content",
        },
        {
            "name": "Intoli.com Bot Detection",
            "url": "https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html",
            "wait_time": 8,
            "type": "detection_test",
            "check_method": "inspect_page",
        },
    ]

    results = []

    print("\n[5/7] Running comprehensive bypass tests...")
    print("=" * 90)

    for i, site in enumerate(test_sites, 1):
        print(f"\n[Test {i}/{len(test_sites)}] {site['name']}")
        print(f"  Type: {site['type']}")
        print(f"  URL: {site['url']}")

        try:
            driver.get(site["url"])
            print(f"  → Loaded, waiting {site['wait_time']}s...")

            # Progressive wait with status updates
            for sec in range(site["wait_time"]):
                time.sleep(1)
                if sec > 0 and sec % 3 == 0:
                    current_title = driver.title[:60]
                    print(f"    ... {sec}s - {current_title}")

            # Analyze results
            title = driver.title
            source = driver.page_source.lower()
            size = len(source)

            print(f"\n  Results:")
            print(f"  → Title: {title}")
            print(f"  → Size: {size:,} bytes")

            # Determine success based on site type
            success = False
            detail = ""

            if site["type"] == "cloudflare":
                cf_blocked = any(
                    x in source
                    for x in [
                        "just a moment",
                        "checking your browser",
                        "challenge-running",
                    ]
                )
                if not cf_blocked and size > 20000:
                    success = True
                    detail = "Cloudflare bypassed successfully"
                elif cf_blocked:
                    success = False
                    detail = "Cloudflare challenge still active"
                else:
                    success = False
                    detail = "Page loaded but small size"

            elif site["type"] == "bot_detection":
                bot_detected = "bot detected" in source or "access denied" in source
                if not bot_detected and size > 10000:
                    success = True
                    detail = "Bot detection bypassed"
                else:
                    success = False
                    detail = "Bot detected" if bot_detected else "Unclear result"

            elif site["type"] == "detection_test":
                # These pages show detection results
                if "webdriver" not in source or "not detected" in source:
                    success = True
                    detail = "Detection tests passed"
                else:
                    success = False
                    detail = "Some detection markers found"

            else:  # standard
                if size > 10000 and "error" not in title.lower():
                    success = True
                    detail = "Page loaded successfully"
                else:
                    success = False
                    detail = "Load issue or error"

            status = "✅ PASSED" if success else "❌ FAILED"
            print(f"  → Status: {status}")
            print(f"  → Detail: {detail}")

            results.append(
                {
                    "site": site["name"],
                    "type": site["type"],
                    "url": site["url"],
                    "success": success,
                    "status": status,
                    "detail": detail,
                    "title": title,
                    "size": size,
                }
            )

        except Exception as e:
            print(f"  → ❌ ERROR: {str(e)[:100]}")
            results.append(
                {
                    "site": site["name"],
                    "type": site["type"],
                    "url": site["url"],
                    "success": False,
                    "status": "❌ ERROR",
                    "detail": str(e)[:100],
                    "title": "N/A",
                    "size": 0,
                }
            )

        if i < len(test_sites):
            print("\n  Waiting 2s before next test...")
            time.sleep(2)

    print("\n[6/7] Testing browser fingerprint...")
    try:
        driver.get("about:blank")
        fingerprint = driver.execute_script("""
            return {
                webdriver: navigator.webdriver,
                languages: navigator.languages,
                plugins: navigator.plugins.length,
                platform: navigator.platform,
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: navigator.deviceMemory,
                userAgent: navigator.userAgent
            }
        """)
        print("  Browser Fingerprint:")
        print(f"  → webdriver: {fingerprint.get('webdriver', 'undefined')}")
        print(f"  → languages: {fingerprint.get('languages', [])}")
        print(f"  → plugins: {fingerprint.get('plugins', 0)}")
        print(f"  → platform: {fingerprint.get('platform', 'unknown')}")

        if fingerprint.get("webdriver") is None:
            print("  ✅ webdriver property successfully hidden")
        else:
            print("  ⚠️  webdriver property still visible")

    except Exception as e:
        print(f"  ⚠️  Could not check fingerprint: {e}")

    print("\n[7/7] Cleaning up...")
    driver.quit()
    display.stop()
    print("✓ Cleanup complete")

    # Summary
    print("\n" + "=" * 90)
    print("TEST RESULTS SUMMARY")
    print("=" * 90)

    for r in results:
        print(f"\n{r['status']} {r['site']}")
        print(f"   Type: {r['type']}")
        print(f"   URL: {r['url']}")
        print(f"   Detail: {r['detail']}")
        print(f"   Size: {r['size']:,} bytes")

    # Statistics by type
    print("\n" + "=" * 90)
    print("STATISTICS BY TYPE")
    print("=" * 90)

    types = {}
    for r in results:
        t = r["type"]
        if t not in types:
            types[t] = {"passed": 0, "total": 0}
        types[t]["total"] += 1
        if r["success"]:
            types[t]["passed"] += 1

    for t, stats in types.items():
        rate = (stats["passed"] / stats["total"] * 100) if stats["total"] > 0 else 0
        print(f"{t:20} {stats['passed']}/{stats['total']} ({rate:.0f}%)")

    # Overall
    print("\n" + "=" * 90)
    passed = sum(1 for r in results if r["success"])
    total = len(results)
    rate = (passed / total * 100) if total > 0 else 0

    print(f"OVERALL SUCCESS RATE: {passed}/{total} ({rate:.1f}%)")

    if rate >= 80:
        print("\n🎉 EXCELLENT: Bot detection bypass is working exceptionally well!")
    elif rate >= 60:
        print("\n✅ GOOD: Most bot detection systems successfully bypassed!")
    elif rate >= 40:
        print("\n⚠️  MODERATE: Some sites bypassed, but room for improvement")
    else:
        print("\n❌ NEEDS WORK: Consider additional bypass techniques")

    print("\n💡 REMEMBER:")
    print("   ✅ This bypasses bot DETECTION (fingerprinting, Cloudflare checks)")
    print("   ❌ This does NOT solve CAPTCHAs - use legitimate services for that")
    print("   🔒 Always respect robots.txt and website terms of service")
    print("=" * 90)

    return results


if __name__ == "__main__":
    test_comprehensive_bypass()
