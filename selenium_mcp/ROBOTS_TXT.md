# Robots.txt Compliance Guide

## Overview

The Selenium MCP server **respects robots.txt by default** to ensure ethical web scraping and automation.

## How It Works

1. **Automatic Checking**: Before navigating to any URL, the server fetches and parses the site's `/robots.txt`
2. **User-Agent Based**: Checks rules for user-agent `Mozilla/5.0 (compatible; SeleniumMCP/1.0)`
3. **Caching**: Robots.txt files are cached per domain to avoid repeated requests
4. **Blocking**: If a URL is disallowed, navigation is blocked with a clear error message

## Default Behavior

✅ **Respects robots.txt** - Enabled by default  
✅ **Blocks disallowed URLs** - Returns error instead of navigating  
✅ **Provides clear feedback** - Error messages explain why URLs are blocked  

## Testing

Run the robots.txt test:

```bash
python test_robots.py
```

This tests against real sites (Google, GitHub, Amazon, etc.) and verifies:
- ✅ Allowed URLs can be accessed
- ✅ Disallowed URLs are blocked
- ✅ Configuration changes work properly

## Usage Examples

### Check a URL Before Navigating

```python
# Check if URL is allowed by robots.txt
check_robots_txt("https://www.google.com/search")
# Returns: {"allowed": False, "reason": "Disallowed by robots.txt..."}

check_robots_txt("https://www.google.com/")
# Returns: {"allowed": True, "reason": "Allowed by robots.txt"}
```

### Navigate (Automatic Check)

```python
# This will be blocked:
navigate("https://www.google.com/search")
# Returns: {"success": False, "error": "Navigation blocked by robots.txt..."}

# This will succeed:
navigate("https://www.google.com/")
# Returns: {"success": True, "title": "Google", ...}
```

### Skip Robots.txt Check (Not Recommended)

```python
# Force navigation even if disallowed
navigate("https://www.google.com/search", skip_robots_check=True)
# Returns: {"success": True, ...}
```

### Configure Robots.txt Behavior

```python
# Disable robots.txt compliance (not recommended)
configure_robots_txt(respect=False)

# Now all URLs will be allowed
navigate("https://www.google.com/search")  # Will work

# Re-enable compliance
configure_robots_txt(respect=True)
```

### Custom User Agent

```python
# Use a custom user agent for robots.txt checks
configure_robots_txt(
    respect=True,
    user_agent="MyBot/1.0 (+https://mysite.com/bot)"
)
```

## Tool Reference

### `check_robots_txt(url: str)`

Check if a URL is allowed without navigating.

**Parameters:**
- `url` - URL to check

**Returns:**
```json
{
  "success": true,
  "url": "https://example.com/page",
  "allowed": true,
  "reason": "Allowed by robots.txt",
  "user_agent": "Mozilla/5.0 (compatible; SeleniumMCP/1.0)"
}
```

### `configure_robots_txt(respect: bool = True, user_agent: str = None)`

Configure robots.txt compliance settings.

**Parameters:**
- `respect` - Whether to respect robots.txt (default: `True`)
- `user_agent` - Custom user agent string (optional)

**Returns:**
```json
{
  "success": true,
  "respect_robots_txt": true,
  "user_agent": "Mozilla/5.0 (compatible; SeleniumMCP/1.0)",
  "message": "robots.txt compliance enabled"
}
```

### `navigate(url: str, skip_robots_check: bool = False)`

Navigate to URL with optional robots.txt bypass.

**Parameters:**
- `url` - URL to navigate to
- `skip_robots_check` - Skip robots.txt check (default: `False`)

**Returns:**
```json
{
  "success": true,
  "title": "Page Title",
  "url": "https://example.com/",
  "robots_txt_check": {
    "allowed": true,
    "reason": "Allowed by robots.txt"
  }
}
```

## Examples by Site

### Google

```python
# ✅ Allowed
navigate("https://www.google.com/")

# ❌ Blocked
navigate("https://www.google.com/search")
```

### GitHub

```python
# ✅ Allowed
navigate("https://github.com/")
navigate("https://github.com/explore")
```

### Amazon

```python
# ✅ Allowed
navigate("https://www.amazon.com/")

# ❌ Blocked
navigate("https://www.amazon.com/gp/cart/")
```

## Best Practices

### ✅ DO

- Keep robots.txt compliance enabled
- Check URLs before automating
- Use descriptive user-agent strings
- Respect crawl delays (if specified)
- Read the full robots.txt if doing extensive scraping

### ❌ DON'T

- Disable robots.txt without good reason
- Use skip_robots_check unless absolutely necessary
- Pretend to be a real browser user-agent when you're a bot
- Ignore disallow rules

## Ethical Considerations

**Why we enforce robots.txt by default:**

1. **Legal Compliance** - Respecting robots.txt shows good faith
2. **Server Load** - Prevents overwhelming servers with automated requests
3. **Terms of Service** - Many sites require robots.txt compliance
4. **Responsible Automation** - Be a good citizen of the web

**When you might disable it:**

- Testing your own websites
- Emergency situations with explicit permission
- Sites with overly restrictive but legally unenforceable rules
- Research with proper authorization

## Troubleshooting

### URL Unexpectedly Blocked

Check the site's robots.txt manually:

```bash
curl https://example.com/robots.txt
```

Look for rules matching your user-agent or `*` (all bots).

### Want to See What's Blocked

```python
# Check before navigating
result = check_robots_txt("https://example.com/some/path")
print(f"Allowed: {result['allowed']}")
print(f"Reason: {result['reason']}")
```

### Cache Issues

The robots.txt cache is cleared when you:
- Restart the MCP server
- Call `configure_robots_txt()`

## Integration with OpenCode

When using with OpenCode, robots.txt checking happens automatically:

```
use selenium-undetected to navigate to https://google.com/search
```

Response will show if navigation was blocked:
```
❌ Navigation blocked by robots.txt: Disallowed for user-agent...
```

You can check URLs first:
```
use selenium-undetected to check if https://google.com/search is allowed by robots.txt
```

## Conclusion

Robots.txt compliance ensures your Selenium automation is:
- ✅ Ethical
- ✅ Legal
- ✅ Respectful of server resources
- ✅ Following industry standards

Keep it enabled unless you have a very good reason not to!
