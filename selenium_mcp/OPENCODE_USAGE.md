# Using Selenium MCP with OpenCode

The Selenium MCP server has been added to your OpenCode configuration!

## Configuration

The MCP server is configured in `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "selenium-undetected": {
      "type": "local",
      "command": ["python3", "/data/data/com.termux/files/home/prog/selenium_mcp/selenium_mcp_server.py"],
      "enabled": true
    }
  }
}
```

## Usage Examples

### Basic Web Scraping

```
use selenium-undetected to:
1. Start the browser
2. Navigate to https://example.com
3. Take a screenshot
4. Get the page content
5. Stop the browser
```

### Bot Detection Bypass

```
use selenium-undetected to test if we can bypass bot detection on nowsecure.nl
```

### Form Automation

```
use selenium-undetected to:
1. Start browser
2. Go to https://example.com/contact
3. Fill out the contact form with:
   - Name: John Doe
   - Email: john@example.com
   - Message: Hello world
4. Submit the form
5. Take a screenshot of the result
```

### Data Extraction

```
use selenium-undetected to scrape the top 10 posts from https://news.ycombinator.com and give me the titles and URLs
```

## Available Tools

The MCP server exposes all the tools from `selenium_mcp_server.py`:

### Browser Management
- `start_browser` - Start Chrome with Xvfb and stealth mode
- `stop_browser` - Close browser and cleanup
- `get_browser_status` - Check browser status

### Navigation
- `navigate` - Go to a URL
- `screenshot` - Capture screenshot
- `find_elements` - Find elements on page
- `click_element` - Click an element
- `type_text` - Type into input field

And many more! Check the server file for the complete list.

## Tips

### Using in Prompts

You can reference the MCP server by name:

```
use selenium-undetected to...
```

### Adding to AGENTS.md Rules

You can make it automatic by adding to `~/.config/opencode/AGENTS.md`:

```markdown
When you need to interact with websites, scrape data, or bypass bot detection, use the `selenium-undetected` MCP server.
```

### Disabling Globally, Enabling Per Agent

If you only want certain agents to use Selenium:

```json
{
  "tools": {
    "selenium-undetected_*": false
  },
  "agent": {
    "web-scraper": {
      "tools": {
        "selenium-undetected_*": true
      }
    }
  }
}
```

## Troubleshooting

### Check if MCP is loaded

```bash
opencode mcp list
```

### Test the server manually

```bash
python3 /data/data/com.termux/files/home/prog/selenium_mcp/selenium_mcp_server.py
```

### View MCP logs

Check OpenCode logs for any MCP connection issues.

## Advanced Usage

### Custom User Agent

```
use selenium-undetected to start browser with a mobile user agent
```

### Without Xvfb (headless mode)

```
use selenium-undetected to start browser in headless mode without Xvfb
```

### Specific Window Size

```
use selenium-undetected to start browser with 1366x768 resolution
```

## Benefits

✅ **Undetected** - Bypasses most bot detection systems
✅ **Xvfb Display** - No visible browser windows
✅ **Selenium Stealth** - JavaScript-level anti-detection
✅ **Full Selenium API** - All Selenium features available
✅ **Easy to Use** - Just mention it in your prompts

Enjoy automated web browsing with OpenCode!
