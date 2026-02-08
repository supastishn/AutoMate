# CAPTCHA Solving Integration Guide

## Overview

The Selenium MCP server now includes integration with professional CAPTCHA solving services to handle CAPTCHAs encountered during automation.

⚠️ **IMPORTANT**: CAPTCHA solving costs money and should only be used when necessary and legally permissible.

## Supported Services

### 1. 2Captcha (https://2captcha.com)
- **Pricing**: ~$2.99 per 1000 CAPTCHAs
- **Speed**: Fast (5-15 seconds average)
- **Accuracy**: ~95%+
- **Free Credits**: Small trial available

### 2. AntiCaptcha (https://anti-captcha.com)
- **Pricing**: ~$0.50-$2.00 per 1000 CAPTCHAs  
- **Speed**: Very fast (3-10 seconds)
- **Accuracy**: ~98%+
- **Free Credits**: Trial credits available

## Supported CAPTCHA Types

✅ **Google reCAPTCHA v2** (checkbox "I'm not a robot")
✅ **hCaptcha** (similar to reCAPTCHA)
⚠️ **reCAPTCHA v3** (invisible) - Supported by services but harder to automate
⚠️ **Cloudflare Turnstile** - May work with reCAPTCHA methods

## Setup

### Step 1: Get API Key

Choose a service and sign up:
- 2Captcha: https://2captcha.com/enterpage
- AntiCaptcha: https://anti-captcha.com/clients/entrance/login

### Step 2: Configure in MCP Server

```python
# Configure the CAPTCHA solver
configure_captcha_solver(
    service="2captcha",  # or "anticaptcha"
    api_key="your-api-key-here"
)
```

### Step 3: Solve CAPTCHAs

```python
# Solve Google reCAPTCHA v2
result = solve_recaptcha_v2(
    sitekey="6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
    url="https://example.com/page-with-captcha"  # Optional, uses current page
)

if result['success']:
    token = result['token']
    
    # Inject the solution
    inject_captcha_token(token, captcha_type="recaptcha")
    
    # Submit the form
    click_element("button#submit")
```

## Complete Workflow Examples

### Example 1: Google reCAPTCHA v2

```python
# 1. Start browser
start_browser(use_xvfb=True, enable_stealth=True)

# 2. Configure CAPTCHA solver
configure_captcha_solver(service="2captcha", api_key="YOUR_API_KEY")

# 3. Navigate to page
navigate("https://www.google.com/recaptcha/api2/demo")

# 4. Find the site key (inspect page source)
# Look for: <div class="g-recaptcha" data-sitekey="...">
sitekey = "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"

# 5. Solve CAPTCHA
result = solve_recaptcha_v2(sitekey=sitekey)

if result['success']:
    # 6. Inject solution
    inject_captcha_token(result['token'], captcha_type="recaptcha")
    
    # 7. Submit form
    click_element("button#recaptcha-demo-submit")
    
    # 8. Wait for success
    time.sleep(2)
    screenshot()  # Verify success
```

### Example 2: hCaptcha

```python
# 1. Start and configure
start_browser()
configure_captcha_solver(service="anticaptcha", api_key="YOUR_KEY")

# 2. Navigate
navigate("https://accounts.hcaptcha.com/demo")

# 3. Get site key from page source
# <div class="h-captcha" data-sitekey="...">
sitekey = "10000000-ffff-ffff-ffff-000000000001"  # Example key

# 4. Solve
result = solve_hcaptcha(sitekey=sitekey)

if result['success']:
    inject_captcha_token(result['token'], captcha_type="hcaptcha")
    # Continue with your automation
```

### Example 3: Finding Site Keys

```python
# Method 1: From page HTML
html = get_page_content("html")
# Search for: data-sitekey="..." in the HTML

# Method 2: Using JavaScript
sitekey = execute_javascript("""
    return document.querySelector('.g-recaptcha').getAttribute('data-sitekey');
""")

# Method 3: For hCaptcha
sitekey = execute_javascript("""
    return document.querySelector('.h-captcha').getAttribute('data-sitekey');
""")
```

## OpenCode Usage

When using with OpenCode:

```
use selenium-undetected to:
1. Configure CAPTCHA solver with 2captcha and API key YOUR_KEY
2. Navigate to https://example.com/with-captcha
3. Solve the reCAPTCHA v2 with sitekey SITE_KEY_HERE
4. Submit the form
```

## Tool Reference

### `configure_captcha_solver(service: str, api_key: str)`

Configure CAPTCHA solving service.

**Parameters:**
- `service` - "2captcha" or "anticaptcha"
- `api_key` - Your API key from the service

**Returns:**
```json
{
  "success": true,
  "service": "2captcha",
  "message": "CAPTCHA solver configured: 2captcha"
}
```

### `solve_recaptcha_v2(sitekey: str, url: str = None)`

Solve Google reCAPTCHA v2.

**Parameters:**
- `sitekey` - The reCAPTCHA site key (from page HTML)
- `url` - Page URL (optional, uses current page)

**Returns:**
```json
{
  "success": true,
  "token": "03AGdBq24PBCbwi...",
  "service": "2captcha",
  "captcha_type": "recaptcha_v2"
}
```

