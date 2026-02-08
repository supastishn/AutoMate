#!/usr/bin/env python3
"""
Test robots.txt compliance in the Selenium MCP server.
"""

import sys
import json


# Simulate MCP tool calls
def test_robots_txt():
    print("=" * 70)
    print("ROBOTS.TXT COMPLIANCE TEST")
    print("=" * 70)

    # Import the server module
    sys.path.insert(0, "/data/data/com.termux/files/home/prog/selenium_mcp")
    import selenium_mcp_server as mcp

    test_urls = [
        {
            "url": "https://www.google.com/search",
            "expected_allowed": False,
            "description": "Google Search (disallowed for bots)",
        },
        {
            "url": "https://www.google.com/",
            "expected_allowed": True,
            "description": "Google Homepage (allowed)",
        },
        {
            "url": "https://example.com/",
            "expected_allowed": True,
            "description": "Example.com (no robots.txt restrictions)",
        },
        {
            "url": "https://github.com/",
            "expected_allowed": True,
            "description": "GitHub Homepage (allowed)",
        },
        {
            "url": "https://www.amazon.com/gp/cart/",
            "expected_allowed": False,
            "description": "Amazon Cart (typically disallowed)",
        },
    ]

    print("\n[1/2] Testing robots.txt checker...")
    print("-" * 70)

    results = []
    for test in test_urls:
        print(f"\nChecking: {test['description']}")
        print(f"URL: {test['url']}")

        # Check robots.txt
        result = mcp.check_robots_txt(test["url"])

        allowed = result.get("allowed", False)
        reason = result.get("reason", "Unknown")

        # Compare with expected
        matches_expected = allowed == test.get("expected_allowed", True)
        status = "✅ PASS" if matches_expected else "⚠️  UNEXPECTED"

        print(f"  → Allowed: {allowed}")
        print(f"  → Reason: {reason}")
        print(f"  → Expected: {test.get('expected_allowed', True)}")
        print(f"  → Status: {status}")

        results.append(
            {
                "url": test["url"],
                "description": test["description"],
                "allowed": allowed,
                "reason": reason,
                "expected": test.get("expected_allowed", True),
                "status": status,
            }
        )

    print("\n" + "-" * 70)
    print("[2/2] Testing robots.txt configuration...")
    print("-" * 70)

    # Test disabling robots.txt
    print("\nDisabling robots.txt compliance...")
    config_result = mcp.configure_robots_txt(respect=False)
    print(f"  → {config_result.get('message', 'Unknown')}")

    # Check a blocked URL again
    blocked_url = "https://www.google.com/search"
    print(f"\nRe-checking previously blocked URL: {blocked_url}")
    result = mcp.check_robots_txt(blocked_url)
    print(f"  → Allowed: {result.get('allowed', False)} (should be True when disabled)")
    print(f"  → Reason: {result.get('reason', 'Unknown')}")

    # Re-enable robots.txt
    print("\nRe-enabling robots.txt compliance...")
    config_result = mcp.configure_robots_txt(respect=True)
    print(f"  → {config_result.get('message', 'Unknown')}")

    # Print summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)

    for r in results:
        print(f"\n{r['status']} {r['description']}")
        print(f"   URL: {r['url']}")
        print(f"   Allowed: {r['allowed']} (Expected: {r['expected']})")
        print(f"   Reason: {r['reason']}")

    # Overall stats
    passed = sum(1 for r in results if "✅" in r["status"])
    total = len(results)

    print("\n" + "=" * 70)
    print(f"RESULTS: {passed}/{total} tests matched expectations")

    if passed == total:
        print("\n✅ ALL TESTS PASSED - robots.txt compliance is working!")
    else:
        print(f"\n⚠️  {total - passed} test(s) had unexpected results")
        print("   (This may be due to robots.txt changes on the tested sites)")

    print("\n📝 NOTE: By default, the MCP server RESPECTS robots.txt")
    print("   You can disable it with: configure_robots_txt(respect=False)")
    print("=" * 70)


if __name__ == "__main__":
    test_robots_txt()
