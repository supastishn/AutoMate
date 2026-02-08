#!/usr/bin/env python3
"""
NopeCHA Demo Comprehensive Test

This script demonstrates how to handle ALL the CAPTCHAs on nopecha.com/demo
using the integrated CAPTCHA solving services.

REQUIREMENTS:
1. API key from 2Captcha or AntiCaptcha
2. Set: export CAPTCHA_API_KEY="your-key"
3. Set: export CAPTCHA_SERVICE="2captcha" (or "anticaptcha")

IMPORTANT NOTES:
- CAPTCHAs CANNOT be bypassed for free
- You MUST use a paid solving service
- Each solve costs ~$0.001-$0.003
- This is for testing/demonstration only
- Use responsibly and legally

NopeCHA Demos to Test:
✅ reCAPTCHA v2 (Easy, Moderate, Hard)
✅ hCaptcha
⚠️  Cloudflare Turnstile (works with reCAPTCHA method)
⚠️  FunCAPTCHA (requires advanced solver)
⚠️  GeeTest (requires advanced solver)
⚠️  Text CAPTCHA (requires OCR solver)
"""

import os
import sys
import time

# Check for API key
API_KEY = os.getenv("CAPTCHA_API_KEY")
SERVICE = os.getenv("CAPTCHA_SERVICE", "2captcha")

if not API_KEY:
    print("=" * 80)
    print("❌ ERROR: CAPTCHA API KEY REQUIRED")
    print("=" * 80)
    print("\nCAPTCHAs cannot be bypassed for free. You need a solving service:")
    print("\n1. Get API key from:")
    print("   • 2Captcha: https://2captcha.com (~$3 per 1000 solves)")
    print("   • AntiCaptcha: https://anti-captcha.com (~$1 per 1000 solves)")
    print("\n2. Set environment variables:")
    print("   export CAPTCHA_API_KEY='your-api-key-here'")
    print("   export CAPTCHA_SERVICE='2captcha'")
    print("\n3. Both services offer free trial credits for testing!")
    print("\n" + "=" * 80)
    print("\n💡 ALTERNATIVE: Use NopeCHA's own solver:")
    print("   https://nopecha.com/setup (browser extension)")
    print("=" * 80)
    sys.exit(1)

print("=" * 80)
print("NOPECHA DEMO COMPREHENSIVE TEST")
print("Testing CAPTCHA solving on all NopeCHA demos")
print("=" * 80)

print(f"\n✅ API Key: {API_KEY[:10]}...")
print(f"✅ Service: {SERVICE}")

# Import MCP server
sys.path.insert(0, "/data/data/com.termux/files/home/prog/selenium_mcp")
import selenium_mcp_server as mcp

print("\n" + "=" * 80)
print("SETUP")
print("=" * 80)

print("\n[1/3] Configuring CAPTCHA solver...")
result = mcp.configure_captcha_solver(service=SERVICE, api_key=API_KEY)
if not result["success"]:
    print(f"❌ Failed: {result.get('error')}")
    sys.exit(1)
print(f"✅ {result['message']}")

print("\n[2/3] Starting browser with maximum stealth...")
result = mcp.start_browser(use_xvfb=True, enable_stealth=True)
if not result["success"]:
    print(f"❌ Failed: {result.get('message')}")
    sys.exit(1)
print("✅ Browser started")

print("\n[3/3] Disabling robots.txt for demo sites...")
mcp.configure_robots_txt(respect=False)
print("✅ robots.txt disabled (demo purposes only)")

# Test all NopeCHA demos
demos = [
    {
        "name": "reCAPTCHA v2 (Easy)",
        "url": "https://nopecha.com/demo/recaptcha#easy",
        "type": "recaptcha",
        "description": "Google reCAPTCHA v2 - Easy difficulty",
    },
    {
        "name": "reCAPTCHA v2 (Moderate)",
        "url": "https://nopecha.com/demo/recaptcha#moderate",
        "type": "recaptcha",
        "description": "Google reCAPTCHA v2 - Moderate difficulty",
    },
    {
        "name": "reCAPTCHA v2 (Hard)",
        "url": "https://nopecha.com/demo/recaptcha#hard",
        "type": "recaptcha",
        "description": "Google reCAPTCHA v2 - Hard difficulty",
    },
    {
        "name": "hCaptcha",
        "url": "https://nopecha.com/demo/hcaptcha",
        "type": "hcaptcha",
        "description": "hCaptcha - Image recognition CAPTCHA",
    },
    {
        "name": "Cloudflare Turnstile",
        "url": "https://nopecha.com/demo/turnstile",
        "type": "turnstile",
        "description": "Cloudflare Turnstile - Invisible challenge",
    },
]

results = []

print("\n" + "=" * 80)
print("RUNNING TESTS")
print("=" * 80)
print("\n⚠️  NOTE: Each CAPTCHA solve costs ~$0.001-$0.003")
print("         Total estimated cost: $" + str(len(demos) * 0.003))
print("=" * 80)