**Time**: Usually 5-20 seconds
**Cost**: ~$0.003 per solve

### `solve_hcaptcha(sitekey: str, url: str = None)`

Solve hCaptcha.

**Parameters:**
- `sitekey` - The hCaptcha site key
- `url` - Page URL (optional)

**Returns:**
```json
{
  "success": true,
  "token": "P0_eyJ0eXAiOiJKV1QiLCJh...",
  "service": "2captcha",
  "captcha_type": "hcaptcha"
}
```

### `inject_captcha_token(token: str, captcha_type: str = "recaptcha")`

Inject solved CAPTCHA token into page.

**Parameters:**
- `token` - Solution token from solve_* function
- `captcha_type` - "recaptcha" or "hcaptcha"

**Returns:**
```json
{
  "success": true,
  "message": "recaptcha token injected successfully"
}
```

## Cost Calculator

### Per Solve Costs

| Service      | reCAPTCHA v2 | hCaptcha | reCAPTCHA v3 |
|--------------|--------------|----------|--------------|
| 2Captcha     | $0.00299     | $0.00299 | $0.00299     |
| AntiCaptcha  | $0.00199     | $0.00099 | $0.00199     |

### Monthly Estimates

**Light Use** (100 CAPTCHAs/month):
- 2Captcha: ~$0.30/month
- AntiCaptcha: ~$0.10-$0.20/month

**Medium Use** (1,000 CAPTCHAs/month):
- 2Captcha: ~$3/month
- AntiCaptcha: ~$1-$2/month

**Heavy Use** (10,000 CAPTCHAs/month):
- 2Captcha: ~$30/month
- AntiCaptcha: ~$10-$20/month

## Troubleshooting

### "CAPTCHA solver not configured"
```python
# Solution: Configure solver first
configure_captcha_solver(service="2captcha", api_key="YOUR_KEY")
```

### "Failed to solve CAPTCHA"
- Check API key is valid
- Ensure you have credits in your account
- Check site key is correct
- Try different service (2Captcha vs AntiCaptcha)

### "Token injection failed"
- Verify CAPTCHA type matches (recaptcha vs hcaptcha)
- Check page still has CAPTCHA element
- May need to wait for page to fully load

### "ERROR_ZERO_BALANCE"
- Add credits to your account
- Both services accept PayPal, credit cards, crypto

## Best Practices

### ✅ DO

- Cache solved tokens when possible
- Check if CAPTCHA is actually required
- Use bypass techniques first (undetected-chromedriver may avoid CAPTCHAs)
- Monitor your API usage/costs
- Respect website terms of service

### ❌ DON'T

- Solve CAPTCHAs unnecessarily (costs money!)
- Share API keys publicly
- Exceed rate limits
- Use for illegal purposes
- Ignore failed solves (handle errors)

## Ethical Considerations

### When CAPTCHA Solving is Acceptable

✅ Testing your own websites
✅ Legitimate automation with permission
✅ Accessibility testing
✅ Personal use within ToS
✅ Research with proper authorization

### When to Avoid

❌ Bypassing security on others' sites without permission
❌ Scraping protected content
❌ Spam or abuse
❌ Violating terms of service
❌ Illegal activities

## API Key Security

### Environment Variables (Recommended)

```bash
# Set in environment
export CAPTCHA_API_KEY="your-key-here"
export CAPTCHA_SERVICE="2captcha"

# Use in code
api_key = os.getenv("CAPTCHA_API_KEY")
configure_captcha_solver(service="2captcha", api_key=api_key)
```

### Secure Storage

Never commit API keys to git! Use:
- Environment variables
- Secure key vaults
- Encrypted configuration files
- `.env` files (add to `.gitignore`)

## Advanced Usage

### Retry Logic

```python
def solve_with_retry(sitekey, max_attempts=3):
    for attempt in range(max_attempts):
        result = solve_recaptcha_v2(sitekey)
        if result['success']:
            return result
        time.sleep(2)
    return {"success": False, "error": "Max retries exceeded"}
```

### Balance Checking

```python
# For 2Captcha
balance = execute_javascript("""
    fetch('https://2captcha.com/res.php?key=YOUR_KEY&action=getbalance')
        .then(r => r.text())
""")
```

## Comparison: Bypass vs Solve

| Approach | Speed | Cost | Success Rate | Use Case |
|----------|-------|------|--------------|----------|
| **Bot Detection Bypass** | Instant | Free | 60-80% | Cloudflare, general protection |
| **CAPTCHA Solving** | 5-20s | $0.001-$0.003 | 95-98% | Actual CAPTCHAs |

**Recommendation**: Always try bypass first, use solving only when necessary!

## Summary

✅ **Integrated**: 2Captcha and AntiCaptcha support
✅ **Easy to Use**: Simple API with 4 tools
✅ **Cost Effective**: Pay per solve, as low as $0.001
✅ **Fast**: 5-20 second average solve time
✅ **Reliable**: 95-98% success rates

The Selenium MCP server now handles both bot detection bypass AND CAPTCHA solving!
