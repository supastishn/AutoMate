# Quick Start Guide - Undetected Selenium MCP

## Installation

```bash
# 1. Install system dependencies
sudo dnf install chromium chromedriver xorg-x11-server-Xvfb

# 2. Install Python dependencies
pip install -r requirements.txt
```

## Basic Usage

### Start the MCP Server

```bash
python selenium_mcp_server.py
```

### Using with MCP Client

```json
{
  "mcpServers": {
    "selenium-undetected": {
      "command": "python",
      "args": ["/path/to/selenium_mcp/selenium_mcp_server.py"],
      "env": {}
    }
  }
}
```

## Example Workflow

```python
# 1. Start browser with Xvfb and stealth mode
start_browser(use_xvfb=True, enable_stealth=True)

# 2. Navigate to website
navigate("https://example.com")

# 3. Interact with page (bot detection bypassed!)
type_text("#search", "test query")
click_element("button[type='submit']")

# 4. Extract data
screenshot()
get_page_content("text")

# 5. Cleanup
stop_browser()
```

## Key Features

✅ **Undetected** - Bypasses most bot detection systems
✅ **Xvfb Display** - No visible browser windows
✅ **Selenium Stealth** - JavaScript-level anti-detection
✅ **All Original Tools** - 100% compatible with original Selenium MCP

## Testing Bot Detection

Run the included test:

```bash
python test_undetected.py
```

Should output: `✅ Successfully passed bot detection!`

## Troubleshooting

### Chrome/Chromium not found
```bash
sudo dnf install chromium
```

### ChromeDriver not found
```bash
sudo dnf install chromedriver
```

### Xvfb not available
```bash
sudo dnf install xorg-x11-server-Xvfb
```

### Fallback to headless (not recommended)
```python
start_browser(use_xvfb=False, headless=True)
```

## Advanced Configuration

### Custom User Agent
```python
start_browser(user_agent="Mozilla/5.0 ...")
```

### Disable Stealth (not recommended)
```python
start_browser(enable_stealth=False)
```

### Custom Window Size
```python
start_browser(window_width=1366, window_height=768)
```

## What Changed?

- **Browser**: Firefox → Chrome/Chromium  
- **Driver**: geckodriver → undetected-chromedriver
- **Display**: Headless → Xvfb virtual display
- **Detection**: None → Multiple anti-bot techniques

All other tools work exactly the same!
