#!/usr/bin/env python3
"""
Selenium MCP Server - Provides AI access to web browsers via Selenium WebDriver.

This MCP server enables AI assistants to:
- Navigate websites
- Capture screenshots
- Extract page content (text and HTML)
- Interact with elements (click, type, etc.)
- Execute JavaScript
- Manage cookies
- Wait for elements

Configuration:
- Uses undetected-chromedriver to bypass bot detection
- Selenium-stealth for additional anti-detection measures
- Xvfb virtual display instead of headless mode
- Chrome browser with stealth settings
- Respects robots.txt by default
"""

import asyncio
import base64
import json
import os
from typing import Any, Optional
from urllib.parse import urlparse, urljoin
import urllib.request

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.remote.webelement import WebElement
from selenium.common.exceptions import (
    TimeoutException,
    NoSuchElementException,
    WebDriverException,
    StaleElementReferenceException,
)

# Undetected ChromeDriver and Stealth imports
import undetected_chromedriver as uc
from selenium_stealth import stealth
from pyvirtualdisplay import Display

# Robots.txt parser
from robotexclusionrulesparser import RobotExclusionRulesParser

# CAPTCHA solving services
from twocaptcha import TwoCaptcha
from anticaptchaofficial.recaptchav2proxyless import recaptchaV2Proxyless
from anticaptchaofficial.hcaptchaproxyless import hCaptchaProxyless

from mcp.server.fastmcp import FastMCP

# Global browser instance and virtual display
_browser: Optional[uc.Chrome] = None
_display: Optional[Display] = None

# Global robots.txt settings
_respect_robots_txt: bool = True
_robots_cache: dict = {}  # Cache robots.txt parsers by domain
_user_agent: str = (
    "Mozilla/5.0 (compatible; SeleniumMCP/1.0; +https://github.com/your-repo)"
)

# CAPTCHA solving settings
_captcha_service: Optional[str] = None  # "2captcha", "anticaptcha", or None
_captcha_api_key: Optional[str] = None
_captcha_solver: Optional[any] = None

# Default configuration (can be overridden via tool parameters)
DEFAULT_WINDOW_WIDTH = 1920
DEFAULT_WINDOW_HEIGHT = 1080
DEFAULT_USE_XVFB = True

# Initialize MCP server
mcp = FastMCP("Selenium Browser Automation - Undetected")


def get_robots_parser(url: str) -> Optional[RobotExclusionRulesParser]:
    """Get robots.txt parser for a domain, with caching."""
    global _robots_cache

    parsed = urlparse(url)
    domain = f"{parsed.scheme}://{parsed.netloc}"

    # Check cache
    if domain in _robots_cache:
        return _robots_cache[domain]

    # Fetch robots.txt
    robots_url = urljoin(domain, "/robots.txt")
    parser = RobotExclusionRulesParser()

    try:
        with urllib.request.urlopen(robots_url, timeout=5) as response:
            robots_content = response.read().decode("utf-8")
            parser.parse(robots_content)
            _robots_cache[domain] = parser
            return parser
    except Exception as e:
        # If robots.txt doesn't exist or can't be fetched, allow by default
        parser.parse("")  # Empty robots.txt allows everything
        _robots_cache[domain] = parser
        return parser


def is_url_allowed(url: str, user_agent: Optional[str] = None) -> tuple[bool, str]:
    """
    Check if URL is allowed by robots.txt.

    Returns:
        tuple: (is_allowed: bool, reason: str)
    """
    global _respect_robots_txt, _user_agent

    if not _respect_robots_txt:
        return True, "robots.txt checking disabled"

    ua = user_agent or _user_agent
    parser = get_robots_parser(url)

    if parser is None:
        return True, "No robots.txt found (allowed by default)"

    parsed = urlparse(url)
    path = parsed.path or "/"

    if parser.is_allowed(ua, path):
        return True, "Allowed by robots.txt"
    else:
        return False, f"Disallowed by robots.txt for user-agent '{ua}'"


def get_by_strategy(by: str) -> By:
    """Convert string strategy to Selenium By enum."""
    strategies = {
        "css": By.CSS_SELECTOR,
        "xpath": By.XPATH,
        "id": By.ID,
        "class": By.CLASS_NAME,
        "tag": By.TAG_NAME,
        "name": By.NAME,
        "link_text": By.LINK_TEXT,
        "partial_link_text": By.PARTIAL_LINK_TEXT,
    }
    return strategies.get(by.lower(), By.CSS_SELECTOR)


def element_to_dict(element: WebElement) -> dict:
    """Convert WebElement to dictionary representation."""
    try:
        return {
            "tag_name": element.tag_name,
            "text": element.text,
            "is_displayed": element.is_displayed(),
            "is_enabled": element.is_enabled(),
            "location": element.location,
            "size": element.size,
            "attributes": {
                "id": element.get_attribute("id"),
                "class": element.get_attribute("class"),
                "name": element.get_attribute("name"),
                "href": element.get_attribute("href"),
                "src": element.get_attribute("src"),
                "value": element.get_attribute("value"),
                "type": element.get_attribute("type"),
                "placeholder": element.get_attribute("placeholder"),
            },
        }
    except StaleElementReferenceException:
        return {"error": "Element is stale (page may have changed)"}


# ============================================================================
# Browser Session Management Tools
# ============================================================================