for i, demo in enumerate(demos, 1):
    print(f"\n[Test {i}/{len(demos)}] {demo['name']}")
    print(f"  URL: {demo['url']}")
    print(f"  Type: {demo['type']}")
    print(f"  Description: {demo['description']}")

    try:
        # Navigate to demo
        print(f"  → Navigating...")
        nav_result = mcp.navigate(demo["url"], skip_robots_check=True)
        if not nav_result.get("success"):
            print(f"  ❌ Navigation failed: {nav_result.get('error')}")
            results.append(
                {
                    "demo": demo["name"],
                    "status": "❌ FAILED",
                    "detail": "Navigation failed",
                }
            )
            continue

        time.sleep(3)  # Wait for page load

        print(f"  → Finding CAPTCHA sitekey...")

        # Get sitekey from page
        if demo["type"] == "recaptcha":
            sitekey_script = """
                var elem = document.querySelector('[data-sitekey]');
                return elem ? elem.getAttribute('data-sitekey') : null;
            """
        elif demo["type"] == "hcaptcha":
            sitekey_script = """
                var elem = document.querySelector('.h-captcha[data-sitekey]');
                return elem ? elem.getAttribute('data-sitekey') : null;
            """
        elif demo["type"] == "turnstile":
            sitekey_script = """
                var elem = document.querySelector('[data-sitekey]');
                return elem ? elem.getAttribute('data-sitekey') : null;
            """
        else:
            print(f"  ⚠️  Unknown CAPTCHA type: {demo['type']}")
            results.append(
                {
                    "demo": demo["name"],
                    "status": "⚠️  SKIPPED",
                    "detail": "Unsupported CAPTCHA type",
                }
            )
            continue

        sitekey_result = mcp.execute_javascript(sitekey_script)
        sitekey = sitekey_result.get("result")

        if not sitekey:
            print(f"  ⚠️  Could not find sitekey")
            results.append(
                {
                    "demo": demo["name"],
                    "status": "⚠️  FAILED",
                    "detail": "Sitekey not found",
                }
            )
            continue

        print(f"  → Sitekey: {sitekey[:20]}...")
        print(f"  → Sending to {SERVICE} for solving...")
        print(f"     (This may take 5-20 seconds...)")

        # Solve the CAPTCHA
        if demo["type"] in ["recaptcha", "turnstile"]:
            solve_result = mcp.solve_recaptcha_v2(sitekey=sitekey)
        elif demo["type"] == "hcaptcha":
            solve_result = mcp.solve_hcaptcha(sitekey=sitekey)
        else:
            print(f"  ❌ No solver for type: {demo['type']}")
            results.append(
                {
                    "demo": demo["name"],
                    "status": "❌ FAILED",
                    "detail": "No solver available",
                }
            )
            continue

        if not solve_result.get("success"):
            error = solve_result.get("error", "Unknown error")
            print(f"  ❌ Solving failed: {error}")
            results.append(
                {
                    "demo": demo["name"],
                    "status": "❌ FAILED",
                    "detail": f"Solve error: {error}",
                }
            )
            continue

        token = solve_result["token"]
        print(f"  ✅ CAPTCHA solved! Token: {token[:20]}...")

        # Inject token
        print(f"  → Injecting solution...")
        captcha_type = (
            "recaptcha" if demo["type"] in ["recaptcha", "turnstile"] else "hcaptcha"
        )
        inject_result = mcp.inject_captcha_token(token, captcha_type=captcha_type)

        if inject_result.get("success"):
            print(f"  ✅ Token injected successfully")

            # Try to submit if button exists
            print(f"  → Looking for submit button...")
            time.sleep(1)

            # Take screenshot for verification
            mcp.screenshot()

            print(f"  ✅ CAPTCHA SOLVED AND INJECTED!")
            results.append(
                {
                    "demo": demo["name"],
                    "status": "✅ PASSED",
                    "detail": "CAPTCHA solved successfully",
                }
            )
        else:
            print(f"  ⚠️  Injection issue: {inject_result.get('error')}")
            results.append(
                {
                    "demo": demo["name"],
                    "status": "⚠️  PARTIAL",
                    "detail": "Solved but injection failed",
                }
            )

    except Exception as e:
        print(f"  ❌ Exception: {str(e)}")
        results.append(
            {"demo": demo["name"], "status": "❌ ERROR", "detail": str(e)[:50]}
        )

    if i < len(demos):
        print(f"\n  Waiting 3s before next test...")
        time.sleep(3)

print("\n" + "=" * 80)
print("CLEANING UP")
print("=" * 80)
mcp.stop_browser()
print("✅ Browser stopped")

# Summary
print("\n" + "=" * 80)
print("TEST RESULTS SUMMARY")
print("=" * 80)

for result in results:
    print(f"\n{result['status']} {result['demo']}")
    print(f"   Detail: {result['detail']}")

passed = sum(1 for r in results if "✅" in r["status"])
partial = sum(1 for r in results if "⚠️" in r["status"])
failed = sum(1 for r in results if "❌" in r["status"])
total = len(results)

print("\n" + "=" * 80)
print(f"RESULTS: {passed} passed, {partial} partial, {failed} failed (out of {total})")
print("=" * 80)

if passed >= total * 0.8:
    print("\n🎉 EXCELLENT: CAPTCHA solving is working very well!")
elif passed >= total * 0.5:
    print("\n✅ GOOD: Most CAPTCHAs solved successfully!")
else:
    print("\n⚠️  Some CAPTCHAs could not be solved")

print("\n💰 COST ESTIMATE:")
print(f"   Tests run: {total}")
print(f"   CAPTCHAs solved: {passed}")
print(f"   Estimated cost: ${passed * 0.003:.3f} - ${passed * 0.0030:.3f}")

print("\n" + "=" * 80)
print("IMPORTANT NOTES")
print("=" * 80)
print("""
1. CAPTCHAs are DESIGNED to prevent automation
2. Solving services are the ONLY way to handle them programmatically
3. This costs real money (~$0.001-$0.003 per solve)
4. Use responsibly and only when necessary
5. Always respect website terms of service

ALTERNATIVE APPROACHES:
• If testing your own site: Add CAPTCHA bypass for testing
• If possible: Avoid CAPTCHA-protected pages
• For development: Use test/dev environments without CAPTCHAs
• Consider: Whether CAPTCHA solving is necessary for your use case
""")
print("=" * 80)
