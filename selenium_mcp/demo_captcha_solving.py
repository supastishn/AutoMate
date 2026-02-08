#!/usr/bin/env python3
"""
CAPTCHA Solving Demo for Selenium MCP Server

This demonstrates how to use the CAPTCHA solving integration.

REQUIREMENTS:
1. API key from 2Captcha (https://2captcha.com) or AntiCaptcha (https://anti-captcha.com)
2. Set environment variable: export CAPTCHA_API_KEY="your-api-key-here"
3. Choose service: export CAPTCHA_SERVICE="2captcha" or "anticaptcha"

PRICING (approximate):
- 2Captcha: $2.99 per 1000 reCAPTCHAs
- AntiCaptcha: $0.50-$2.00 per 1000 CAPTCHAs

NOTE: This is for demonstration/testing only. Use responsibly and legally.
"""

import os
import sys

# Check for API key
API_KEY = os.getenv("CAPTCHA_API_KEY")
SERVICE = os.getenv("CAPTCHA_SERVICE", "2captcha")

if not API_KEY:
    print("=" * 80)
    print("⚠️  CAPTCHA API KEY NOT FOUND")
    print("=" * 80)
    print("\nTo use CAPTCHA solving, you need an API key from one of these services:")
    print("\n1. 2Captcha (https://2captcha.com)")
    print("   - Sign up and get API key")
    print("   - Set environment variable: export CAPTCHA_API_KEY='your-key'")
    print("   - Set service: export CAPTCHA_SERVICE='2captcha'")
    print("\n2. AntiCaptcha (https://anti-captcha.com)")
    print("   - Sign up and get API key")
    print("   - Set environment variable: export CAPTCHA_API_KEY='your-key'")
    print("   - Set service: export CAPTCHA_SERVICE='anticaptcha'")
    print("\nPricing:")
    print("   - 2Captcha: ~$3 per 1000 solves")
    print("   - AntiCaptcha: ~$0.50-$2 per 1000 solves")
    print("\n" + "=" * 80)
    print("\n💡 TIP: For testing, both services offer small free trial credits!")
    print("=" * 80)
    sys.exit(1)

print("=" * 80)
print("CAPTCHA SOLVING DEMO")
print("=" * 80)

print(f"\n✅ API Key found")
print(f"✅ Service: {SERVICE}")

# Import MCP server tools
sys.path.insert(0, "/data/data/com.termux/files/home/prog/selenium_mcp")
import selenium_mcp_server as mcp

print("\n[1/6] Configuring CAPTCHA solver...")
result = mcp.configure_captcha_solver(service=SERVICE, api_key=API_KEY)
if not result["success"]:
    print(f"❌ Failed: {result.get('error')}")
    sys.exit(1)
print(f"✅ {result['message']}")

print("\n[2/6] Starting browser...")
result = mcp.start_browser(use_xvfb=True, enable_stealth=True)
if not result["success"]:
    print(f"❌ Failed: {result.get('message')}")
    sys.exit(1)
print("✅ Browser started")

# Example sites with CAPTCHAs
print("\n[3/6] Available CAPTCHA test sites:")
print("   1. Google reCAPTCHA v2 Demo: https://www.google.com/recaptcha/api2/demo")
print("   2. hCaptcha Demo: https://accounts.hcaptcha.com/demo")
print("   3. NopeCHA reCAPTCHA Test: https://nopecha.com/demo/recaptcha")

# For demo, we'll show the workflow without actually solving
# (to avoid using API credits unless user specifically wants to)

print("\n[4/6] Example workflow for solving reCAPTCHA v2:")
print("""
# Navigate to page with CAPTCHA
mcp.navigate("https://www.google.com/recaptcha/api2/demo")

# Find the site key (from page source)
# Usually in: <div class="g-recaptcha" data-sitekey="YOUR_SITE_KEY">
sitekey = "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"  # Demo site key

# Solve the CAPTCHA
result = mcp.solve_recaptcha_v2(sitekey=sitekey)
if result['success']:
    token = result['token']
    
    # Inject token into page
    mcp.inject_captcha_token(token, captcha_type="recaptcha")
    
    # Submit the form
    mcp.click_element("button#recaptcha-demo-submit")
    
    print("✅ CAPTCHA solved and form submitted!")
""")

print("\n[5/6] Example workflow for solving hCaptcha:")
print("""
# Navigate to hCaptcha demo
mcp.navigate("https://accounts.hcaptcha.com/demo")

# Find site key from page
sitekey = "YOUR_HCAPTCHA_SITEKEY"

# Solve hCaptcha
result = mcp.solve_hcaptcha(sitekey=sitekey)
if result['success']:
    token = result['token']
    
    # Inject token
    mcp.inject_captcha_token(token, captcha_type="hcaptcha")
    
    print("✅ hCaptcha solved!")
""")

print("\n[6/6] Cleaning up...")
mcp.stop_browser()
print("✅ Done")

print("\n" + "=" * 80)
print("📝 SUMMARY")
print("=" * 80)
print("\nThe Selenium MCP server now has CAPTCHA solving capabilities!")
print("\nAvailable tools:")
print("  • configure_captcha_solver(service, api_key)")
print("  • solve_recaptcha_v2(sitekey, url)")
print("  • solve_hcaptcha(sitekey, url)")
print("  • inject_captcha_token(token, captcha_type)")
print("\nSupported services:")
print("  • 2Captcha (2captcha.com)")
print("  • AntiCaptcha (anti-captcha.com)")
print("\n⚠️  IMPORTANT:")
print("  - CAPTCHA solving costs money (per solve)")
print("  - Use responsibly and legally")
print("  - Respect website terms of service")
print("  - Consider if CAPTCHA solving is necessary for your use case")
print("=" * 80)