@mcp.tool()
def start_browser(
    use_xvfb: bool = True,
    window_width: int = 1920,
    window_height: int = 1080,
    user_agent: Optional[str] = None,
    enable_stealth: bool = True,
    headless: bool = False,
) -> dict:
    """
    Start a Chrome browser session with undetected-chromedriver and optional Xvfb.

    Args:
        use_xvfb: Use Xvfb virtual display instead of headless mode. Default True.
        window_width: Browser window width in pixels. Default 1920.
        window_height: Browser window height in pixels. Default 1080.
        user_agent: Custom user agent string. Default None (uses realistic UA).
        enable_stealth: Enable selenium-stealth anti-detection. Default True.
        headless: Use headless mode (not recommended, easier to detect). Default False.

    Returns:
        Status dict with success boolean and message.
    """
    global _browser, _display

    if _browser is not None:
        return {
            "success": False,
            "message": "Browser already running. Call stop_browser first.",
        }

    try:
        # Start Xvfb virtual display if requested
        if use_xvfb and not headless:
            _display = Display(visible=False, size=(window_width, window_height))
            _display.start()

        # Configure Chrome options - enhanced anti-detection
        chrome_options = uc.ChromeOptions()

        # Core anti-detection arguments
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument(f"--window-size={window_width},{window_height}")
        chrome_options.add_argument("--start-maximized")

        # Enhanced stealth arguments
        chrome_options.add_argument("--disable-blink-features=AutomationControlled")
        chrome_options.add_argument("--disable-infobars")
        chrome_options.add_argument("--disable-browser-side-navigation")
        chrome_options.add_argument("--disable-extensions")
        chrome_options.add_argument("--disable-gpu")
        chrome_options.add_argument("--disable-features=VizDisplayCompositor")

        # Additional preferences to appear more human
        prefs = {
            "credentials_enable_service": False,
            "profile.password_manager_enabled": False,
            "profile.default_content_setting_values.notifications": 2,
        }
        chrome_options.add_experimental_option("prefs", prefs)

        if user_agent:
            chrome_options.add_argument(f"user-agent={user_agent}")

        if headless:
            chrome_options.add_argument("--headless=new")

        # Try to find Chrome/Chromium binary
        chrome_paths = [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/sbin/chromium-browser",
        ]
        for path in chrome_paths:
            if os.path.exists(path):
                chrome_options.binary_location = path
                break

        # Try to find chromedriver
        driver_paths = [
            "/usr/bin/chromedriver",
            "/usr/sbin/chromedriver",
            "/usr/local/bin/chromedriver",
        ]
        driver_path = None
        for path in driver_paths:
            if os.path.exists(path):
                driver_path = path
                break

        # Initialize undetected Chrome
        if driver_path:
            _browser = uc.Chrome(
                options=chrome_options,
                driver_executable_path=driver_path,
                use_subprocess=True,
                version_main=144,  # Match installed chromium version
            )
        else:
            _browser = uc.Chrome(
                options=chrome_options, use_subprocess=True, version_main=144
            )

        # Apply selenium-stealth if enabled
        if enable_stealth:
            stealth(
                _browser,
                languages=["en-US", "en"],
                vendor="Google Inc.",
                platform="Win32",
                webgl_vendor="Intel Inc.",
                renderer="Intel Iris OpenGL Engine",
                fix_hairline=True,
            )

            # Apply additional JavaScript patches via CDP
            try:
                _browser.execute_cdp_cmd(
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
            except Exception:
                pass  # CDP commands may not work on all Chrome versions

        # Set window size explicitly
        _browser.set_window_size(window_width, window_height)

        return {
            "success": True,
            "message": f"Browser started successfully. Xvfb: {use_xvfb and not headless}, Stealth: {enable_stealth}, Size: {window_width}x{window_height}",
            "using_xvfb": use_xvfb and not headless,
            "stealth_enabled": enable_stealth,
        }

    except Exception as e:
        # Cleanup on error
        if _display:
            try:
                _display.stop()
                _display = None
            except:
                pass
        return {"success": False, "message": f"Failed to start browser: {str(e)}"}


@mcp.tool()
def configure_robots_txt(
    respect: bool = True, user_agent: Optional[str] = None
) -> dict:
    """
    Configure robots.txt compliance settings.

    Args:
        respect: Whether to respect robots.txt rules. Default True.
        user_agent: Custom user agent to use for robots.txt checks.
                   Default is "Mozilla/5.0 (compatible; SeleniumMCP/1.0)".

    Returns:
        Dict with current configuration.
    """
    global _respect_robots_txt, _user_agent, _robots_cache

    _respect_robots_txt = respect

    if user_agent:
        _user_agent = user_agent

    # Clear cache when settings change
    _robots_cache.clear()

    return {
        "success": True,
        "respect_robots_txt": _respect_robots_txt,
        "user_agent": _user_agent,
        "message": f"robots.txt compliance {'enabled' if respect else 'disabled'}",
    }


@mcp.tool()
def check_robots_txt(url: str) -> dict:
    """
    Check if a URL is allowed by robots.txt without navigating to it.

    Args:
        url: The URL to check.

    Returns:
        Dict with robots.txt status for the URL.
    """
    global _user_agent

    allowed, reason = is_url_allowed(url, _user_agent)

    return {
        "success": True,
        "url": url,
        "allowed": allowed,
        "reason": reason,
        "user_agent": _user_agent,
    }


# ============================================================================
# CAPTCHA Solving Tools
# ============================================================================


@mcp.tool()
def configure_captcha_solver(service: str, api_key: str) -> dict:
    """
    Configure CAPTCHA solving service.

    Args:
        service: CAPTCHA service to use ("2captcha" or "anticaptcha")
        api_key: API key for the service

    Returns:
        Dict with configuration status
    """
    global _captcha_service, _captcha_api_key, _captcha_solver

    _captcha_service = service.lower()
    _captcha_api_key = api_key

    try:
        if _captcha_service == "2captcha":
            _captcha_solver = TwoCaptcha(api_key)
        elif _captcha_service == "anticaptcha":
            # AntiCaptcha uses different solvers per CAPTCHA type
            _captcha_solver = None  # Will be created per request
        else:
            return {
                "success": False,
                "error": f"Unknown service: {service}. Use '2captcha' or 'anticaptcha'",
            }

        return {
            "success": True,
            "service": _captcha_service,
            "message": f"CAPTCHA solver configured: {_captcha_service}",
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to configure CAPTCHA solver: {str(e)}",
        }


@mcp.tool()
def solve_recaptcha_v2(sitekey: str, url: Optional[str] = None) -> dict:
    """
    Solve Google reCAPTCHA v2.

    Args:
        sitekey: The reCAPTCHA site key
        url: URL of the page (optional, uses current page if not provided)

    Returns:
        Dict with solution token
    """
    global _browser, _captcha_service, _captcha_api_key, _captcha_solver

    if not _captcha_service or not _captcha_api_key:
        return {
            "success": False,
            "error": "CAPTCHA solver not configured. Call configure_captcha_solver first.",
        }

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    # Get current URL if not provided
    if not url:
        url = _browser.current_url

    try:
        if _captcha_service == "2captcha":
            result = _captcha_solver.recaptcha(sitekey=sitekey, url=url)
            token = result["code"]
        elif _captcha_service == "anticaptcha":
            solver = recaptchaV2Proxyless()
            solver.set_key(_captcha_api_key)
            solver.set_website_url(url)
            solver.set_website_key(sitekey)
            token = solver.solve_and_return_solution()
            if token == 0:
                return {
                    "success": False,
                    "error": f"AntiCaptcha error: {solver.error_code}",
                }
        else:
            return {
                "success": False,
                "error": f"Service {_captcha_service} not supported for reCAPTCHA v2",
            }

        return {
            "success": True,
            "token": token,
            "service": _captcha_service,
            "captcha_type": "recaptcha_v2",
        }
    except Exception as e:
        return {"success": False, "error": f"Failed to solve reCAPTCHA: {str(e)}"}


@mcp.tool()
def solve_hcaptcha(sitekey: str, url: Optional[str] = None) -> dict:
    """
    Solve hCaptcha.

    Args:
        sitekey: The hCaptcha site key
        url: URL of the page (optional, uses current page if not provided)

    Returns:
        Dict with solution token
    """
    global _browser, _captcha_service, _captcha_api_key, _captcha_solver

    if not _captcha_service or not _captcha_api_key:
        return {
            "success": False,
            "error": "CAPTCHA solver not configured. Call configure_captcha_solver first.",
        }

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    if not url:
        url = _browser.current_url

    try:
        if _captcha_service == "2captcha":
            result = _captcha_solver.hcaptcha(sitekey=sitekey, url=url)
            token = result["code"]
        elif _captcha_service == "anticaptcha":
            solver = hCaptchaProxyless()
            solver.set_key(_captcha_api_key)
            solver.set_website_url(url)
            solver.set_website_key(sitekey)
            token = solver.solve_and_return_solution()
            if token == 0:
                return {
                    "success": False,
                    "error": f"AntiCaptcha error: {solver.error_code}",
                }
        else:
            return {
                "success": False,
                "error": f"Service {_captcha_service} not supported for hCaptcha",
            }

        return {
            "success": True,
            "token": token,
            "service": _captcha_service,
            "captcha_type": "hcaptcha",
        }
    except Exception as e:
        return {"success": False, "error": f"Failed to solve hCaptcha: {str(e)}"}


@mcp.tool()
def inject_captcha_token(token: str, captcha_type: str = "recaptcha") -> dict:
    """
    Inject a CAPTCHA solution token into the page.

    Args:
        token: The CAPTCHA solution token
        captcha_type: Type of CAPTCHA ("recaptcha" or "hcaptcha")

    Returns:
        Dict with injection status
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        if captcha_type == "recaptcha":
            # Inject token into reCAPTCHA response field
            _browser.execute_script(f"""
                document.getElementById('g-recaptcha-response').innerHTML = '{token}';
                if (typeof ___grecaptcha_cfg !== 'undefined') {{
                    for (var cid in ___grecaptcha_cfg.clients) {{
                        if (___grecaptcha_cfg.clients.hasOwnProperty(cid)) {{
                            ___grecaptcha_cfg.clients[cid].P.P.callback('{token}');
                        }}
                    }}
                }}
            """)
        elif captcha_type == "hcaptcha":
            # Inject token into hCaptcha response field
            _browser.execute_script(f"""
                var textarea = document.querySelector('textarea[name=h-captcha-response]');
                if (textarea) {{
                    textarea.innerHTML = '{token}';
                }}
                var event = new Event('submit');
                if (typeof hcaptcha !== 'undefined') {{
                    hcaptcha.setResponse('{token}');
                }}
            """)
        else:
            return {"success": False, "error": f"Unknown CAPTCHA type: {captcha_type}"}

        return {
            "success": True,
            "message": f"{captcha_type} token injected successfully",
        }
    except Exception as e:
        return {"success": False, "error": f"Failed to inject token: {str(e)}"}


@mcp.tool()
def stop_browser() -> dict:
    """
    Stop the current browser session and clean up resources.

    Returns:
        Status dict with success boolean and message.
    """
    global _browser, _display

    if _browser is None:
        return {"success": False, "message": "No browser session running."}

    try:
        _browser.quit()
        _browser = None

        # Stop Xvfb display if it was started
        if _display:
            _display.stop()
            _display = None

        return {"success": True, "message": "Browser stopped successfully."}
    except Exception as e:
        _browser = None
        if _display:
            try:
                _display.stop()
            except:
                pass
            _display = None
        return {"success": False, "message": f"Error stopping browser: {str(e)}"}


# ============================================================================
# Navigation Tools
# ============================================================================


@mcp.tool()
def navigate(url: str, skip_robots_check: bool = False) -> dict:
    """
    Navigate to a URL (respects robots.txt by default).

    Args:
        url: The URL to navigate to (e.g., "https://example.com").
        skip_robots_check: Skip robots.txt check. Default False.

    Returns:
        Dict with page title and current URL after navigation.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    # Check robots.txt first (unless skipped)
    if not skip_robots_check:
        allowed, reason = is_url_allowed(url)
        if not allowed:
            return {
                "success": False,
                "error": f"Navigation blocked by robots.txt: {reason}",
                "url": url,
                "robots_txt_check": {"allowed": False, "reason": reason},
            }

    try:
        _browser.get(url)
        return {
            "success": True,
            "title": _browser.title,
            "url": _browser.current_url,
            "robots_txt_check": {
                "allowed": True,
                "reason": "Allowed by robots.txt"
                if not skip_robots_check
                else "Skipped",
            },
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def go_back() -> dict:
    """
    Navigate back in browser history.

    Returns:
        Dict with new page title and URL.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.back()
        return {
            "success": True,
            "title": _browser.title,
            "url": _browser.current_url,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def go_forward() -> dict:
    """
    Navigate forward in browser history.

    Returns:
        Dict with new page title and URL.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.forward()
        return {
            "success": True,
            "title": _browser.title,
            "url": _browser.current_url,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def refresh_page() -> dict:
    """
    Refresh the current page.

    Returns:
        Dict with page title and URL after refresh.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.refresh()
        return {
            "success": True,
            "title": _browser.title,
            "url": _browser.current_url,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Screenshot Tools
# ============================================================================


@mcp.tool()
def screenshot(save_path: Optional[str] = None) -> dict:
    """
    Capture a screenshot of the current page.

    Args:
        save_path: Optional file path to save screenshot. If not provided,
                   returns base64 encoded image data.

    Returns:
        Dict with base64 encoded PNG screenshot or save confirmation.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        if save_path:
            _browser.save_screenshot(save_path)
            return {
                "success": True,
                "message": f"Screenshot saved to {save_path}",
                "path": save_path,
            }
        else:
            screenshot_base64 = _browser.get_screenshot_as_base64()
            return {
                "success": True,
                "format": "png",
                "encoding": "base64",
                "data": screenshot_base64,
            }
    except Exception as e:
        return {"success": False, "error": str(e)}


def screenshot_element(
    selector: str,
    by: str = "css",
    save_path: Optional[str] = None,
) -> dict:
    """
    Capture a screenshot of a specific element.

    Args:
        selector: Element selector (CSS selector, XPath, ID, etc.).
        by: Selector strategy - "css", "xpath", "id", "class", "tag", "name". Default "css".
        save_path: Optional file path to save screenshot.

    Returns:
        Dict with base64 encoded PNG screenshot of the element.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        if save_path:
            element.screenshot(save_path)
            return {
                "success": True,
                "message": f"Element screenshot saved to {save_path}",
                "path": save_path,
            }
        else:
            screenshot_base64 = element.screenshot_as_base64
            return {
                "success": True,
                "format": "png",
                "encoding": "base64",
                "data": screenshot_base64,
            }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Page Content Extraction Tools
# ============================================================================


def get_page_content(content_type: str = "text") -> dict:
    """
    Get the content of the current page.

    Args:
        content_type: Type of content to return:
            - "text": Visible text only (default)
            - "html": Full HTML source
            - "both": Both text and HTML

    Returns:
        Dict with requested page content.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        result = {
            "success": True,
            "url": _browser.current_url,
            "title": _browser.title,
        }

        if content_type in ["text", "both"]:
            # Get visible text from body
            body = _browser.find_element(By.TAG_NAME, "body")
            result["text"] = body.text

        if content_type in ["html", "both"]:
            result["html"] = _browser.page_source

        return result

    except Exception as e:
        return {"success": False, "error": str(e)}


def get_element_text(selector: str, by: str = "css") -> dict:
    """
    Get the text content of a specific element.

    Args:
        selector: Element selector.
        by: Selector strategy - "css", "xpath", "id", "class", "tag", "name". Default "css".

    Returns:
        Dict with element text content.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)
        return {
            "success": True,
            "text": element.text,
            "tag": element.tag_name,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_element_attribute(selector: str, attribute: str, by: str = "css") -> dict:
    """
    Get a specific attribute of an element.

    Args:
        selector: Element selector.
        attribute: Name of the attribute to get (e.g., "href", "src", "value").
        by: Selector strategy. Default "css".

    Returns:
        Dict with attribute value.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)
        value = element.get_attribute(attribute)
        return {
            "success": True,
            "attribute": attribute,
            "value": value,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Element Finding Tools
# ============================================================================


@mcp.tool()
def find_elements(
    selector: str,
    by: str = "css",
    limit: int = 10,
) -> dict:
    """
    Find elements matching a selector.

    Args:
        selector: Element selector (CSS, XPath, etc.).
        by: Selector strategy - "css", "xpath", "id", "class", "tag", "name". Default "css".
        limit: Maximum number of elements to return. Default 10.

    Returns:
        Dict with list of found elements and their properties.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        elements = _browser.find_elements(by_strategy, selector)[:limit]

        return {
            "success": True,
            "count": len(elements),
            "elements": [element_to_dict(el) for el in elements],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def find_links(limit: int = 20) -> dict:
    """
    Find all links on the current page.

    Args:
        limit: Maximum number of links to return. Default 20.

    Returns:
        Dict with list of links (href and text).
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        elements = _browser.find_elements(By.TAG_NAME, "a")[:limit]
        links = []

        for el in elements:
            href = el.get_attribute("href")
            if href:
                links.append(
                    {
                        "text": el.text.strip() or "[No text]",
                        "href": href,
                    }
                )

        return {
            "success": True,
            "count": len(links),
            "links": links,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def find_forms() -> dict:
    """
    Find all forms on the current page with their inputs.

    Returns:
        Dict with list of forms and their input fields.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        forms = _browser.find_elements(By.TAG_NAME, "form")
        form_data = []

        for i, form in enumerate(forms):
            form_info = {
                "index": i,
                "id": form.get_attribute("id"),
                "name": form.get_attribute("name"),
                "action": form.get_attribute("action"),
                "method": form.get_attribute("method"),
                "inputs": [],
            }

            # Find inputs within the form
            inputs = form.find_elements(By.TAG_NAME, "input")
            inputs += form.find_elements(By.TAG_NAME, "textarea")
            inputs += form.find_elements(By.TAG_NAME, "select")

            for inp in inputs:
                form_info["inputs"].append(
                    {
                        "tag": inp.tag_name,
                        "type": inp.get_attribute("type"),
                        "name": inp.get_attribute("name"),
                        "id": inp.get_attribute("id"),
                        "placeholder": inp.get_attribute("placeholder"),
                        "value": inp.get_attribute("value"),
                    }
                )

            form_data.append(form_info)

        return {
            "success": True,
            "count": len(form_data),
            "forms": form_data,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Element Interaction Tools
# ============================================================================


@mcp.tool()
def click_element(selector: str, by: str = "css") -> dict:
    """
    Click on an element.

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)
        element.click()
        return {
            "success": True,
            "message": f"Clicked element: {selector}",
            "new_url": _browser.current_url,
            "new_title": _browser.title,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@mcp.tool()
def type_text(
    selector: str, text: str, by: str = "css", clear_first: bool = True
) -> dict:
    """
    Type text into an input element.

    Args:
        selector: Element selector.
        text: Text to type.
        by: Selector strategy. Default "css".
        clear_first: Clear existing text before typing. Default True.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        if clear_first:
            element.clear()

        element.send_keys(text)
        return {
            "success": True,
            "message": f"Typed text into element: {selector}",
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def submit_form(selector: str, by: str = "css") -> dict:
    """
    Submit a form element.

    Args:
        selector: Form element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status and new page info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)
        element.submit()
        return {
            "success": True,
            "message": "Form submitted",
            "new_url": _browser.current_url,
            "new_title": _browser.title,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def hover_element(selector: str, by: str = "css") -> dict:
    """
    Hover over an element (move mouse to element).

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        from selenium.webdriver.common.action_chains import ActionChains

        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        action = ActionChains(_browser)
        action.move_to_element(element).perform()

        return {
            "success": True,
            "message": f"Hovering over element: {selector}",
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def scroll_to_element(selector: str, by: str = "css") -> dict:
    """
    Scroll to bring an element into view.

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)
        _browser.execute_script("arguments[0].scrollIntoView(true);", element)
        return {
            "success": True,
            "message": f"Scrolled to element: {selector}",
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def scroll_page(direction: str = "down", amount: int = 500) -> dict:
    """
    Scroll the page in a direction.

    Args:
        direction: Scroll direction - "up", "down", "top", "bottom". Default "down".
        amount: Pixels to scroll (for up/down). Default 500.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        if direction == "down":
            _browser.execute_script(f"window.scrollBy(0, {amount});")
        elif direction == "up":
            _browser.execute_script(f"window.scrollBy(0, -{amount});")
        elif direction == "top":
            _browser.execute_script("window.scrollTo(0, 0);")
        elif direction == "bottom":
            _browser.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        else:
            return {"success": False, "error": f"Invalid direction: {direction}"}

        return {
            "success": True,
            "message": f"Scrolled {direction}",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Wait Tools
# ============================================================================


def wait_for_element(
    selector: str,
    by: str = "css",
    timeout: int = 10,
    condition: str = "present",
) -> dict:
    """
    Wait for an element to meet a condition.

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".
        timeout: Maximum wait time in seconds. Default 10.
        condition: Wait condition:
            - "present": Element exists in DOM (default)
            - "visible": Element is visible
            - "clickable": Element is clickable
            - "invisible": Element is not visible

    Returns:
        Dict with success status and element info if found.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        wait = WebDriverWait(_browser, timeout)

        conditions = {
            "present": EC.presence_of_element_located,
            "visible": EC.visibility_of_element_located,
            "clickable": EC.element_to_be_clickable,
            "invisible": EC.invisibility_of_element_located,
        }

        ec_condition = conditions.get(condition, EC.presence_of_element_located)
        element = wait.until(ec_condition((by_strategy, selector)))

        if condition == "invisible":
            return {
                "success": True,
                "message": f"Element became invisible: {selector}",
            }
        else:
            return {
                "success": True,
                "message": f"Element found ({condition}): {selector}",
                "element": element_to_dict(element),
            }

    except TimeoutException:
        return {
            "success": False,
            "error": f"Timeout waiting for element: {selector} (condition: {condition})",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def wait_seconds(seconds: float) -> dict:
    """
    Wait for a specified number of seconds.

    Args:
        seconds: Number of seconds to wait.

    Returns:
        Dict with success status.
    """
    import time

    time.sleep(seconds)
    return {
        "success": True,
        "message": f"Waited {seconds} seconds",
    }


# ============================================================================
# JavaScript Execution Tools
# ============================================================================


def execute_javascript(script: str) -> dict:
    """
    Execute JavaScript code in the browser.

    Args:
        script: JavaScript code to execute.

    Returns:
        Dict with script result.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        result = _browser.execute_script(script)

        # Handle non-serializable results
        if result is None:
            return {"success": True, "result": None}

        try:
            # Try to serialize the result
            json.dumps(result)
            return {"success": True, "result": result}
        except (TypeError, ValueError):
            return {"success": True, "result": str(result)}

    except Exception as e:
        return {"success": False, "error": str(e)}


def execute_javascript_on_element(selector: str, script: str, by: str = "css") -> dict:
    """
    Execute JavaScript on a specific element.

    Args:
        selector: Element selector.
        script: JavaScript code (element available as 'arguments[0]').
        by: Selector strategy. Default "css".

    Returns:
        Dict with script result.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)
        result = _browser.execute_script(script, element)

        if result is None:
            return {"success": True, "result": None}

        try:
            json.dumps(result)
            return {"success": True, "result": result}
        except (TypeError, ValueError):
            return {"success": True, "result": str(result)}

    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Cookie Management Tools
# ============================================================================


def get_cookies() -> dict:
    """
    Get all cookies for the current domain.

    Returns:
        Dict with list of cookies.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        cookies = _browser.get_cookies()
        return {
            "success": True,
            "count": len(cookies),
            "cookies": cookies,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def set_cookie(name: str, value: str, domain: Optional[str] = None) -> dict:
    """
    Set a cookie.

    Args:
        name: Cookie name.
        value: Cookie value.
        domain: Cookie domain (optional, uses current domain if not specified).

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        cookie = {"name": name, "value": value}
        if domain:
            cookie["domain"] = domain

        _browser.add_cookie(cookie)
        return {
            "success": True,
            "message": f"Cookie '{name}' set successfully",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def delete_cookie(name: str) -> dict:
    """
    Delete a specific cookie.

    Args:
        name: Name of the cookie to delete.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.delete_cookie(name)
        return {
            "success": True,
            "message": f"Cookie '{name}' deleted",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def delete_all_cookies() -> dict:
    """
    Delete all cookies for the current domain.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.delete_all_cookies()
        return {
            "success": True,
            "message": "All cookies deleted",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Window/Tab Management Tools
# ============================================================================


def get_window_handles() -> dict:
    """
    Get all window/tab handles.

    Returns:
        Dict with list of window handles and current handle.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        handles = _browser.window_handles
        current = _browser.current_window_handle
        return {
            "success": True,
            "current_handle": current,
            "handles": handles,
            "count": len(handles),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def switch_to_window(handle: str) -> dict:
    """
    Switch to a specific window/tab.

    Args:
        handle: Window handle to switch to.

    Returns:
        Dict with success status and new window info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.switch_to.window(handle)
        return {
            "success": True,
            "message": f"Switched to window: {handle}",
            "title": _browser.title,
            "url": _browser.current_url,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def new_tab(url: Optional[str] = None) -> dict:
    """
    Open a new tab.

    Args:
        url: Optional URL to open in the new tab.

    Returns:
        Dict with new tab handle and info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script("window.open('');")
        _browser.switch_to.window(_browser.window_handles[-1])

        if url:
            _browser.get(url)

        return {
            "success": True,
            "handle": _browser.current_window_handle,
            "title": _browser.title,
            "url": _browser.current_url,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def close_tab() -> dict:
    """
    Close the current tab.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.close()

        # Switch to remaining window if any
        if _browser.window_handles:
            _browser.switch_to.window(_browser.window_handles[0])
            return {
                "success": True,
                "message": "Tab closed, switched to first remaining tab",
                "remaining_tabs": len(_browser.window_handles),
            }
        else:
            return {
                "success": True,
                "message": "Tab closed, no remaining tabs",
            }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Alert/Dialog Handling Tools
# ============================================================================


def handle_alert(action: str = "accept", text: Optional[str] = None) -> dict:
    """
    Handle a JavaScript alert/confirm/prompt dialog.

    Args:
        action: How to handle the alert - "accept", "dismiss", or "get_text". Default "accept".
        text: Text to enter (for prompt dialogs).

    Returns:
        Dict with alert text and success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        alert = _browser.switch_to.alert
        alert_text = alert.text

        if action == "get_text":
            return {
                "success": True,
                "text": alert_text,
            }

        if text is not None:
            alert.send_keys(text)

        if action == "accept":
            alert.accept()
        elif action == "dismiss":
            alert.dismiss()

        return {
            "success": True,
            "action": action,
            "text": alert_text,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Frame/Iframe Handling Tools
# ============================================================================


def switch_to_frame(
    selector: Optional[str] = None, by: str = "css", index: Optional[int] = None
) -> dict:
    """
    Switch to an iframe.

    Args:
        selector: Frame element selector (use this OR index).
        by: Selector strategy. Default "css".
        index: Frame index (use this OR selector).

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        if index is not None:
            _browser.switch_to.frame(index)
            return {
                "success": True,
                "message": f"Switched to frame index {index}",
            }
        elif selector:
            by_strategy = get_by_strategy(by)
            frame = _browser.find_element(by_strategy, selector)
            _browser.switch_to.frame(frame)
            return {
                "success": True,
                "message": f"Switched to frame: {selector}",
            }
        else:
            return {
                "success": False,
                "error": "Must provide either selector or index",
            }
    except NoSuchElementException:
        return {"success": False, "error": f"Frame not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def switch_to_default_content() -> dict:
    """
    Switch back to the main document from an iframe.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.switch_to.default_content()
        return {
            "success": True,
            "message": "Switched to default content",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Quick Action Shortcuts
# ============================================================================


def google_search(query: str) -> dict:
    """
    Perform a Google search and return results.

    Args:
        query: Search query string.

    Returns:
        Dict with search results page info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        import urllib.parse

        search_url = f"https://www.google.com/search?q={urllib.parse.quote(query)}"
        _browser.get(search_url)

        # Wait for results to load
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC

        WebDriverWait(_browser, 10).until(
            EC.presence_of_element_located((By.ID, "search"))
        )

        return {
            "success": True,
            "query": query,
            "url": _browser.current_url,
            "title": _browser.title,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def duckduckgo_search(query: str) -> dict:
    """
    Perform a DuckDuckGo search.

    Args:
        query: Search query string.

    Returns:
        Dict with search page info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        import urllib.parse

        search_url = f"https://duckduckgo.com/?q={urllib.parse.quote(query)}"
        _browser.get(search_url)

        return {
            "success": True,
            "query": query,
            "url": _browser.current_url,
            "title": _browser.title,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def open_and_wait(
    url: str, wait_selector: str, by: str = "css", timeout: int = 10
) -> dict:
    """
    Navigate to URL and wait for a specific element to appear.

    Args:
        url: URL to navigate to.
        wait_selector: Selector of element to wait for.
        by: Selector strategy. Default "css".
        timeout: Max wait time in seconds. Default 10.

    Returns:
        Dict with page info after element appears.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.get(url)

        by_strategy = get_by_strategy(by)
        wait = WebDriverWait(_browser, timeout)
        wait.until(EC.presence_of_element_located((by_strategy, wait_selector)))

        return {
            "success": True,
            "url": _browser.current_url,
            "title": _browser.title,
            "element_found": True,
        }
    except TimeoutException:
        return {
            "success": False,
            "error": f"Timeout waiting for element: {wait_selector}",
            "url": _browser.current_url,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def search_text_on_page(text: str, case_sensitive: bool = False) -> dict:
    """
    Search for text occurrences on the current page.

    Args:
        text: Text to search for.
        case_sensitive: Whether search is case-sensitive. Default False.

    Returns:
        Dict with search results and element locations.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        page_text = _browser.find_element(By.TAG_NAME, "body").text

        if case_sensitive:
            count = page_text.count(text)
            found = text in page_text
        else:
            count = page_text.lower().count(text.lower())
            found = text.lower() in page_text.lower()

        # Try to find elements containing the text
        matching_elements = []
        try:
            xpath = (
                f"//*[contains(text(), '{text}')]"
                if case_sensitive
                else f"//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '{text.lower()}')]"
            )
            elements = _browser.find_elements(By.XPATH, xpath)[:10]
            for el in elements:
                matching_elements.append(
                    {
                        "tag": el.tag_name,
                        "text": el.text[:100] if el.text else "",
                    }
                )
        except Exception:
            pass

        return {
            "success": True,
            "found": found,
            "count": count,
            "matching_elements": matching_elements,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Keyboard & Input Tools
# ============================================================================


def press_key(key: str, selector: Optional[str] = None, by: str = "css") -> dict:
    """
    Press a keyboard key.

    Args:
        key: Key to press (e.g., "enter", "tab", "escape", "backspace", "delete",
             "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
             "f1"-"f12", or any single character).
        selector: Optional element to focus before pressing key.
        by: Selector strategy if selector provided. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.common.action_chains import ActionChains

        key_map = {
            "enter": Keys.ENTER,
            "return": Keys.RETURN,
            "tab": Keys.TAB,
            "escape": Keys.ESCAPE,
            "esc": Keys.ESCAPE,
            "backspace": Keys.BACKSPACE,
            "delete": Keys.DELETE,
            "up": Keys.UP,
            "down": Keys.DOWN,
            "left": Keys.LEFT,
            "right": Keys.RIGHT,
            "home": Keys.HOME,
            "end": Keys.END,
            "pageup": Keys.PAGE_UP,
            "pagedown": Keys.PAGE_DOWN,
            "space": Keys.SPACE,
            "f1": Keys.F1,
            "f2": Keys.F2,
            "f3": Keys.F3,
            "f4": Keys.F4,
            "f5": Keys.F5,
            "f6": Keys.F6,
            "f7": Keys.F7,
            "f8": Keys.F8,
            "f9": Keys.F9,
            "f10": Keys.F10,
            "f11": Keys.F11,
            "f12": Keys.F12,
        }

        actual_key = key_map.get(key.lower(), key)

        if selector:
            by_strategy = get_by_strategy(by)
            element = _browser.find_element(by_strategy, selector)
            element.send_keys(actual_key)
        else:
            action = ActionChains(_browser)
            action.send_keys(actual_key).perform()

        return {
            "success": True,
            "message": f"Pressed key: {key}",
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def key_combination(keys: str, selector: Optional[str] = None, by: str = "css") -> dict:
    """
    Press a key combination (e.g., Ctrl+C, Ctrl+V, Ctrl+A).

    Args:
        keys: Key combination string (e.g., "ctrl+c", "ctrl+shift+s", "alt+f4").
        selector: Optional element to focus first.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.common.action_chains import ActionChains

        modifier_map = {
            "ctrl": Keys.CONTROL,
            "control": Keys.CONTROL,
            "alt": Keys.ALT,
            "shift": Keys.SHIFT,
            "meta": Keys.META,
            "cmd": Keys.COMMAND,
            "command": Keys.COMMAND,
        }

        key_parts = [k.strip().lower() for k in keys.split("+")]

        action = ActionChains(_browser)

        if selector:
            by_strategy = get_by_strategy(by)
            element = _browser.find_element(by_strategy, selector)
            element.click()

        # Press modifiers
        modifiers = []
        main_key = None
        for part in key_parts:
            if part in modifier_map:
                modifiers.append(modifier_map[part])
            else:
                main_key = part

        # Hold modifiers, press key, release modifiers
        for mod in modifiers:
            action.key_down(mod)

        if main_key:
            action.send_keys(main_key)

        for mod in reversed(modifiers):
            action.key_up(mod)

        action.perform()

        return {
            "success": True,
            "message": f"Pressed key combination: {keys}",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def select_dropdown_option(
    selector: str,
    value: Optional[str] = None,
    text: Optional[str] = None,
    index: Optional[int] = None,
    by: str = "css",
) -> dict:
    """
    Select an option from a dropdown/select element.

    Args:
        selector: Select element selector.
        value: Option value to select (use this OR text OR index).
        text: Option visible text to select.
        index: Option index to select (0-based).
        by: Selector strategy. Default "css".

    Returns:
        Dict with selected option info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        from selenium.webdriver.support.ui import Select

        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)
        select = Select(element)

        if value is not None:
            select.select_by_value(value)
        elif text is not None:
            select.select_by_visible_text(text)
        elif index is not None:
            select.select_by_index(index)
        else:
            return {"success": False, "error": "Must provide value, text, or index"}

        selected = select.first_selected_option
        return {
            "success": True,
            "selected_text": selected.text,
            "selected_value": selected.get_attribute("value"),
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def toggle_checkbox(
    selector: str, by: str = "css", set_to: Optional[bool] = None
) -> dict:
    """
    Toggle a checkbox or set it to a specific state.

    Args:
        selector: Checkbox element selector.
        by: Selector strategy. Default "css".
        set_to: Optional specific state (True=checked, False=unchecked). If None, toggles.

    Returns:
        Dict with new checkbox state.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        is_checked = element.is_selected()

        if set_to is None:
            # Toggle
            element.click()
        elif set_to and not is_checked:
            element.click()
        elif not set_to and is_checked:
            element.click()

        new_state = element.is_selected()

        return {
            "success": True,
            "was_checked": is_checked,
            "is_checked": new_state,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Advanced Interaction Tools
# ============================================================================


def double_click(selector: str, by: str = "css") -> dict:
    """
    Double-click on an element.

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        from selenium.webdriver.common.action_chains import ActionChains

        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        action = ActionChains(_browser)
        action.double_click(element).perform()

        return {
            "success": True,
            "message": f"Double-clicked element: {selector}",
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def right_click(selector: str, by: str = "css") -> dict:
    """
    Right-click (context click) on an element.

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        from selenium.webdriver.common.action_chains import ActionChains

        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        action = ActionChains(_browser)
        action.context_click(element).perform()

        return {
            "success": True,
            "message": f"Right-clicked element: {selector}",
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def drag_and_drop(source_selector: str, target_selector: str, by: str = "css") -> dict:
    """
    Drag an element and drop it on another element.

    Args:
        source_selector: Element to drag.
        target_selector: Element to drop onto.
        by: Selector strategy for both elements. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        from selenium.webdriver.common.action_chains import ActionChains

        by_strategy = get_by_strategy(by)
        source = _browser.find_element(by_strategy, source_selector)
        target = _browser.find_element(by_strategy, target_selector)

        action = ActionChains(_browser)
        action.drag_and_drop(source, target).perform()

        return {
            "success": True,
            "message": f"Dragged {source_selector} to {target_selector}",
        }
    except NoSuchElementException as e:
        return {"success": False, "error": f"Element not found: {str(e)}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def drag_by_offset(
    selector: str, x_offset: int, y_offset: int, by: str = "css"
) -> dict:
    """
    Drag an element by a pixel offset.

    Args:
        selector: Element to drag.
        x_offset: Horizontal pixels to drag (positive = right).
        y_offset: Vertical pixels to drag (positive = down).
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        from selenium.webdriver.common.action_chains import ActionChains

        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        action = ActionChains(_browser)
        action.drag_and_drop_by_offset(element, x_offset, y_offset).perform()

        return {
            "success": True,
            "message": f"Dragged element by ({x_offset}, {y_offset})",
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Page Analysis Tools
# ============================================================================


def get_all_images() -> dict:
    """
    Get all images on the current page.

    Returns:
        Dict with list of images (src, alt, dimensions).
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        images = _browser.find_elements(By.TAG_NAME, "img")

        image_list = []
        for img in images[:50]:  # Limit to 50
            try:
                image_list.append(
                    {
                        "src": img.get_attribute("src"),
                        "alt": img.get_attribute("alt"),
                        "width": img.size.get("width"),
                        "height": img.size.get("height"),
                        "is_displayed": img.is_displayed(),
                    }
                )
            except StaleElementReferenceException:
                continue

        return {
            "success": True,
            "count": len(image_list),
            "images": image_list,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_page_headings() -> dict:
    """
    Get all headings (h1-h6) on the current page in hierarchical order.

    Returns:
        Dict with heading structure.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        headings = []
        for level in range(1, 7):
            elements = _browser.find_elements(By.TAG_NAME, f"h{level}")
            for el in elements:
                if el.text.strip():
                    headings.append(
                        {
                            "level": level,
                            "tag": f"h{level}",
                            "text": el.text.strip(),
                        }
                    )

        return {
            "success": True,
            "count": len(headings),
            "headings": headings,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_meta_info() -> dict:
    """
    Get page meta information (title, description, keywords, OpenGraph, etc.).

    Returns:
        Dict with meta information.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        meta_info = {
            "title": _browser.title,
            "url": _browser.current_url,
        }

        # Get common meta tags
        meta_tags = _browser.find_elements(By.TAG_NAME, "meta")
        for tag in meta_tags:
            name = tag.get_attribute("name") or tag.get_attribute("property")
            content = tag.get_attribute("content")
            if name and content:
                meta_info[name] = content

        # Get canonical URL
        try:
            canonical = _browser.find_element(By.CSS_SELECTOR, 'link[rel="canonical"]')
            meta_info["canonical"] = canonical.get_attribute("href")
        except NoSuchElementException:
            pass

        return {
            "success": True,
            "meta": meta_info,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def extract_table(selector: str, by: str = "css") -> dict:
    """
    Extract table data as structured JSON.

    Args:
        selector: Table element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with table data as array of row objects.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        table = _browser.find_element(by_strategy, selector)

        # Get headers
        headers = []
        header_row = table.find_elements(By.TAG_NAME, "th")
        for th in header_row:
            headers.append(th.text.strip())

        # If no th elements, try first row
        if not headers:
            first_row = table.find_element(By.TAG_NAME, "tr")
            cells = first_row.find_elements(By.TAG_NAME, "td")
            headers = [f"column_{i}" for i in range(len(cells))]

        # Get rows
        rows = table.find_elements(By.TAG_NAME, "tr")
        data = []

        for row in rows:
            cells = row.find_elements(By.TAG_NAME, "td")
            if cells:
                row_data = {}
                for i, cell in enumerate(cells):
                    key = headers[i] if i < len(headers) else f"column_{i}"
                    row_data[key] = cell.text.strip()
                data.append(row_data)

        return {
            "success": True,
            "headers": headers,
            "row_count": len(data),
            "data": data,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Table not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_computed_style(
    selector: str, properties: Optional[list] = None, by: str = "css"
) -> dict:
    """
    Get computed CSS styles of an element.

    Args:
        selector: Element selector.
        properties: List of CSS properties to get (e.g., ["color", "font-size"]).
                   If None, returns common properties.
        by: Selector strategy. Default "css".

    Returns:
        Dict with computed style values.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        if properties is None:
            properties = [
                "color",
                "background-color",
                "font-size",
                "font-family",
                "font-weight",
                "width",
                "height",
                "margin",
                "padding",
                "border",
                "display",
                "position",
                "visibility",
                "opacity",
            ]

        styles = {}
        for prop in properties:
            value = element.value_of_css_property(prop)
            styles[prop] = value

        return {
            "success": True,
            "element": selector,
            "styles": styles,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def highlight_element(
    selector: str, by: str = "css", color: str = "red", duration: float = 2.0
) -> dict:
    """
    Temporarily highlight an element with a colored border (useful for visual debugging).

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".
        color: Border color. Default "red".
        duration: How long to highlight in seconds. Default 2.0.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        import time

        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        original_style = element.get_attribute("style") or ""

        _browser.execute_script(
            f"arguments[0].style.border = '3px solid {color}'; arguments[0].style.boxShadow = '0 0 10px {color}';",
            element,
        )

        time.sleep(duration)

        _browser.execute_script(f"arguments[0].style = '{original_style}';", element)

        return {
            "success": True,
            "message": f"Highlighted element for {duration}s",
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Form Tools
# ============================================================================


def fill_form(
    form_data: dict, form_selector: Optional[str] = None, by: str = "css"
) -> dict:
    """
    Fill an entire form with provided data.

    Args:
        form_data: Dictionary mapping field names/IDs to values.
                   Example: {"username": "john", "email": "john@example.com"}
        form_selector: Optional form element selector to scope the search.
        by: Selector strategy. Default "css".

    Returns:
        Dict with filled fields info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        filled = []
        errors = []

        # Find the form context
        form_context = _browser
        if form_selector:
            by_strategy = get_by_strategy(by)
            form_context = _browser.find_element(by_strategy, form_selector)

        for field_name, value in form_data.items():
            try:
                # Try to find by name first, then by ID, then by placeholder
                element = None
                for attr in ["name", "id"]:
                    try:
                        element = form_context.find_element(
                            By.CSS_SELECTOR, f'[{attr}="{field_name}"]'
                        )
                        break
                    except NoSuchElementException:
                        continue

                if element is None:
                    # Try placeholder
                    try:
                        element = form_context.find_element(
                            By.CSS_SELECTOR, f'[placeholder="{field_name}"]'
                        )
                    except NoSuchElementException:
                        errors.append(f"Field not found: {field_name}")
                        continue

                # Handle different input types
                input_type = element.get_attribute("type") or element.tag_name

                if input_type in ["checkbox", "radio"]:
                    if value and not element.is_selected():
                        element.click()
                    elif not value and element.is_selected():
                        element.click()
                elif element.tag_name == "select":
                    from selenium.webdriver.support.ui import Select

                    select = Select(element)
                    try:
                        select.select_by_value(str(value))
                    except Exception:
                        select.select_by_visible_text(str(value))
                else:
                    element.clear()
                    element.send_keys(str(value))

                filled.append(field_name)

            except Exception as e:
                errors.append(f"{field_name}: {str(e)}")

        return {
            "success": len(errors) == 0,
            "filled_fields": filled,
            "errors": errors if errors else None,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def clear_form(form_selector: str, by: str = "css") -> dict:
    """
    Clear all input fields in a form.

    Args:
        form_selector: Form element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with cleared fields count.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        form = _browser.find_element(by_strategy, form_selector)

        inputs = form.find_elements(By.TAG_NAME, "input")
        inputs += form.find_elements(By.TAG_NAME, "textarea")

        cleared = 0
        for inp in inputs:
            input_type = inp.get_attribute("type")
            if input_type not in ["submit", "button", "hidden", "checkbox", "radio"]:
                inp.clear()
                cleared += 1

        return {
            "success": True,
            "cleared_fields": cleared,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Form not found: {form_selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Multi-Tab Convenience Tools
# ============================================================================


def open_links_in_tabs(selector: str, by: str = "css", limit: int = 5) -> dict:
    """
    Open multiple links in new tabs.

    Args:
        selector: Selector for link elements.
        by: Selector strategy. Default "css".
        limit: Maximum number of links to open. Default 5.

    Returns:
        Dict with opened tabs info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        links = _browser.find_elements(by_strategy, selector)[:limit]

        original_handle = _browser.current_window_handle
        opened_tabs = []

        for link in links:
            href = link.get_attribute("href")
            if href:
                _browser.execute_script("window.open(arguments[0], '_blank');", href)
                opened_tabs.append(
                    {
                        "url": href,
                        "text": link.text[:50] if link.text else "[No text]",
                    }
                )

        # Switch back to original tab
        _browser.switch_to.window(original_handle)

        return {
            "success": True,
            "opened_count": len(opened_tabs),
            "tabs": opened_tabs,
            "total_tabs": len(_browser.window_handles),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def close_all_tabs_except_current() -> dict:
    """
    Close all browser tabs except the currently active one.

    Returns:
        Dict with number of closed tabs.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        current_handle = _browser.current_window_handle
        handles = _browser.window_handles
        closed = 0

        for handle in handles:
            if handle != current_handle:
                _browser.switch_to.window(handle)
                _browser.close()
                closed += 1

        _browser.switch_to.window(current_handle)

        return {
            "success": True,
            "closed_tabs": closed,
            "remaining_tabs": 1,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_all_tabs_info() -> dict:
    """
    Get information about all open tabs.

    Returns:
        Dict with list of tab info (handle, title, URL).
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        current_handle = _browser.current_window_handle
        handles = _browser.window_handles
        tabs = []

        for handle in handles:
            _browser.switch_to.window(handle)
            tabs.append(
                {
                    "handle": handle,
                    "title": _browser.title,
                    "url": _browser.current_url,
                    "is_current": handle == current_handle,
                }
            )

        # Switch back to original tab
        _browser.switch_to.window(current_handle)

        return {
            "success": True,
            "count": len(tabs),
            "tabs": tabs,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Utility Tools
# ============================================================================


def take_full_page_screenshot(save_path: Optional[str] = None) -> dict:
    """
    Take a full-page screenshot by scrolling and stitching (for pages longer than viewport).

    Args:
        save_path: Optional file path to save screenshot.

    Returns:
        Dict with base64 screenshot or save path.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        # Get full page height
        total_height = _browser.execute_script("return document.body.scrollHeight")
        viewport_height = _browser.execute_script("return window.innerHeight")

        if total_height <= viewport_height * 1.5:
            # Page is small enough for single screenshot
            if save_path:
                _browser.save_screenshot(save_path)
                return {"success": True, "path": save_path}
            else:
                return {
                    "success": True,
                    "format": "png",
                    "encoding": "base64",
                    "data": _browser.get_screenshot_as_base64(),
                }

        # For longer pages, use Firefox's full page screenshot
        # This works in Firefox (which we're using)
        if save_path:
            _browser.save_full_page_screenshot(save_path)
            return {
                "success": True,
                "message": f"Full page screenshot saved to {save_path}",
                "path": save_path,
            }
        else:
            # Save to temp file and read as base64
            import tempfile

            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                temp_path = f.name

            _browser.save_full_page_screenshot(temp_path)

            with open(temp_path, "rb") as f:
                screenshot_data = base64.b64encode(f.read()).decode("utf-8")

            import os

            os.unlink(temp_path)

            return {
                "success": True,
                "format": "png",
                "encoding": "base64",
                "data": screenshot_data,
            }
    except AttributeError:
        # Fallback for browsers that don't support full page screenshot
        if save_path:
            _browser.save_screenshot(save_path)
            return {
                "success": True,
                "path": save_path,
                "note": "Standard screenshot (full page not supported)",
            }
        else:
            return {
                "success": True,
                "format": "png",
                "encoding": "base64",
                "data": _browser.get_screenshot_as_base64(),
                "note": "Standard screenshot (full page not supported)",
            }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_page_performance() -> dict:
    """
    Get page performance metrics (load times, resource counts).

    Returns:
        Dict with performance timing data.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        # Get navigation timing
        timing = _browser.execute_script("""
            var timing = window.performance.timing;
            return {
                dns_lookup: timing.domainLookupEnd - timing.domainLookupStart,
                tcp_connection: timing.connectEnd - timing.connectStart,
                server_response: timing.responseStart - timing.requestStart,
                page_download: timing.responseEnd - timing.responseStart,
                dom_interactive: timing.domInteractive - timing.navigationStart,
                dom_complete: timing.domComplete - timing.navigationStart,
                page_load: timing.loadEventEnd - timing.navigationStart,
            };
        """)

        # Get resource counts
        resources = _browser.execute_script("""
            var resources = window.performance.getEntriesByType('resource');
            var counts = {scripts: 0, stylesheets: 0, images: 0, fonts: 0, other: 0};
            resources.forEach(function(r) {
                if (r.initiatorType === 'script') counts.scripts++;
                else if (r.initiatorType === 'link' || r.initiatorType === 'css') counts.stylesheets++;
                else if (r.initiatorType === 'img') counts.images++;
                else if (r.initiatorType === 'css' && r.name.includes('font')) counts.fonts++;
                else counts.other++;
            });
            return {counts: counts, total: resources.length};
        """)

        return {
            "success": True,
            "timing_ms": timing,
            "resources": resources,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def set_window_size(width: int, height: int) -> dict:
    """
    Set the browser window size.

    Args:
        width: Window width in pixels.
        height: Window height in pixels.

    Returns:
        Dict with new window size.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.set_window_size(width, height)
        new_size = _browser.get_window_size()

        return {
            "success": True,
            "width": new_size["width"],
            "height": new_size["height"],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def maximize_window() -> dict:
    """
    Maximize the browser window.

    Returns:
        Dict with new window size.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.maximize_window()
        new_size = _browser.get_window_size()

        return {
            "success": True,
            "width": new_size["width"],
            "height": new_size["height"],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def download_image(selector: str, save_path: str, by: str = "css") -> dict:
    """
    Download an image from the page.

    Args:
        selector: Image element selector.
        save_path: Path to save the image.
        by: Selector strategy. Default "css".

    Returns:
        Dict with save path and image info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        img = _browser.find_element(by_strategy, selector)

        src = img.get_attribute("src")

        if not src:
            return {"success": False, "error": "Image has no src attribute"}

        # Use JavaScript to fetch the image
        import urllib.request

        urllib.request.urlretrieve(src, save_path)

        return {
            "success": True,
            "path": save_path,
            "source_url": src,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Image not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# PDF and Print Tools
# ============================================================================


def print_to_pdf(
    save_path: str, page_size: str = "A4", landscape: bool = False
) -> dict:
    """
    Print the current page to a PDF file.

    Args:
        save_path: Path to save the PDF file.
        page_size: Page size - "A4", "Letter", "Legal". Default "A4".
        landscape: Whether to use landscape orientation. Default False.

    Returns:
        Dict with save path and success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        # Firefox supports printing to PDF via print options
        import base64

        # Use JavaScript to trigger print
        pdf_data = _browser.execute_script("""
            return window.print();
        """)

        # Alternative: Use Firefox's PDF print capability
        # This requires setting up print preferences
        print_options = {
            "orientation": "landscape" if landscape else "portrait",
            "scale": 1.0,
            "shrinkToFit": True,
            "pageRanges": ["1-"],
            "pageSize": page_size,
        }

        # Firefox specific: save_full_page_screenshot as workaround
        # or use pyPDF for true PDF generation
        from selenium.webdriver.common.print_page_options import PrintOptions

        print_opt = PrintOptions()
        print_opt.orientation = "landscape" if landscape else "portrait"

        pdf_base64 = _browser.print_page(print_opt)

        # Decode and save
        pdf_bytes = base64.b64decode(pdf_base64)
        with open(save_path, "wb") as f:
            f.write(pdf_bytes)

        return {
            "success": True,
            "path": save_path,
            "size_bytes": len(pdf_bytes),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def save_page_as_html(save_path: str, include_resources: bool = False) -> dict:
    """
    Save the current page as an HTML file.

    Args:
        save_path: Path to save the HTML file.
        include_resources: Whether to include inline resources (not implemented). Default False.

    Returns:
        Dict with save path and success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        page_source = _browser.page_source

        with open(save_path, "w", encoding="utf-8") as f:
            f.write(page_source)

        return {
            "success": True,
            "path": save_path,
            "size_bytes": len(page_source.encode("utf-8")),
            "title": _browser.title,
            "url": _browser.current_url,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Storage Tools (localStorage and sessionStorage)
# ============================================================================


def get_local_storage() -> dict:
    """
    Get all items from localStorage.

    Returns:
        Dict with all localStorage key-value pairs.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        storage = _browser.execute_script("""
            var items = {};
            for (var i = 0; i < localStorage.length; i++) {
                var key = localStorage.key(i);
                items[key] = localStorage.getItem(key);
            }
            return items;
        """)

        return {
            "success": True,
            "count": len(storage) if storage else 0,
            "items": storage or {},
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def set_local_storage(key: str, value: str) -> dict:
    """
    Set an item in localStorage.

    Args:
        key: Storage key.
        value: Value to store.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script(
            "localStorage.setItem(arguments[0], arguments[1]);", key, value
        )

        return {
            "success": True,
            "message": f"Set localStorage['{key}']",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def remove_local_storage(key: str) -> dict:
    """
    Remove an item from localStorage.

    Args:
        key: Storage key to remove.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script("localStorage.removeItem(arguments[0]);", key)

        return {
            "success": True,
            "message": f"Removed localStorage['{key}']",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def clear_local_storage() -> dict:
    """
    Clear all items from localStorage.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script("localStorage.clear();")

        return {
            "success": True,
            "message": "Cleared localStorage",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_session_storage() -> dict:
    """
    Get all items from sessionStorage.

    Returns:
        Dict with all sessionStorage key-value pairs.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        storage = _browser.execute_script("""
            var items = {};
            for (var i = 0; i < sessionStorage.length; i++) {
                var key = sessionStorage.key(i);
                items[key] = sessionStorage.getItem(key);
            }
            return items;
        """)

        return {
            "success": True,
            "count": len(storage) if storage else 0,
            "items": storage or {},
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def set_session_storage(key: str, value: str) -> dict:
    """
    Set an item in sessionStorage.

    Args:
        key: Storage key.
        value: Value to store.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script(
            "sessionStorage.setItem(arguments[0], arguments[1]);", key, value
        )

        return {
            "success": True,
            "message": f"Set sessionStorage['{key}']",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def clear_session_storage() -> dict:
    """
    Clear all items from sessionStorage.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script("sessionStorage.clear();")

        return {
            "success": True,
            "message": "Cleared sessionStorage",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Console and Logging Tools
# ============================================================================


def get_console_logs(log_type: str = "all") -> dict:
    """
    Get browser console logs.

    Args:
        log_type: Type of logs - "all", "error", "warning", "info". Default "all".

    Returns:
        Dict with console log entries.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        # This works for browsers that support log retrieval
        # Firefox may need geckodriver configuration for this
        logs = _browser.execute_script("""
            if (window.__console_logs === undefined) {
                window.__console_logs = [];
                var oldLog = console.log;
                var oldError = console.error;
                var oldWarn = console.warn;
                var oldInfo = console.info;

                console.log = function() {
                    window.__console_logs.push({type: 'log', args: Array.from(arguments).map(String), timestamp: Date.now()});
                    oldLog.apply(console, arguments);
                };
                console.error = function() {
                    window.__console_logs.push({type: 'error', args: Array.from(arguments).map(String), timestamp: Date.now()});
                    oldError.apply(console, arguments);
                };
                console.warn = function() {
                    window.__console_logs.push({type: 'warning', args: Array.from(arguments).map(String), timestamp: Date.now()});
                    oldWarn.apply(console, arguments);
                };
                console.info = function() {
                    window.__console_logs.push({type: 'info', args: Array.from(arguments).map(String), timestamp: Date.now()});
                    oldInfo.apply(console, arguments);
                };
            }
            return window.__console_logs;
        """)

        if log_type != "all" and logs:
            logs = [l for l in logs if l.get("type") == log_type]

        return {
            "success": True,
            "count": len(logs) if logs else 0,
            "logs": logs or [],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def inject_console_logger() -> dict:
    """
    Inject a console logger to capture all console output.
    Call this after page load to start capturing logs.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script("""
            window.__console_logs = [];
            var oldLog = console.log;
            var oldError = console.error;
            var oldWarn = console.warn;
            var oldInfo = console.info;

            console.log = function() {
                window.__console_logs.push({type: 'log', message: Array.from(arguments).map(String).join(' '), timestamp: Date.now()});
                oldLog.apply(console, arguments);
            };
            console.error = function() {
                window.__console_logs.push({type: 'error', message: Array.from(arguments).map(String).join(' '), timestamp: Date.now()});
                oldError.apply(console, arguments);
            };
            console.warn = function() {
                window.__console_logs.push({type: 'warning', message: Array.from(arguments).map(String).join(' '), timestamp: Date.now()});
                oldWarn.apply(console, arguments);
            };
            console.info = function() {
                window.__console_logs.push({type: 'info', message: Array.from(arguments).map(String).join(' '), timestamp: Date.now()});
                oldInfo.apply(console, arguments);
            };
        """)

        return {
            "success": True,
            "message": "Console logger injected. Future console output will be captured.",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_javascript_errors() -> dict:
    """
    Get JavaScript errors that occurred on the page.

    Returns:
        Dict with list of JavaScript errors.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        # Inject error catcher if not already done
        _browser.execute_script("""
            if (window.__js_errors === undefined) {
                window.__js_errors = [];
                window.onerror = function(msg, url, line, col, error) {
                    window.__js_errors.push({
                        message: msg,
                        source: url,
                        line: line,
                        column: col,
                        stack: error ? error.stack : null,
                        timestamp: Date.now()
                    });
                };
                window.addEventListener('unhandledrejection', function(event) {
                    window.__js_errors.push({
                        message: 'Unhandled Promise rejection: ' + event.reason,
                        type: 'unhandledrejection',
                        timestamp: Date.now()
                    });
                });
            }
        """)

        errors = _browser.execute_script("return window.__js_errors || [];")

        return {
            "success": True,
            "count": len(errors) if errors else 0,
            "errors": errors or [],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# File Upload Tools
# ============================================================================


def upload_file(selector: str, file_path: str, by: str = "css") -> dict:
    """
    Upload a file to a file input element.

    Args:
        selector: File input element selector.
        file_path: Absolute path to the file to upload.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        import os

        if not os.path.exists(file_path):
            return {"success": False, "error": f"File not found: {file_path}"}

        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        # Send the file path to the input
        element.send_keys(file_path)

        return {
            "success": True,
            "message": f"Uploaded file: {file_path}",
            "file_path": file_path,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def upload_multiple_files(selector: str, file_paths: list, by: str = "css") -> dict:
    """
    Upload multiple files to a file input element.

    Args:
        selector: File input element selector (must support multiple files).
        file_paths: List of absolute file paths to upload.
        by: Selector strategy. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        import os

        for fp in file_paths:
            if not os.path.exists(fp):
                return {"success": False, "error": f"File not found: {fp}"}

        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        # Join paths with newline for multiple file upload
        element.send_keys("\n".join(file_paths))

        return {
            "success": True,
            "message": f"Uploaded {len(file_paths)} files",
            "files": file_paths,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Accessibility Tools
# ============================================================================


def check_accessibility() -> dict:
    """
    Run basic accessibility checks on the current page.

    Returns:
        Dict with accessibility issues found.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        issues = []

        # Check for missing alt attributes on images
        images_without_alt = _browser.execute_script("""
            return Array.from(document.querySelectorAll('img')).filter(img => !img.alt || img.alt.trim() === '').map(img => ({
                src: img.src.substring(0, 100),
                issue: 'Missing alt attribute'
            }));
        """)
        for img in images_without_alt or []:
            issues.append({"type": "image", "severity": "error", **img})

        # Check for missing form labels
        inputs_without_labels = _browser.execute_script("""
            return Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select')).filter(el => {
                var id = el.id;
                if (id && document.querySelector('label[for="' + id + '"]')) return false;
                if (el.closest('label')) return false;
                if (el.getAttribute('aria-label')) return false;
                if (el.getAttribute('aria-labelledby')) return false;
                return true;
            }).map(el => ({
                tag: el.tagName,
                type: el.type || '',
                name: el.name || '',
                issue: 'Missing label'
            }));
        """)
        for inp in inputs_without_labels or []:
            issues.append({"type": "form", "severity": "error", **inp})

        # Check for missing page title
        title = _browser.title
        if not title or title.strip() == "":
            issues.append(
                {"type": "page", "severity": "error", "issue": "Missing page title"}
            )

        # Check for missing lang attribute
        has_lang = _browser.execute_script(
            "return document.documentElement.lang && document.documentElement.lang.trim() !== '';"
        )
        if not has_lang:
            issues.append(
                {
                    "type": "page",
                    "severity": "warning",
                    "issue": "Missing lang attribute on html element",
                }
            )

        # Check for empty links
        empty_links = _browser.execute_script("""
            return Array.from(document.querySelectorAll('a')).filter(a => {
                return a.textContent.trim() === '' && !a.querySelector('img[alt]') && !a.getAttribute('aria-label');
            }).map(a => ({
                href: a.href.substring(0, 50),
                issue: 'Empty link (no accessible name)'
            }));
        """)
        for link in (empty_links or [])[:10]:
            issues.append({"type": "link", "severity": "error", **link})

        # Check for missing heading structure
        h1_count = _browser.execute_script(
            "return document.querySelectorAll('h1').length;"
        )
        if h1_count == 0:
            issues.append(
                {
                    "type": "heading",
                    "severity": "warning",
                    "issue": "No h1 heading found",
                }
            )
        elif h1_count > 1:
            issues.append(
                {
                    "type": "heading",
                    "severity": "warning",
                    "issue": f"Multiple h1 headings ({h1_count})",
                }
            )

        return {
            "success": True,
            "issues_count": len(issues),
            "issues": issues,
            "summary": {
                "errors": len([i for i in issues if i.get("severity") == "error"]),
                "warnings": len([i for i in issues if i.get("severity") == "warning"]),
            },
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_aria_info(selector: str, by: str = "css") -> dict:
    """
    Get ARIA attributes and accessibility info for an element.

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with ARIA attributes and accessibility info.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        aria_info = _browser.execute_script(
            """
            var el = arguments[0];
            var info = {
                tagName: el.tagName,
                role: el.getAttribute('role') || el.tagName.toLowerCase(),
                ariaLabel: el.getAttribute('aria-label'),
                ariaLabelledby: el.getAttribute('aria-labelledby'),
                ariaDescribedby: el.getAttribute('aria-describedby'),
                ariaHidden: el.getAttribute('aria-hidden'),
                ariaExpanded: el.getAttribute('aria-expanded'),
                ariaPressed: el.getAttribute('aria-pressed'),
                ariaSelected: el.getAttribute('aria-selected'),
                ariaDisabled: el.getAttribute('aria-disabled'),
                tabindex: el.getAttribute('tabindex'),
                accessibleName: el.innerText || el.getAttribute('aria-label') || '',
            };

            // Get all aria-* attributes
            var ariaAttrs = {};
            for (var attr of el.attributes) {
                if (attr.name.startsWith('aria-')) {
                    ariaAttrs[attr.name] = attr.value;
                }
            }
            info.allAriaAttributes = ariaAttrs;

            return info;
        """,
            element,
        )

        return {
            "success": True,
            "accessibility": aria_info,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Shadow DOM Tools
# ============================================================================


def find_in_shadow_dom(
    host_selector: str, inner_selector: str, host_by: str = "css", inner_by: str = "css"
) -> dict:
    """
    Find an element inside a Shadow DOM.

    Args:
        host_selector: Selector for the shadow host element.
        inner_selector: Selector for the element inside the shadow DOM.
        host_by: Selector strategy for host. Default "css".
        inner_by: Selector strategy for inner element. Default "css".

    Returns:
        Dict with element info if found.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(host_by)
        host = _browser.find_element(by_strategy, host_selector)

        # Access shadow root and find element
        shadow_element = _browser.execute_script(
            """
            var host = arguments[0];
            var selector = arguments[1];
            if (!host.shadowRoot) return null;
            var el = host.shadowRoot.querySelector(selector);
            if (!el) return null;
            return {
                tagName: el.tagName,
                text: el.innerText,
                id: el.id,
                className: el.className
            };
        """,
            host,
            inner_selector,
        )

        if shadow_element:
            return {
                "success": True,
                "found": True,
                "element": shadow_element,
            }
        else:
            return {
                "success": True,
                "found": False,
                "message": "Element not found in shadow DOM",
            }
    except NoSuchElementException:
        return {"success": False, "error": f"Host element not found: {host_selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def click_in_shadow_dom(
    host_selector: str, inner_selector: str, host_by: str = "css"
) -> dict:
    """
    Click an element inside a Shadow DOM.

    Args:
        host_selector: Selector for the shadow host element.
        inner_selector: CSS selector for the element inside the shadow DOM.
        host_by: Selector strategy for host. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(host_by)
        host = _browser.find_element(by_strategy, host_selector)

        result = _browser.execute_script(
            """
            var host = arguments[0];
            var selector = arguments[1];
            if (!host.shadowRoot) return {success: false, error: 'No shadow root'};
            var el = host.shadowRoot.querySelector(selector);
            if (!el) return {success: false, error: 'Element not found in shadow DOM'};
            el.click();
            return {success: true};
        """,
            host,
            inner_selector,
        )

        return result

    except NoSuchElementException:
        return {"success": False, "error": f"Host element not found: {host_selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def type_in_shadow_dom(
    host_selector: str, inner_selector: str, text: str, host_by: str = "css"
) -> dict:
    """
    Type text into an element inside a Shadow DOM.

    Args:
        host_selector: Selector for the shadow host element.
        inner_selector: CSS selector for the input inside the shadow DOM.
        text: Text to type.
        host_by: Selector strategy for host. Default "css".

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(host_by)
        host = _browser.find_element(by_strategy, host_selector)

        result = _browser.execute_script(
            """
            var host = arguments[0];
            var selector = arguments[1];
            var text = arguments[2];
            if (!host.shadowRoot) return {success: false, error: 'No shadow root'};
            var el = host.shadowRoot.querySelector(selector);
            if (!el) return {success: false, error: 'Element not found in shadow DOM'};
            el.value = text;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            return {success: true};
        """,
            host,
            inner_selector,
            text,
        )

        return result

    except NoSuchElementException:
        return {"success": False, "error": f"Host element not found: {host_selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Media Control Tools
# ============================================================================


def control_media(selector: str, action: str, by: str = "css") -> dict:
    """
    Control a video or audio element.

    Args:
        selector: Media element selector.
        action: Action to perform - "play", "pause", "mute", "unmute", "fullscreen".
        by: Selector strategy. Default "css".

    Returns:
        Dict with media state after action.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        result = _browser.execute_script(
            """
            var media = arguments[0];
            var action = arguments[1];

            switch(action) {
                case 'play':
                    media.play();
                    break;
                case 'pause':
                    media.pause();
                    break;
                case 'mute':
                    media.muted = true;
                    break;
                case 'unmute':
                    media.muted = false;
                    break;
                case 'fullscreen':
                    media.requestFullscreen();
                    break;
                default:
                    return {success: false, error: 'Unknown action'};
            }

            return {
                success: true,
                paused: media.paused,
                muted: media.muted,
                currentTime: media.currentTime,
                duration: media.duration,
                volume: media.volume
            };
        """,
            element,
            action,
        )

        return result

    except NoSuchElementException:
        return {"success": False, "error": f"Media element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_media_state(selector: str, by: str = "css") -> dict:
    """
    Get the current state of a video or audio element.

    Args:
        selector: Media element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with media element state.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        state = _browser.execute_script(
            """
            var media = arguments[0];
            return {
                tagName: media.tagName,
                src: media.src,
                currentSrc: media.currentSrc,
                paused: media.paused,
                muted: media.muted,
                volume: media.volume,
                currentTime: media.currentTime,
                duration: media.duration,
                playbackRate: media.playbackRate,
                loop: media.loop,
                autoplay: media.autoplay,
                controls: media.controls,
                readyState: media.readyState,
                networkState: media.networkState,
                ended: media.ended,
                buffered: media.buffered.length > 0 ? {
                    start: media.buffered.start(0),
                    end: media.buffered.end(media.buffered.length - 1)
                } : null
            };
        """,
            element,
        )

        return {
            "success": True,
            "state": state,
        }

    except NoSuchElementException:
        return {"success": False, "error": f"Media element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def seek_media(selector: str, time_seconds: float, by: str = "css") -> dict:
    """
    Seek to a specific time in a video or audio element.

    Args:
        selector: Media element selector.
        time_seconds: Time to seek to in seconds.
        by: Selector strategy. Default "css".

    Returns:
        Dict with new media position.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        result = _browser.execute_script(
            """
            var media = arguments[0];
            var time = arguments[1];
            media.currentTime = time;
            return {
                success: true,
                currentTime: media.currentTime,
                duration: media.duration
            };
        """,
            element,
            time_seconds,
        )

        return result

    except NoSuchElementException:
        return {"success": False, "error": f"Media element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Geolocation Tools
# ============================================================================


def set_geolocation(latitude: float, longitude: float, accuracy: float = 100) -> dict:
    """
    Set a fake geolocation for the browser session.

    Args:
        latitude: Latitude coordinate.
        longitude: Longitude coordinate.
        accuracy: Accuracy in meters. Default 100.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script(
            """
            navigator.geolocation.getCurrentPosition = function(success, error, options) {
                success({
                    coords: {
                        latitude: arguments[0],
                        longitude: arguments[1],
                        accuracy: arguments[2],
                        altitude: null,
                        altitudeAccuracy: null,
                        heading: null,
                        speed: null
                    },
                    timestamp: Date.now()
                });
            };
            navigator.geolocation.watchPosition = navigator.geolocation.getCurrentPosition;
        """,
            latitude,
            longitude,
            accuracy,
        )

        return {
            "success": True,
            "message": f"Geolocation set to ({latitude}, {longitude})",
            "latitude": latitude,
            "longitude": longitude,
            "accuracy": accuracy,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Network and Request Tools
# ============================================================================


def inject_request_interceptor() -> dict:
    """
    Inject a request interceptor to log all network requests.
    Call this before navigating to start capturing requests.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script("""
            window.__network_log = [];

            // Override fetch
            var originalFetch = window.fetch;
            window.fetch = function() {
                var request = arguments[0];
                var url = typeof request === 'string' ? request : request.url;
                var method = arguments[1] && arguments[1].method ? arguments[1].method : 'GET';

                var entry = {
                    type: 'fetch',
                    url: url,
                    method: method,
                    timestamp: Date.now(),
                    status: null
                };

                return originalFetch.apply(this, arguments).then(function(response) {
                    entry.status = response.status;
                    window.__network_log.push(entry);
                    return response;
                }).catch(function(error) {
                    entry.error = error.message;
                    window.__network_log.push(entry);
                    throw error;
                });
            };

            // Override XMLHttpRequest
            var originalXHR = window.XMLHttpRequest;
            window.XMLHttpRequest = function() {
                var xhr = new originalXHR();
                var entry = {type: 'xhr', timestamp: Date.now()};

                var originalOpen = xhr.open;
                xhr.open = function(method, url) {
                    entry.method = method;
                    entry.url = url;
                    return originalOpen.apply(xhr, arguments);
                };

                xhr.addEventListener('load', function() {
                    entry.status = xhr.status;
                    window.__network_log.push(entry);
                });

                xhr.addEventListener('error', function() {
                    entry.error = 'Network error';
                    window.__network_log.push(entry);
                });

                return xhr;
            };
        """)

        return {
            "success": True,
            "message": "Request interceptor injected. Network requests will be logged.",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_network_log() -> dict:
    """
    Get the captured network requests (after calling inject_request_interceptor).

    Returns:
        Dict with list of captured network requests.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        logs = _browser.execute_script("return window.__network_log || [];")

        return {
            "success": True,
            "count": len(logs) if logs else 0,
            "requests": logs or [],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def clear_network_log() -> dict:
    """
    Clear the captured network log.

    Returns:
        Dict with success status.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        _browser.execute_script("window.__network_log = [];")

        return {
            "success": True,
            "message": "Network log cleared",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Canvas and Visual Tools
# ============================================================================


def get_canvas_data(selector: str, by: str = "css", format: str = "png") -> dict:
    """
    Extract image data from a canvas element.

    Args:
        selector: Canvas element selector.
        by: Selector strategy. Default "css".
        format: Image format - "png" or "jpeg". Default "png".

    Returns:
        Dict with base64 image data.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        mime_type = "image/png" if format == "png" else "image/jpeg"

        data = _browser.execute_script(
            """
            var canvas = arguments[0];
            var mimeType = arguments[1];
            return canvas.toDataURL(mimeType);
        """,
            element,
            mime_type,
        )

        # Remove data URL prefix
        if data and data.startswith("data:"):
            data = data.split(",", 1)[1]

        return {
            "success": True,
            "format": format,
            "encoding": "base64",
            "data": data,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Canvas not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_element_bounding_box(selector: str, by: str = "css") -> dict:
    """
    Get the bounding box (position and dimensions) of an element.

    Args:
        selector: Element selector.
        by: Selector strategy. Default "css".

    Returns:
        Dict with element position and dimensions.
    """
    global _browser

    if _browser is None:
        return {
            "success": False,
            "error": "No browser session. Call start_browser first.",
        }

    try:
        by_strategy = get_by_strategy(by)
        element = _browser.find_element(by_strategy, selector)

        box = _browser.execute_script(
            """
            var rect = arguments[0].getBoundingClientRect();
            return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                left: rect.left
            };
        """,
            element,
        )

        return {
            "success": True,
            "bounding_box": box,
        }
    except NoSuchElementException:
        return {"success": False, "error": f"Element not found: {selector}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================================
# Main Entry Point
# ============================================================================

if __name__ == "__main__":
    # Run with stdio transport (standard for CLI MCP servers)
    mcp.run(transport="stdio")
