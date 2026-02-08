# Selenium MCP Server - Undetected Edition

This is an enhanced version of the Selenium MCP Server with bot detection bypass capabilities.

## Features

- ✅ **Undetected ChromeDriver**: Uses `undetected-chromedriver` to bypass most bot detection systems
- ✅ **Selenium Stealth**: Additional anti-detection measures with `selenium-stealth`
- ✅ **Xvfb Virtual Display**: Runs Chrome with a real display (via Xvfb) instead of headless mode for better detection evasion
- ✅ **Realistic Browser Fingerprint**: Mimics genuine Chrome browser behavior

## Installation

```bash
pip install -r requirements.txt
```

### System Dependencies

Make sure you have these system packages installed:

```bash
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install chromium-browser xvfb

# Or for Termux
pkg install chromium x11-repo
pkg install xorg-xvfb
```

## Usage

### Starting the Browser

The `start_browser` tool now uses Chrome with undetected-chromedriver:

```python
start_browser(
    use_xvfb=True,          # Use Xvfb virtual display (recommended)
    window_width=1920,       # Browser width
    window_height=1080,      # Browser height
    user_agent=None,         # Optional custom user agent
    enable_stealth=True,     # Enable selenium-stealth
    headless=False          # Don't use headless mode (not recommended)
)
```

### Key Differences from Original

1. **Browser**: Changed from Firefox to Chrome (via undetected-chromedriver)
2. **Display**: Uses Xvfb virtual display instead of headless mode by default
3. **Detection Evasion**: Multiple anti-bot detection techniques applied
4. **No Driver Path**: undetected-chromedriver auto-manages ChromeDriver

### Testing

Run the test script to verify bot detection bypass:

```bash
python test_undetected.py
```

## How It Works

### Undetected ChromeDriver

- Automatically patches ChromeDriver to remove detection markers
- Randomizes browser fingerprints
- Updates automatically to match Chrome versions

### Selenium Stealth

Applies JavaScript patches to hide automation signatures:
- Removes `navigator.webdriver` flag
- Patches `chrome.runtime`
- Fixes plugin/language inconsistencies
- Corrects WebGL vendor/renderer info

### Xvfb (X Virtual Framebuffer)

- Runs a real X11 display server in memory
- Chrome runs in "normal" mode, not headless
- Harder to detect than headless Chrome
- No visible windows on your actual display

## Configuration

All the original Selenium MCP tools remain available. Only the browser initialization has changed.

## Troubleshooting

### Chrome/Chromium Not Found

```bash
# Install chromium
sudo apt-get install chromium-browser
```

### Xvfb Not Available

```bash
# Install xvfb
sudo apt-get install xvfb
```

### Headless Fallback

If you can't use Xvfb, set `use_xvfb=False` and `headless=True`:

```python
start_browser(use_xvfb=False, headless=True)
```

Note: Headless mode is easier to detect but may work for some sites.

## Original Features

All original Selenium MCP features are preserved:
- Navigate websites
- Capture screenshots
- Extract page content
- Interact with elements
- Execute JavaScript
- Manage cookies
- Wait for elements
- And much more...

## Credits

Built on top of:
- [undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver)
- [selenium-stealth](https://github.com/diprajpatra/selenium-stealth)
- [PyVirtualDisplay](https://github.com/ponty/PyVirtualDisplay)
