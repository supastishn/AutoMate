#!/usr/bin/env python3
"""
AutoMate Browser Engine — Custom tailored implementation.
Persistent undetected Chrome browser process with full automation capabilities.
Uses: undetected-chromedriver + selenium-stealth + Xvfb
Communicates via stdin/stdout JSON lines.

Features beyond basic browsing:
  - Anti-bot detection (undetected-chromedriver + stealth + CDP injection)
  - Full page screenshots & element screenshots
  - Network request interception & logging
  - Shadow DOM traversal
  - Geolocation spoofing
  - Accessibility auditing
  - PDF generation
  - Cookie/localStorage/sessionStorage management
  - iFrame navigation
  - Media control (video/audio)
  - Performance metrics
  - Console log capture
  - CSS computed style inspection
  - Table extraction
  - Meta/OpenGraph extraction
  - Drag and drop, double/right click
  - File upload
  - Multi-tab management
"""

import sys
import json
import os
import time
import traceback
import base64
import urllib.parse
import random
import math
import hashlib
import tempfile

import undetected_chromedriver as uc
from selenium_stealth import stealth

# pyvirtualdisplay is optional — unavailable on Termux/Android
try:
    from pyvirtualdisplay import Display as _Display
except ImportError:
    _Display = None

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys
from selenium.common.exceptions import (
    TimeoutException,
    NoSuchElementException,
    WebDriverException,
    StaleElementReferenceException,
    NoAlertPresentException,
    UnexpectedAlertPresentException,
    JavascriptException,
)

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
browser = None
display = None
_network_log = []  # intercepted requests
_console_logger_injected = False
_stealth_profile = {}  # current fingerprint profile


# ---------------------------------------------------------------------------
# Stealth: Fingerprint profiles
# ---------------------------------------------------------------------------
WEBGL_PROFILES = [
    {"vendor": "Intel Inc.", "renderer": "Intel Iris OpenGL Engine"},
    {"vendor": "Intel Inc.", "renderer": "Intel(R) UHD Graphics 630"},
    {"vendor": "Intel Inc.", "renderer": "Intel(R) HD Graphics 620"},
    {"vendor": "Intel Inc.", "renderer": "Intel Iris Plus Graphics 640"},
    {
        "vendor": "Google Inc. (NVIDIA)",
        "renderer": "ANGLE (NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)",
    },
    {
        "vendor": "Google Inc. (NVIDIA)",
        "renderer": "ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)",
    },
    {
        "vendor": "Google Inc. (AMD)",
        "renderer": "ANGLE (AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)",
    },
    {
        "vendor": "Google Inc. (Intel)",
        "renderer": "ANGLE (Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0)",
    },
    {"vendor": "Apple", "renderer": "Apple M1"},
    {"vendor": "Apple", "renderer": "Apple M2 Pro"},
]

SCREEN_PROFILES = [
    {
        "width": 1920,
        "height": 1080,
        "avail_width": 1920,
        "avail_height": 1040,
        "dpr": 1,
        "color_depth": 24,
    },
    {
        "width": 2560,
        "height": 1440,
        "avail_width": 2560,
        "avail_height": 1400,
        "dpr": 1,
        "color_depth": 24,
    },
    {
        "width": 1536,
        "height": 864,
        "avail_width": 1536,
        "avail_height": 824,
        "dpr": 1.25,
        "color_depth": 24,
    },
    {
        "width": 1440,
        "height": 900,
        "avail_width": 1440,
        "avail_height": 860,
        "dpr": 2,
        "color_depth": 30,
    },
    {
        "width": 1680,
        "height": 1050,
        "avail_width": 1680,
        "avail_height": 1010,
        "dpr": 1,
        "color_depth": 24,
    },
    {
        "width": 1366,
        "height": 768,
        "avail_width": 1366,
        "avail_height": 728,
        "dpr": 1,
        "color_depth": 24,
    },
    {
        "width": 1920,
        "height": 1200,
        "avail_width": 1920,
        "avail_height": 1160,
        "dpr": 1,
        "color_depth": 24,
    },
    {
        "width": 3840,
        "height": 2160,
        "avail_width": 3840,
        "avail_height": 2120,
        "dpr": 1.5,
        "color_depth": 30,
    },
]

PLATFORM_PROFILES = [
    {
        "platform": "Win32",
        "os": "windows",
        "ua_platform": "Windows NT 10.0; Win64; x64",
        "hw_concurrency": 8,
        "device_memory": 8,
    },
    {
        "platform": "Win32",
        "os": "windows",
        "ua_platform": "Windows NT 10.0; Win64; x64",
        "hw_concurrency": 12,
        "device_memory": 16,
    },
    {
        "platform": "Win32",
        "os": "windows",
        "ua_platform": "Windows NT 10.0; Win64; x64",
        "hw_concurrency": 16,
        "device_memory": 32,
    },
    {
        "platform": "MacIntel",
        "os": "macos",
        "ua_platform": "Macintosh; Intel Mac OS X 10_15_7",
        "hw_concurrency": 8,
        "device_memory": 16,
    },
    {
        "platform": "MacIntel",
        "os": "macos",
        "ua_platform": "Macintosh; Intel Mac OS X 14_0",
        "hw_concurrency": 10,
        "device_memory": 16,
    },
    {
        "platform": "Linux x86_64",
        "os": "linux",
        "ua_platform": "X11; Linux x86_64",
        "hw_concurrency": 4,
        "device_memory": 8,
    },
    {
        "platform": "Linux x86_64",
        "os": "linux",
        "ua_platform": "X11; Linux x86_64",
        "hw_concurrency": 8,
        "device_memory": 16,
    },
]

TIMEZONE_MAP = {
    "US": [
        {"tz": "America/New_York", "offset": -300, "locale": "en-US"},
        {"tz": "America/Chicago", "offset": -360, "locale": "en-US"},
        {"tz": "America/Los_Angeles", "offset": -480, "locale": "en-US"},
    ],
    "EU": [
        {"tz": "Europe/London", "offset": 0, "locale": "en-GB"},
        {"tz": "Europe/Berlin", "offset": 60, "locale": "de-DE"},
        {"tz": "Europe/Paris", "offset": 60, "locale": "fr-FR"},
    ],
    "default": [
        {"tz": "America/New_York", "offset": -300, "locale": "en-US"},
    ],
}

# Common font sets per OS
FONT_SETS = {
    "windows": [
        "Arial",
        "Calibri",
        "Cambria",
        "Comic Sans MS",
        "Consolas",
        "Courier New",
        "Georgia",
        "Impact",
        "Lucida Console",
        "Microsoft Sans Serif",
        "Palatino Linotype",
        "Segoe UI",
        "Tahoma",
        "Times New Roman",
        "Trebuchet MS",
        "Verdana",
    ],
    "macos": [
        "Arial",
        "Avenir",
        "Courier New",
        "Georgia",
        "Helvetica",
        "Helvetica Neue",
        "Lucida Grande",
        "Menlo",
        "Monaco",
        "Palatino",
        "SF Pro Display",
        "SF Pro Text",
        "Times New Roman",
        "Trebuchet MS",
        "Verdana",
    ],
    "linux": [
        "Arial",
        "Courier New",
        "DejaVu Sans",
        "DejaVu Serif",
        "FreeMono",
        "FreeSans",
        "Georgia",
        "Liberation Mono",
        "Liberation Sans",
        "Liberation Serif",
        "Noto Sans",
        "Times New Roman",
        "Ubuntu",
        "Verdana",
    ],
}


def _generate_fingerprint_profile(region="US"):
    """Generate a consistent random fingerprint profile for this session."""
    webgl = random.choice(WEBGL_PROFILES)
    screen = random.choice(SCREEN_PROFILES)
    platform = random.choice(PLATFORM_PROFILES)
    tz_list = TIMEZONE_MAP.get(region, TIMEZONE_MAP["default"])
    tz = random.choice(tz_list)
    fonts = FONT_SETS.get(platform["os"], FONT_SETS["windows"])

    # Generate a stable canvas noise seed for this session
    canvas_seed = random.randint(1, 2**31)
    audio_seed = random.random() * 0.0001  # tiny noise for AudioContext

    return {
        "webgl": webgl,
        "screen": screen,
        "platform": platform,
        "timezone": tz,
        "fonts": fonts,
        "canvas_seed": canvas_seed,
        "audio_seed": audio_seed,
        "hw_concurrency": platform["hw_concurrency"],
        "device_memory": platform["device_memory"],
    }


def _build_stealth_js(profile):
    """Build the comprehensive anti-detection JavaScript injection."""
    webgl = profile["webgl"]
    screen = profile["screen"]
    platform = profile["platform"]
    tz = profile["timezone"]
    canvas_seed = profile["canvas_seed"]
    audio_seed = profile["audio_seed"]
    hw = profile["hw_concurrency"]
    mem = profile["device_memory"]
    fonts_json = json.dumps(profile["fonts"])

    return f"""
    // ===== 1. navigator.webdriver removal =====
    Object.defineProperty(navigator, 'webdriver', {{get: () => undefined}});
    delete navigator.__proto__.webdriver;

    // ===== 2. CDP leak patching =====
    // Remove Runtime.evaluate artifacts
    (function() {{
        const origError = Error;
        const origStackDesc = Object.getOwnPropertyDescriptor(origError.prototype, 'stack');
        if (origStackDesc && origStackDesc.get) {{
            const origGetter = origStackDesc.get;
            Object.defineProperty(origError.prototype, 'stack', {{
                get: function() {{
                    let stack = origGetter.call(this);
                    if (stack) {{
                        stack = stack.replace(/\\n\\s+at\\s+Object\\.cdp_.*/g, '');
                        stack = stack.replace(/\\n\\s+at\\s+Runtime\\.evaluate.*/g, '');
                        stack = stack.replace(/\\n\\s+at\\s+Object\\.inject.*/g, '');
                    }}
                    return stack;
                }}
            }});
        }}
        // Remove __cdp_binding if present
        try {{ delete window.__cdp_binding; }} catch(e) {{}}
        try {{ delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array; }} catch(e) {{}}
        try {{ delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise; }} catch(e) {{}}
        try {{ delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol; }} catch(e) {{}}
        // Remove $cdc_ prefixed properties from document
        for (let prop of Object.getOwnPropertyNames(document)) {{
            if (prop.match(/\\$cdc_|\\$chrome_/)) {{
                try {{ delete document[prop]; }} catch(e) {{}}
            }}
        }}
    }})();

    // ===== 3. Realistic navigator.plugins & mimeTypes =====
    (function() {{
        const pluginData = [
            {{name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: [{{type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format'}}]}},
            {{name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', mimeTypes: [{{type: 'application/pdf', suffixes: 'pdf', description: ''}}]}},
            {{name: 'Native Client', filename: 'internal-nacl-plugin', description: '', mimeTypes: [{{type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable'}}, {{type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable'}}]}},
        ];
        const createMimeType = (mt, plugin) => {{
            const m = Object.create(MimeType.prototype);
            Object.defineProperties(m, {{
                type: {{value: mt.type, enumerable: true}},
                suffixes: {{value: mt.suffixes, enumerable: true}},
                description: {{value: mt.description, enumerable: true}},
                enabledPlugin: {{value: plugin, enumerable: true}},
            }});
            return m;
        }};
        const createPlugin = (pd) => {{
            const p = Object.create(Plugin.prototype);
            Object.defineProperties(p, {{
                name: {{value: pd.name, enumerable: true}},
                filename: {{value: pd.filename, enumerable: true}},
                description: {{value: pd.description, enumerable: true}},
                length: {{value: pd.mimeTypes.length, enumerable: true}},
            }});
            pd.mimeTypes.forEach((mt, i) => {{
                const mimeObj = createMimeType(mt, p);
                Object.defineProperty(p, i, {{value: mimeObj, enumerable: false}});
                Object.defineProperty(p, mt.type, {{value: mimeObj, enumerable: false}});
            }});
            p[Symbol.iterator] = function*() {{ for(let i=0; i<this.length; i++) yield this[i]; }};
            return p;
        }};
        const plugins = pluginData.map(createPlugin);
        const pluginArray = Object.create(PluginArray.prototype);
        plugins.forEach((p, i) => {{
            Object.defineProperty(pluginArray, i, {{value: p, enumerable: false}});
            Object.defineProperty(pluginArray, p.name, {{value: p, enumerable: false}});
        }});
        Object.defineProperty(pluginArray, 'length', {{value: plugins.length, enumerable: true}});
        pluginArray[Symbol.iterator] = function*() {{ for(let i=0; i<this.length; i++) yield this[i]; }};
        Object.defineProperty(navigator, 'plugins', {{get: () => pluginArray, enumerable: true}});
    }})();

    // ===== 4. Permission API spoofing =====
    (function() {{
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (params) => {{
            if (params.name === 'notifications') {{
                return Promise.resolve({{state: Notification.permission, onchange: null}});
            }}
            if (params.name === 'midi' || params.name === 'camera' || params.name === 'microphone') {{
                return Promise.resolve({{state: 'prompt', onchange: null}});
            }}
            return origQuery.call(window.navigator.permissions, params);
        }};
    }})();

    // ===== 5. Chrome runtime object =====
    window.chrome = {{
        runtime: {{
            onConnect: null,
            onMessage: null,
            connect: function() {{ return {{onMessage: {{addListener: function(){{}}}}, postMessage: function(){{}}}}; }},
            sendMessage: function() {{}},
            id: undefined,
        }},
        loadTimes: function() {{
            return {{
                commitLoadTime: Date.now() / 1000,
                connectionInfo: 'h2',
                finishDocumentLoadTime: Date.now() / 1000,
                finishLoadTime: Date.now() / 1000,
                firstPaintAfterLoadTime: 0,
                firstPaintTime: Date.now() / 1000,
                navigationType: 'Other',
                npnNegotiatedProtocol: 'h2',
                requestTime: Date.now() / 1000,
                startLoadTime: Date.now() / 1000,
                wasAlternateProtocolAvailable: false,
                wasFetchedViaSpdy: true,
                wasNpnNegotiated: true,
            }};
        }},
        csi: function() {{
            return {{
                onloadT: Date.now(),
                pageT: Date.now() - performance.timing.navigationStart,
                startE: performance.timing.navigationStart,
                tran: 15,
            }};
        }},
    }};

    // ===== 6. Screen metrics spoofing =====
    Object.defineProperty(screen, 'width', {{get: () => {screen["width"]}}});
    Object.defineProperty(screen, 'height', {{get: () => {screen["height"]}}});
    Object.defineProperty(screen, 'availWidth', {{get: () => {screen["avail_width"]}}});
    Object.defineProperty(screen, 'availHeight', {{get: () => {screen["avail_height"]}}});
    Object.defineProperty(screen, 'colorDepth', {{get: () => {screen["color_depth"]}}});
    Object.defineProperty(screen, 'pixelDepth', {{get: () => {screen["color_depth"]}}});
    Object.defineProperty(window, 'devicePixelRatio', {{get: () => {screen["dpr"]}}});
    Object.defineProperty(window, 'outerWidth', {{get: () => {screen["width"]}}});
    Object.defineProperty(window, 'outerHeight', {{get: () => {screen["height"]}}});

    // ===== 7. Hardware concurrency & device memory =====
    Object.defineProperty(navigator, 'hardwareConcurrency', {{get: () => {hw}}});
    Object.defineProperty(navigator, 'deviceMemory', {{get: () => {mem}}});

    // ===== 8. Canvas fingerprint poisoning =====
    (function() {{
        const seed = {canvas_seed};
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        const origToBlob = HTMLCanvasElement.prototype.toBlob;

        function noise(seed, idx) {{
            let x = Math.sin(seed + idx) * 10000;
            return (x - Math.floor(x)) * 2 - 1;  // -1 to 1
        }}

        HTMLCanvasElement.prototype.toDataURL = function() {{
            const ctx = this.getContext('2d');
            if (ctx && this.width > 0 && this.height > 0) {{
                try {{
                    const imgData = origGetImageData.call(ctx, 0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
                    for (let i = 0; i < imgData.data.length; i += 4) {{
                        imgData.data[i] = Math.max(0, Math.min(255, imgData.data[i] + Math.floor(noise(seed, i) * 1.5)));
                    }}
                    ctx.putImageData(imgData, 0, 0);
                }} catch(e) {{}}
            }}
            return origToDataURL.apply(this, arguments);
        }};

        HTMLCanvasElement.prototype.toBlob = function() {{
            const ctx = this.getContext('2d');
            if (ctx && this.width > 0 && this.height > 0) {{
                try {{
                    const imgData = origGetImageData.call(ctx, 0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
                    for (let i = 0; i < imgData.data.length; i += 4) {{
                        imgData.data[i] = Math.max(0, Math.min(255, imgData.data[i] + Math.floor(noise(seed, i) * 1.5)));
                    }}
                    ctx.putImageData(imgData, 0, 0);
                }} catch(e) {{}}
            }}
            return origToBlob.apply(this, arguments);
        }};
    }})();

    // ===== 9. AudioContext fingerprint spoofing =====
    (function() {{
        const audioSeed = {audio_seed};
        const origCreateOscillator = AudioContext.prototype.createOscillator;
        const origGetChannelData = AudioBuffer.prototype.getChannelData;

        AudioBuffer.prototype.getChannelData = function() {{
            const data = origGetChannelData.apply(this, arguments);
            // Add tiny noise to first few samples
            for (let i = 0; i < Math.min(data.length, 100); i++) {{
                data[i] += audioSeed * (Math.sin(i * 0.01) * 0.00001);
            }}
            return data;
        }};

        // Also patch OfflineAudioContext
        if (window.OfflineAudioContext) {{
            const origResume = OfflineAudioContext.prototype.startRendering;
            OfflineAudioContext.prototype.startRendering = function() {{
                return origResume.apply(this, arguments);
            }};
        }}
    }})();

    // ===== 10. WebGL fingerprint override =====
    (function() {{
        const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {{
            if (param === 37445) return '{webgl["vendor"]}';   // UNMASKED_VENDOR_WEBGL
            if (param === 37446) return '{webgl["renderer"]}'; // UNMASKED_RENDERER_WEBGL
            return getParameterOrig.call(this, param);
        }};
        // Also patch WebGL2
        if (window.WebGL2RenderingContext) {{
            const getParam2Orig = WebGL2RenderingContext.prototype.getParameter;
            WebGL2RenderingContext.prototype.getParameter = function(param) {{
                if (param === 37445) return '{webgl["vendor"]}';
                if (param === 37446) return '{webgl["renderer"]}';
                return getParam2Orig.call(this, param);
            }};
        }}
        // Patch getExtension for WEBGL_debug_renderer_info
        const origGetExtension = WebGLRenderingContext.prototype.getExtension;
        WebGLRenderingContext.prototype.getExtension = function(name) {{
            if (name === 'WEBGL_debug_renderer_info') {{
                return {{UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446}};
            }}
            return origGetExtension.call(this, name);
        }};
    }})();

    // ===== 11. Font detection defense =====
    (function() {{
        const allowedFonts = {fonts_json};
        const origFontCheck = document.fonts ? document.fonts.check.bind(document.fonts) : null;
        if (document.fonts && origFontCheck) {{
            document.fonts.check = function(font, text) {{
                const fontName = font.replace(/\\d+px\\s+/i, '').replace(/['"]/g, '').trim();
                if (allowedFonts.some(f => fontName.toLowerCase().includes(f.toLowerCase()))) {{
                    return origFontCheck(font, text);
                }}
                return false;
            }};
        }}
    }})();

    // ===== 12. Platform consistency =====
    Object.defineProperty(navigator, 'platform', {{get: () => '{platform["platform"]}'}});

    // ===== 13. WebRTC leak prevention (disable public IP exposure) =====
    (function() {{
        if (window.RTCPeerConnection) {{
            const origRTC = window.RTCPeerConnection;
            window.RTCPeerConnection = function(config) {{
                if (config && config.iceServers) {{
                    config.iceServers = [];  // Remove STUN servers to prevent IP leak
                }}
                return new origRTC(config);
            }};
            window.RTCPeerConnection.prototype = origRTC.prototype;
        }}
    }})();
    """


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
def start(config=None):
    """Start the browser with full stealth configuration.

    Config options (all optional, passed via env vars or startup command):
      AUTOMATE_PROXY        - proxy URL (http://user:pass@host:port or socks5://...)
      AUTOMATE_PROFILE_DIR  - persistent Chrome profile directory
      AUTOMATE_HEADLESS     - "new" to use --headless=new instead of Xvfb
      AUTOMATE_REGION       - fingerprint region (US/EU) for timezone/locale
    """
    global browser, display, _stealth_profile
    config = config or {}

    # Generate a random but internally-consistent fingerprint
    region = config.get("region", os.environ.get("AUTOMATE_REGION", "US"))
    _stealth_profile = _generate_fingerprint_profile(region)
    screen_prof = _stealth_profile["screen"]
    platform_prof = _stealth_profile["platform"]
    webgl_prof = _stealth_profile["webgl"]
    tz_prof = _stealth_profile["timezone"]

    # Determine headless strategy
    # Prefer Xvfb when available (even on Termux/proot where --headless=new
    # crashes due to GPU process failures). Only force headless=new if
    # explicitly requested or Xvfb (pyvirtualdisplay) isn't installed.
    use_headless_new = (
        config.get("headless", os.environ.get("AUTOMATE_HEADLESS", "")) == "new"
        or _Display is None
    )

    if not use_headless_new:
        try:
            display = _Display(
                visible=False, size=(screen_prof["width"], screen_prof["height"])
            )
            display.start()
        except Exception as e:
            sys.stderr.write(
                f"[engine] Xvfb failed ({e}), falling back to --headless=new\n"
            )
            display = None
            use_headless_new = True

    opts = uc.ChromeOptions()
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument(f"--window-size={screen_prof['width']},{screen_prof['height']}")
    opts.add_argument("--start-maximized")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--disable-infobars")
    opts.add_argument("--disable-browser-side-navigation")
    opts.add_argument("--disable-extensions")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--disable-features=VizDisplayCompositor")

    # Headless new mode (Chrome 109+, reduced fingerprint diff vs headed)
    if use_headless_new:
        opts.add_argument("--headless=new")

    # Persistent profile for cookie/fingerprint persistence
    profile_dir = config.get("profile_dir", os.environ.get("AUTOMATE_PROFILE_DIR", ""))
    if profile_dir:
        opts.add_argument(f"--user-data-dir={profile_dir}")

    # Proxy support (HTTP, HTTPS, SOCKS5)
    proxy_url = config.get("proxy", os.environ.get("AUTOMATE_PROXY", ""))
    if proxy_url:
        opts.add_argument(f"--proxy-server={proxy_url}")

    # WebRTC IP leak prevention
    opts.add_argument("--disable-webrtc-multiple-routes")
    opts.add_argument("--disable-webrtc-hw-encoding")
    opts.add_argument("--disable-webrtc-hw-decoding")
    opts.add_argument("--enforce-webrtc-ip-permission-check")
    opts.add_argument("--force-webrtc-ip-handling-policy=disable_non_proxied_udp")

    # Enable performance logging
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL", "performance": "ALL"})
    prefs = {
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
        "profile.default_content_setting_values.notifications": 2,
        # Disable WebRTC IP leak through prefs too
        "webrtc.ip_handling_policy": "disable_non_proxied_udp",
        "webrtc.multiple_routes_enabled": False,
        "webrtc.nonproxied_udp_enabled": False,
    }
    opts.add_experimental_option("prefs", prefs)

    chrome_paths = [
        "/data/data/com.termux/files/usr/bin/chromium-browser",
        "/data/data/com.termux/files/usr/bin/chromium",
        "/data/data/com.termux/files/usr/bin/google-chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    for p in chrome_paths:
        if os.path.exists(p):
            opts.binary_location = p
            break

    driver_paths = [
        "/data/data/com.termux/files/usr/bin/chromedriver",
        "/usr/bin/chromedriver",
        "/usr/sbin/chromedriver",
        "/usr/local/bin/chromedriver",
    ]
    driver_path = None
    for p in driver_paths:
        if os.path.exists(p):
            driver_path = p
            break

    kwargs = {"options": opts, "use_subprocess": True}
    if driver_path:
        kwargs["driver_executable_path"] = driver_path

    try:
        kwargs["version_main"] = 144
        browser = uc.Chrome(**kwargs)
    except Exception:
        if "version_main" in kwargs:
            del kwargs["version_main"]
        browser = uc.Chrome(**kwargs)

    # Apply selenium-stealth with profile-matched values
    stealth(
        browser,
        languages=[tz_prof["locale"], tz_prof["locale"].split("-")[0]],
        vendor="Google Inc.",
        platform=platform_prof["platform"],
        webgl_vendor=webgl_prof["vendor"],
        renderer=webgl_prof["renderer"],
        fix_hairline=True,
    )

    # Timezone emulation via CDP
    try:
        browser.execute_cdp_cmd(
            "Emulation.setTimezoneOverride",
            {"timezoneId": tz_prof["tz"]},
        )
    except Exception:
        pass

    # Locale emulation via CDP
    try:
        browser.execute_cdp_cmd(
            "Emulation.setLocaleOverride",
            {"locale": tz_prof["locale"]},
        )
    except Exception:
        pass

    # Inject comprehensive stealth JavaScript on every new document
    try:
        stealth_js = _build_stealth_js(_stealth_profile)
        browser.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": stealth_js},
        )
    except Exception:
        pass

    browser.set_window_size(screen_prof["width"], screen_prof["height"])
    return {
        "success": True,
        "profile": {
            "platform": platform_prof["platform"],
            "screen": f"{screen_prof['width']}x{screen_prof['height']}",
            "webgl": webgl_prof["renderer"],
            "timezone": tz_prof["tz"],
            "locale": tz_prof["locale"],
        },
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
BY_MAP = {
    "css": By.CSS_SELECTOR,
    "xpath": By.XPATH,
    "id": By.ID,
    "class": By.CLASS_NAME,
    "tag": By.TAG_NAME,
    "name": By.NAME,
    "link_text": By.LINK_TEXT,
    "partial_link_text": By.PARTIAL_LINK_TEXT,
}

KEY_MAP = {
    "enter": Keys.ENTER,
    "return": Keys.RETURN,
    "tab": Keys.TAB,
    "escape": Keys.ESCAPE,
    "backspace": Keys.BACKSPACE,
    "delete": Keys.DELETE,
    "space": Keys.SPACE,
    "up": Keys.ARROW_UP,
    "down": Keys.ARROW_DOWN,
    "left": Keys.ARROW_LEFT,
    "right": Keys.ARROW_RIGHT,
    "home": Keys.HOME,
    "end": Keys.END,
    "page_up": Keys.PAGE_UP,
    "page_down": Keys.PAGE_DOWN,
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
    "control": Keys.CONTROL,
    "ctrl": Keys.CONTROL,
    "alt": Keys.ALT,
    "shift": Keys.SHIFT,
    "meta": Keys.META,
    "command": Keys.COMMAND,
}


def by_str(s):
    return BY_MAP.get(s, By.CSS_SELECTOR)


def el_dict(el):
    """Convert a WebElement to a serialisable dict."""
    try:
        loc = el.location
        sz = el.size
        return {
            "tag": el.tag_name,
            "text": el.text[:500],
            "displayed": el.is_displayed(),
            "enabled": el.is_enabled(),
            "selected": el.is_selected(),
            "location": {"x": loc["x"], "y": loc["y"]},
            "size": {"width": sz["width"], "height": sz["height"]},
            "attrs": {
                "id": el.get_attribute("id") or "",
                "class": el.get_attribute("class") or "",
                "name": el.get_attribute("name") or "",
                "href": el.get_attribute("href"),
                "src": el.get_attribute("src"),
                "value": el.get_attribute("value") or "",
                "type": el.get_attribute("type") or "",
                "placeholder": el.get_attribute("placeholder"),
                "aria-label": el.get_attribute("aria-label"),
                "role": el.get_attribute("role"),
                "data-testid": el.get_attribute("data-testid"),
            },
        }
    except StaleElementReferenceException:
        return {"error": "stale element"}


def _safe_json(obj):
    """Ensure obj is JSON-serialisable."""
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        return str(obj)


# ---------------------------------------------------------------------------
# Human-like behavioral simulation
# ---------------------------------------------------------------------------
def _bezier_curve(start, end, steps=20):
    """Generate a bezier curve between two points for natural mouse movement."""
    # Random control points for natural curvature
    cx1 = (
        start[0]
        + random.uniform(0.1, 0.4) * (end[0] - start[0])
        + random.randint(-50, 50)
    )
    cy1 = (
        start[1]
        + random.uniform(0.1, 0.4) * (end[1] - start[1])
        + random.randint(-50, 50)
    )
    cx2 = (
        start[0]
        + random.uniform(0.6, 0.9) * (end[0] - start[0])
        + random.randint(-30, 30)
    )
    cy2 = (
        start[1]
        + random.uniform(0.6, 0.9) * (end[1] - start[1])
        + random.randint(-30, 30)
    )

    points = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * start[0] + 3 * u**2 * t * cx1 + 3 * u * t**2 * cx2 + t**3 * end[0]
        y = u**3 * start[1] + 3 * u**2 * t * cy1 + 3 * u * t**2 * cy2 + t**3 * end[1]
        points.append((int(x), int(y)))
    return points


def _human_move_to(element):
    """Move mouse to element along a natural bezier curve."""
    global browser
    try:
        loc = element.location
        size = element.size
        # Target point: random offset within element
        target_x = loc["x"] + random.randint(
            int(size["width"] * 0.2), int(size["width"] * 0.8)
        )
        target_y = loc["y"] + random.randint(
            int(size["height"] * 0.2), int(size["height"] * 0.8)
        )

        # Current mouse position (approximate from window center)
        start_x = random.randint(100, 800)
        start_y = random.randint(100, 500)

        points = _bezier_curve(
            (start_x, start_y), (target_x, target_y), steps=random.randint(15, 30)
        )

        chain = ActionChains(browser)
        chain.move_by_offset(points[0][0] - start_x, points[0][1] - start_y)
        for i in range(1, len(points)):
            dx = points[i][0] - points[i - 1][0]
            dy = points[i][1] - points[i - 1][1]
            chain.move_by_offset(dx, dy)
            # Variable speed: slower at start and end
            chain.pause(random.uniform(0.005, 0.025))
        chain.perform()
    except Exception:
        # Fallback to simple move
        ActionChains(browser).move_to_element(element).perform()


def _human_type_text(element, text):
    """Type text with human-like timing variations."""
    for char in text:
        element.send_keys(char)
        # Variable delay: faster for common chars, slower for special
        if char in " .,!?":
            time.sleep(random.uniform(0.08, 0.20))
        elif char.isupper():
            time.sleep(random.uniform(0.05, 0.15))
        else:
            time.sleep(random.uniform(0.03, 0.12))
        # Occasional micro-pause (thinking)
        if random.random() < 0.05:
            time.sleep(random.uniform(0.3, 0.8))


def _human_scroll(browser_inst, direction="down", amount=None):
    """Scroll with human-like variable speed."""
    if amount is None:
        amount = random.randint(200, 600)
    steps = random.randint(3, 8)
    per_step = amount / steps
    for _ in range(steps):
        step_amount = per_step + random.uniform(-20, 20)
        if direction == "down":
            browser_inst.execute_script(f"window.scrollBy(0, {step_amount});")
        else:
            browser_inst.execute_script(f"window.scrollBy(0, -{step_amount});")
        time.sleep(random.uniform(0.02, 0.08))


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
def handle_command(cmd):
    global browser, display, _network_log, _console_logger_injected
    action = cmd.get("action")

    # ==== Navigation ====
    if action == "navigate":
        browser.get(cmd["url"])
        # Random small delay to look human
        time.sleep(random.uniform(0.2, 0.5))
        return {"success": True, "title": browser.title, "url": browser.current_url}

    elif action == "back":
        browser.back()
        return {"success": True, "url": browser.current_url, "title": browser.title}

    elif action == "forward":
        browser.forward()
        return {"success": True, "url": browser.current_url, "title": browser.title}

    elif action == "refresh":
        browser.refresh()
        return {"success": True, "url": browser.current_url, "title": browser.title}

    # ==== Stealth info ====
    elif action == "get_stealth_profile":
        return {
            "success": True,
            "profile": {
                "platform": _stealth_profile.get("platform", {}).get(
                    "platform", "unknown"
                ),
                "screen": f"{_stealth_profile.get('screen', {}).get('width', 0)}x{_stealth_profile.get('screen', {}).get('height', 0)}",
                "webgl_vendor": _stealth_profile.get("webgl", {}).get("vendor", ""),
                "webgl_renderer": _stealth_profile.get("webgl", {}).get("renderer", ""),
                "timezone": _stealth_profile.get("timezone", {}).get("tz", ""),
                "locale": _stealth_profile.get("timezone", {}).get("locale", ""),
                "hw_concurrency": _stealth_profile.get("hw_concurrency", 0),
                "device_memory": _stealth_profile.get("device_memory", 0),
            },
        }

    # ==== Human-like actions ====
    elif action == "human_click":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        _human_move_to(el)
        time.sleep(random.uniform(0.05, 0.15))
        el.click()
        time.sleep(random.uniform(0.1, 0.3))
        return {"success": True, "url": browser.current_url, "title": browser.title}

    elif action == "human_type":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        if cmd.get("clear", True):
            el.click()
            time.sleep(random.uniform(0.1, 0.2))
            # Select all + delete instead of .clear() (more human)
            el.send_keys(Keys.CONTROL + "a")
            time.sleep(random.uniform(0.05, 0.1))
            el.send_keys(Keys.DELETE)
            time.sleep(random.uniform(0.1, 0.2))
        _human_type_text(el, cmd["text"])
        return {"success": True}

    elif action == "human_scroll":
        d = cmd.get("direction", "down")
        amt = cmd.get("amount")
        _human_scroll(browser, d, amt)
        return {"success": True}

    # ==== Screenshots ====
    elif action == "screenshot":
        data = browser.get_screenshot_as_base64()
        if cmd.get("save_path"):
            browser.save_screenshot(cmd["save_path"])
            return {"success": True, "path": cmd["save_path"]}
        return {
            "success": True,
            "data_length": len(data),
            "data_preview": data[:200] + "...",
        }

    elif action == "screenshot_full":
        data = browser.get_screenshot_as_base64()
        return {"success": True, "data": data}

    elif action == "screenshot_element":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        data = el.screenshot_as_base64
        if cmd.get("save_path"):
            el.screenshot(cmd["save_path"])
            return {"success": True, "path": cmd["save_path"]}
        return {
            "success": True,
            "data_length": len(data),
            "data_preview": data[:200] + "...",
        }

    # ==== Element interaction ====
    elif action == "click":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        el.click()
        return {"success": True, "url": browser.current_url, "title": browser.title}

    elif action == "type":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        if cmd.get("clear", True):
            el.clear()
        el.send_keys(cmd["text"])
        return {"success": True}

    elif action == "find":
        els = browser.find_elements(by_str(cmd.get("by", "css")), cmd["selector"])[
            : cmd.get("limit", 10)
        ]
        return {
            "success": True,
            "count": len(els),
            "elements": [el_dict(e) for e in els],
        }

    elif action == "hover":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        ActionChains(browser).move_to_element(el).perform()
        return {"success": True}

    elif action == "double_click":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        ActionChains(browser).double_click(el).perform()
        return {"success": True}

    elif action == "right_click":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        ActionChains(browser).context_click(el).perform()
        return {"success": True}

    elif action == "drag":
        src = browser.find_element(by_str(cmd.get("by", "css")), cmd["source"])
        tgt = browser.find_element(by_str(cmd.get("by", "css")), cmd["target"])
        ActionChains(browser).drag_and_drop(src, tgt).perform()
        return {"success": True}

    elif action == "scroll":
        d = cmd.get("direction", "down")
        amt = cmd.get("amount", 500)
        if d == "down":
            browser.execute_script(f"window.scrollBy(0,{amt});")
        elif d == "up":
            browser.execute_script(f"window.scrollBy(0,-{amt});")
        elif d == "top":
            browser.execute_script("window.scrollTo(0,0);")
        elif d == "bottom":
            browser.execute_script("window.scrollTo(0,document.body.scrollHeight);")
        return {"success": True}

    elif action == "scroll_to":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        browser.execute_script(
            "arguments[0].scrollIntoView({behavior:'smooth',block:'center'});", el
        )
        return {"success": True}

    # ==== Page content ====
    elif action == "get_page":
        body = browser.find_element(By.TAG_NAME, "body")
        text = body.text
        if len(text) > 20000:
            text = text[:20000] + "..."
        return {
            "success": True,
            "url": browser.current_url,
            "title": browser.title,
            "text": text,
        }

    elif action == "get_html":
        html = browser.page_source
        if len(html) > 50000:
            html = html[:50000] + "..."
        return {"success": True, "html": html}

    elif action == "execute_js":
        r = browser.execute_script(cmd["script"])
        return {"success": True, "result": _safe_json(r)}

    # ==== Forms ====
    elif action == "submit":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        el.submit()
        return {"success": True, "url": browser.current_url}

    elif action == "fill_form":
        filled = []
        for field_name, field_value in cmd["data"].items():
            try:
                el = browser.find_element(By.NAME, field_name)
            except NoSuchElementException:
                try:
                    el = browser.find_element(By.ID, field_name)
                except NoSuchElementException:
                    el = browser.find_element(
                        By.CSS_SELECTOR, f'[placeholder*="{field_name}"]'
                    )
            el.clear()
            el.send_keys(str(field_value))
            filled.append(field_name)
        return {"success": True, "filled": filled}

    elif action == "select":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        sel = Select(el)
        if cmd.get("value"):
            sel.select_by_value(cmd["value"])
        elif cmd.get("text"):
            sel.select_by_visible_text(cmd["text"])
        elif cmd.get("index") is not None:
            sel.select_by_index(cmd["index"])
        return {"success": True}

    elif action == "find_forms":
        forms = browser.find_elements(By.TAG_NAME, "form")
        fdata = []
        for i, f in enumerate(forms):
            inputs = (
                f.find_elements(By.TAG_NAME, "input")
                + f.find_elements(By.TAG_NAME, "textarea")
                + f.find_elements(By.TAG_NAME, "select")
            )
            fdata.append(
                {
                    "index": i,
                    "id": f.get_attribute("id"),
                    "action": f.get_attribute("action"),
                    "method": f.get_attribute("method") or "GET",
                    "inputs": [
                        {
                            "tag": inp.tag_name,
                            "type": inp.get_attribute("type"),
                            "name": inp.get_attribute("name"),
                            "id": inp.get_attribute("id"),
                            "required": inp.get_attribute("required") is not None,
                            "value": inp.get_attribute("value") or "",
                        }
                        for inp in inputs
                    ],
                }
            )
        return {"success": True, "forms": fdata}

    elif action == "find_links":
        els = browser.find_elements(By.TAG_NAME, "a")[: cmd.get("limit", 20)]
        links = [
            {
                "text": e.text.strip() or "[no text]",
                "href": e.get_attribute("href"),
                "target": e.get_attribute("target") or "",
            }
            for e in els
            if e.get_attribute("href")
        ]
        return {"success": True, "count": len(links), "links": links}

    # ==== Waiting ====
    elif action == "wait_element":
        wait = WebDriverWait(browser, cmd.get("timeout", 10))
        conds = {
            "present": EC.presence_of_element_located,
            "visible": EC.visibility_of_element_located,
            "clickable": EC.element_to_be_clickable,
            "invisible": EC.invisibility_of_element_located,
        }
        c = conds.get(cmd.get("condition", "present"), EC.presence_of_element_located)
        el = wait.until(c((by_str(cmd.get("by", "css")), cmd["selector"])))
        if el and not isinstance(el, bool):
            return {"success": True, "element": el_dict(el)}
        return {"success": True}

    elif action == "wait":
        time.sleep(cmd.get("seconds", 1))
        return {"success": True}

    # ==== Keyboard ====
    elif action == "press_key":
        k = KEY_MAP.get(cmd["key"].lower(), cmd["key"])
        if cmd.get("selector"):
            el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
            el.send_keys(k)
        else:
            ActionChains(browser).send_keys(k).perform()
        return {"success": True}

    elif action == "key_combo":
        # e.g. {"keys": ["ctrl", "a"]}
        keys = cmd.get("keys", [])
        chain = ActionChains(browser)
        mapped = [KEY_MAP.get(k.lower(), k) for k in keys]
        # Hold all modifier keys, press last key, release
        for k in mapped[:-1]:
            chain.key_down(k)
        if mapped:
            chain.send_keys(mapped[-1])
        for k in reversed(mapped[:-1]):
            chain.key_up(k)
        chain.perform()
        return {"success": True}

    # ==== Cookies ====
    elif action == "cookies":
        return {"success": True, "cookies": browser.get_cookies()}

    elif action == "set_cookie":
        cookie = {"name": cmd["name"], "value": cmd["value"]}
        if cmd.get("domain"):
            cookie["domain"] = cmd["domain"]
        if cmd.get("path"):
            cookie["path"] = cmd["path"]
        if cmd.get("secure"):
            cookie["secure"] = True
        browser.add_cookie(cookie)
        return {"success": True}

    elif action == "delete_cookie":
        browser.delete_cookie(cmd["name"])
        return {"success": True}

    elif action == "delete_cookies":
        browser.delete_all_cookies()
        return {"success": True}

    # ==== localStorage / sessionStorage ====
    elif action == "local_storage_get":
        data = browser.execute_script(
            "var s={}; for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);s[k]=localStorage.getItem(k);} return s;"
        )
        return {"success": True, "data": data}

    elif action == "local_storage_set":
        browser.execute_script(
            "localStorage.setItem(arguments[0], arguments[1]);",
            cmd["key"],
            cmd["value"],
        )
        return {"success": True}

    elif action == "local_storage_remove":
        browser.execute_script("localStorage.removeItem(arguments[0]);", cmd["key"])
        return {"success": True}

    elif action == "local_storage_clear":
        browser.execute_script("localStorage.clear();")
        return {"success": True}

    elif action == "session_storage_get":
        data = browser.execute_script(
            "var s={}; for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);s[k]=sessionStorage.getItem(k);} return s;"
        )
        return {"success": True, "data": data}

    elif action == "session_storage_set":
        browser.execute_script(
            "sessionStorage.setItem(arguments[0], arguments[1]);",
            cmd["key"],
            cmd["value"],
        )
        return {"success": True}

    elif action == "session_storage_clear":
        browser.execute_script("sessionStorage.clear();")
        return {"success": True}

    # ==== Tabs ====
    elif action == "tabs":
        handles = browser.window_handles
        tabs_info = []
        current = browser.current_window_handle
        for h in handles:
            browser.switch_to.window(h)
            tabs_info.append(
                {"handle": h, "title": browser.title, "url": browser.current_url}
            )
        browser.switch_to.window(current)
        return {"success": True, "current": current, "tabs": tabs_info}

    elif action == "new_tab":
        browser.execute_script("window.open('');")
        browser.switch_to.window(browser.window_handles[-1])
        if cmd.get("url"):
            browser.get(cmd["url"])
        return {"success": True, "handle": browser.current_window_handle}

    elif action == "switch_tab":
        browser.switch_to.window(cmd["handle"])
        return {"success": True, "title": browser.title, "url": browser.current_url}

    elif action == "close_tab":
        browser.close()
        if browser.window_handles:
            browser.switch_to.window(browser.window_handles[-1])
        return {"success": True}

    # ==== iFrames ====
    elif action == "switch_frame":
        if cmd.get("selector"):
            el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
            browser.switch_to.frame(el)
        elif cmd.get("index") is not None:
            browser.switch_to.frame(cmd["index"])
        else:
            browser.switch_to.default_content()
        return {"success": True}

    # ==== Alerts ====
    elif action == "alert":
        try:
            alert = browser.switch_to.alert
            text = alert.text
            if cmd.get("accept", True):
                alert.accept()
            else:
                alert.dismiss()
            return {"success": True, "text": text}
        except NoAlertPresentException:
            return {"success": False, "error": "No alert present"}

    # ==== File upload ====
    elif action == "upload":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        el.send_keys(cmd["file_path"])
        return {"success": True}

    # ==== Content extraction ====
    elif action == "get_images":
        imgs = browser.find_elements(By.TAG_NAME, "img")[: cmd.get("limit", 20)]
        return {
            "success": True,
            "images": [
                {
                    "src": i.get_attribute("src"),
                    "alt": i.get_attribute("alt") or "",
                    "width": i.size["width"],
                    "height": i.size["height"],
                    "loading": i.get_attribute("loading") or "",
                }
                for i in imgs
            ],
        }

    elif action == "get_headings":
        headings = []
        for lvl in range(1, 7):
            for h in browser.find_elements(By.TAG_NAME, f"h{lvl}"):
                headings.append({"level": lvl, "text": h.text})
        return {"success": True, "headings": headings}

    elif action == "search_text":
        body_text = browser.find_element(By.TAG_NAME, "body").text
        query = cmd["text"]
        if not cmd.get("case_sensitive", False):
            found = query.lower() in body_text.lower()
            count = body_text.lower().count(query.lower())
        else:
            found = query in body_text
            count = body_text.count(query)
        return {
            "success": True,
            "found": found,
            "count": count,
            "text_length": len(body_text),
        }

    elif action == "get_meta":
        meta = browser.execute_script("""
            var result = {title: document.title, url: window.location.href, meta: {}, og: {}};
            var metas = document.querySelectorAll('meta');
            for (var m of metas) {
                var name = m.getAttribute('name') || m.getAttribute('property') || '';
                var content = m.getAttribute('content') || '';
                if (name.startsWith('og:')) result.og[name] = content;
                else if (name) result.meta[name] = content;
            }
            var canonical = document.querySelector('link[rel="canonical"]');
            if (canonical) result.canonical = canonical.href;
            var lang = document.documentElement.lang;
            if (lang) result.lang = lang;
            return result;
        """)
        return {"success": True, **meta}

    elif action == "extract_table":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        table_data = browser.execute_script(
            """
            var table = arguments[0];
            var headers = [];
            var rows = [];
            var ths = table.querySelectorAll('thead th, tr:first-child th');
            for (var th of ths) headers.push(th.textContent.trim());
            var trs = table.querySelectorAll('tbody tr, tr');
            var startIdx = headers.length > 0 ? 0 : 0;
            for (var tr of trs) {
                var cells = tr.querySelectorAll('td');
                if (cells.length === 0) continue;
                var row = [];
                for (var td of cells) row.push(td.textContent.trim());
                rows.push(row);
            }
            return {headers: headers, rows: rows, row_count: rows.length};
        """,
            el,
        )
        return {"success": True, **table_data}

    # ==== Console & performance ====
    elif action == "console_logs":
        try:
            logs = browser.get_log(cmd.get("log_type", "browser"))
            return {
                "success": True,
                "logs": [
                    {"level": l["level"], "message": l["message"][:500]}
                    for l in logs[:50]
                ],
            }
        except Exception:
            return {"success": True, "logs": []}

    elif action == "get_performance":
        perf = browser.execute_script("""
            var t = performance.timing;
            var nav = performance.getEntriesByType('navigation')[0] || {};
            return {
                dns: t.domainLookupEnd - t.domainLookupStart,
                tcp: t.connectEnd - t.connectStart,
                ttfb: t.responseStart - t.requestStart,
                dom_load: t.domContentLoadedEventEnd - t.navigationStart,
                full_load: t.loadEventEnd - t.navigationStart,
                dom_interactive: t.domInteractive - t.navigationStart,
                resources: performance.getEntriesByType('resource').length,
                transfer_size: nav.transferSize || 0,
            };
        """)
        return {"success": True, "performance": perf}

    elif action == "get_js_errors":
        errors = browser.execute_script("""
            return window.__automate_js_errors || [];
        """)
        return {"success": True, "errors": errors or []}

    # ==== Network interception ====
    elif action == "inject_network_logger":
        browser.execute_script("""
            if (!window.__automate_net_log) {
                window.__automate_net_log = [];
                var origFetch = window.fetch;
                window.fetch = function() {
                    var url = arguments[0];
                    if (typeof url === 'object') url = url.url;
                    var method = (arguments[1] && arguments[1].method) || 'GET';
                    var entry = {type:'fetch', method:method, url:url, timestamp:Date.now()};
                    window.__automate_net_log.push(entry);
                    return origFetch.apply(this, arguments).then(function(r) {
                        entry.status = r.status;
                        return r;
                    }).catch(function(e) {
                        entry.error = e.message;
                        throw e;
                    });
                };
                var origXHR = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url) {
                    this.__log_entry = {type:'xhr', method:method, url:url, timestamp:Date.now()};
                    window.__automate_net_log.push(this.__log_entry);
                    return origXHR.apply(this, arguments);
                };
                var origSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.send = function() {
                    var entry = this.__log_entry;
                    this.addEventListener('load', function() { if(entry) entry.status = this.status; });
                    this.addEventListener('error', function() { if(entry) entry.error = 'network error'; });
                    return origSend.apply(this, arguments);
                };
            }
        """)
        return {"success": True}

    elif action == "get_network_log":
        logs = browser.execute_script("return window.__automate_net_log || [];")
        return {"success": True, "requests": logs[:100]}

    elif action == "clear_network_log":
        browser.execute_script("window.__automate_net_log = [];")
        return {"success": True}

    # ==== CSS / visual ====
    elif action == "highlight":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        color = cmd.get("color", "red")
        browser.execute_script(
            f"arguments[0].style.outline='3px solid {color}';arguments[0].style.outlineOffset='2px';",
            el,
        )
        return {"success": True}

    elif action == "get_computed_style":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        props = cmd.get(
            "properties",
            [
                "color",
                "background-color",
                "font-size",
                "font-family",
                "display",
                "position",
                "width",
                "height",
                "margin",
                "padding",
            ],
        )
        styles = {}
        for prop in props:
            styles[prop] = browser.execute_script(
                f"return window.getComputedStyle(arguments[0]).getPropertyValue('{prop}');",
                el,
            )
        return {"success": True, "styles": styles}

    elif action == "get_bounding_box":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        rect = browser.execute_script(
            "var r = arguments[0].getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left};",
            el,
        )
        return {"success": True, "rect": rect}

    # ==== Shadow DOM ====
    elif action == "find_in_shadow":
        # cmd: {"host_selector": "...", "inner_selector": "...", "by": "css"}
        host = browser.find_element(by_str(cmd.get("by", "css")), cmd["host_selector"])
        elements = browser.execute_script(
            "return arguments[0].shadowRoot ? Array.from(arguments[0].shadowRoot.querySelectorAll(arguments[1])) : [];",
            host,
            cmd["inner_selector"],
        )
        return {
            "success": True,
            "count": len(elements),
            "elements": [el_dict(e) for e in elements[: cmd.get("limit", 10)]],
        }

    elif action == "click_in_shadow":
        host = browser.find_element(by_str(cmd.get("by", "css")), cmd["host_selector"])
        browser.execute_script(
            "var el = arguments[0].shadowRoot.querySelector(arguments[1]); if(el) el.click();",
            host,
            cmd["inner_selector"],
        )
        return {"success": True}

    # ==== Geolocation ====
    elif action == "set_geolocation":
        browser.execute_cdp_cmd(
            "Emulation.setGeolocationOverride",
            {
                "latitude": cmd["latitude"],
                "longitude": cmd["longitude"],
                "accuracy": cmd.get("accuracy", 100),
            },
        )
        return {"success": True}

    # ==== Accessibility ====
    elif action == "check_accessibility":
        issues = browser.execute_script("""
            var issues = [];
            // Images without alt
            document.querySelectorAll('img').forEach(function(img) {
                if (!img.alt && !img.getAttribute('aria-label') && !img.getAttribute('aria-hidden'))
                    issues.push({type:'img_no_alt', element: img.outerHTML.substring(0,120)});
            });
            // Form inputs without labels
            document.querySelectorAll('input, textarea, select').forEach(function(el) {
                if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
                var id = el.id;
                var hasLabel = id && document.querySelector('label[for="'+id+'"]');
                var hasAriaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
                var wrappedInLabel = el.closest('label');
                if (!hasLabel && !hasAriaLabel && !wrappedInLabel)
                    issues.push({type:'input_no_label', element: el.outerHTML.substring(0,120)});
            });
            // Missing page title
            if (!document.title) issues.push({type:'no_page_title'});
            // Missing lang attribute
            if (!document.documentElement.lang) issues.push({type:'no_lang_attr'});
            // Empty links
            document.querySelectorAll('a').forEach(function(a) {
                if (!a.textContent.trim() && !a.querySelector('img') && !a.getAttribute('aria-label'))
                    issues.push({type:'empty_link', href: a.href});
            });
            // Missing h1
            if (document.querySelectorAll('h1').length === 0) issues.push({type:'no_h1'});
            // Heading order violations
            var headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
            var prevLevel = 0;
            headings.forEach(function(h) {
                var level = parseInt(h.tagName.charAt(1));
                if (level > prevLevel + 1 && prevLevel > 0)
                    issues.push({type:'heading_skip', from:'h'+prevLevel, to:'h'+level});
                prevLevel = level;
            });
            // Low contrast placeholder (basic heuristic)
            return {issues: issues, issue_count: issues.length};
        """)
        return {"success": True, **issues}

    elif action == "get_aria_info":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        aria = browser.execute_script(
            """
            var el = arguments[0];
            var attrs = {};
            for (var a of el.attributes) {
                if (a.name.startsWith('aria-') || a.name === 'role' || a.name === 'tabindex')
                    attrs[a.name] = a.value;
            }
            return attrs;
        """,
            el,
        )
        return {"success": True, "aria": aria}

    # ==== Text-based interaction (no selectors needed) ====
    elif action == "click_text":
        # Click the first visible element whose text matches (case-insensitive substring by default)
        target_text = cmd["text"]
        exact = cmd.get("exact", False)
        tag_filter = cmd.get("tag", "")  # optional: button, a, div, etc.
        el = browser.execute_script("""
            var text = arguments[0];
            var exact = arguments[1];
            var tagFilter = arguments[2];
            var selector = tagFilter || '*';
            var all = document.querySelectorAll(selector);
            for (var el of all) {
                if (el.offsetParent === null && el.tagName !== 'BODY') continue;  // skip hidden
                var elText = (el.textContent || '').trim();
                var ariaLabel = el.getAttribute('aria-label') || '';
                var title = el.getAttribute('title') || '';
                var candidate = elText || ariaLabel || title;
                if (exact) {
                    if (candidate === text || ariaLabel === text) return el;
                } else {
                    var lower = text.toLowerCase();
                    if (candidate.toLowerCase().includes(lower) ||
                        ariaLabel.toLowerCase().includes(lower)) return el;
                }
            }
            return null;
        """, target_text, exact, tag_filter)
        if not el:
            return {"success": False, "error": f'No visible element found with text "{target_text}"'}
        _human_move_to(el)
        time.sleep(random.uniform(0.05, 0.15))
        el.click()
        time.sleep(random.uniform(0.1, 0.3))
        return {"success": True, "url": browser.current_url, "title": browser.title,
                "clicked": el_dict(el)}

    elif action == "find_text":
        # Find all visible elements matching text — returns info for each, no selectors needed
        target_text = cmd["text"]
        exact = cmd.get("exact", False)
        tag_filter = cmd.get("tag", "")
        limit = cmd.get("limit", 10)
        elements = browser.execute_script("""
            var text = arguments[0];
            var exact = arguments[1];
            var tagFilter = arguments[2];
            var limit = arguments[3];
            var selector = tagFilter || '*';
            var all = document.querySelectorAll(selector);
            var results = [];
            for (var el of all) {
                if (results.length >= limit) break;
                if (el.offsetParent === null && el.tagName !== 'BODY') continue;
                var elText = (el.textContent || '').trim();
                var ariaLabel = el.getAttribute('aria-label') || '';
                var title = el.getAttribute('title') || '';
                var candidate = elText || ariaLabel || title;
                if (!candidate) continue;
                var match = false;
                if (exact) {
                    match = (candidate === text || ariaLabel === text);
                } else {
                    var lower = text.toLowerCase();
                    match = candidate.toLowerCase().includes(lower) ||
                            ariaLabel.toLowerCase().includes(lower);
                }
                if (match) results.push(el);
            }
            return results;
        """, target_text, exact, tag_filter, limit)
        return {
            "success": True,
            "count": len(elements),
            "elements": [el_dict(e) for e in elements],
        }

    elif action == "get_interactive":
        # Get all interactive elements on page — buttons, links, inputs, etc.
        # Much faster than screenshot+vision for understanding what's clickable
        limit = cmd.get("limit", 30)
        elements = browser.execute_script("""
            var limit = arguments[0];
            var selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [tabindex], [onclick]';
            var all = document.querySelectorAll(selectors);
            var results = [];
            for (var el of all) {
                if (results.length >= limit) break;
                if (el.offsetParent === null && el.tagName !== 'BODY') continue;
                var text = (el.textContent || '').trim().substring(0, 100);
                var ariaLabel = el.getAttribute('aria-label') || '';
                var role = el.getAttribute('role') || '';
                var tag = el.tagName.toLowerCase();
                var type = el.getAttribute('type') || '';
                var placeholder = el.getAttribute('placeholder') || '';
                var href = el.getAttribute('href') || '';
                var name = el.getAttribute('name') || '';
                var id = el.id || '';
                var label = text || ariaLabel || placeholder || name || id || '[unnamed]';
                results.push({
                    tag: tag, type: type, role: role,
                    label: label,
                    ariaLabel: ariaLabel,
                    id: id, name: name,
                    href: href ? href.substring(0, 150) : '',
                    placeholder: placeholder,
                    enabled: !el.disabled,
                    rect: (function() {
                        var r = el.getBoundingClientRect();
                        return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
                    })()
                });
            }
            return results;
        """, limit)
        return {"success": True, "count": len(elements), "elements": elements}

    elif action == "get_aria_tree":
        # Compact accessibility tree — great for React/SPA apps with randomized class names
        max_depth = cmd.get("max_depth", 5)
        tree = browser.execute_script("""
            function buildTree(el, depth, maxDepth) {
                if (depth > maxDepth) return null;
                var role = el.getAttribute('role') || '';
                var ariaLabel = el.getAttribute('aria-label') || '';
                var ariaExpanded = el.getAttribute('aria-expanded');
                var ariaSelected = el.getAttribute('aria-selected');
                var ariaChecked = el.getAttribute('aria-checked');
                var ariaDisabled = el.getAttribute('aria-disabled');
                var tag = el.tagName ? el.tagName.toLowerCase() : '';
                var text = '';
                // Get direct text content (not children's text)
                for (var node of el.childNodes) {
                    if (node.nodeType === 3) text += node.textContent.trim() + ' ';
                }
                text = text.trim().substring(0, 80);

                // Implicit roles
                var implicitRole = '';
                if (tag === 'button') implicitRole = 'button';
                else if (tag === 'a' && el.href) implicitRole = 'link';
                else if (tag === 'input') implicitRole = 'input-' + (el.type || 'text');
                else if (tag === 'select') implicitRole = 'combobox';
                else if (tag === 'textarea') implicitRole = 'textbox';
                else if (tag === 'nav') implicitRole = 'navigation';
                else if (tag === 'main') implicitRole = 'main';
                else if (tag === 'header') implicitRole = 'banner';
                else if (tag === 'footer') implicitRole = 'contentinfo';
                else if (tag.match(/^h[1-6]$/)) implicitRole = 'heading';

                var effectiveRole = role || implicitRole;
                var isInteresting = effectiveRole || ariaLabel || text ||
                    el.id || tag === 'img' || el.getAttribute('tabindex');

                if (!isInteresting && el.children.length === 0) return null;

                var node = {};
                if (effectiveRole) node.role = effectiveRole;
                if (tag) node.tag = tag;
                if (text) node.text = text;
                if (ariaLabel) node.label = ariaLabel;
                if (el.id) node.id = el.id;
                if (ariaExpanded !== null) node.expanded = ariaExpanded;
                if (ariaSelected !== null) node.selected = ariaSelected;
                if (ariaChecked !== null) node.checked = ariaChecked;
                if (ariaDisabled !== null) node.disabled = ariaDisabled;

                var children = [];
                for (var child of el.children) {
                    if (child.offsetParent === null && child.tagName !== 'BODY' &&
                        child.tagName !== 'HEAD') continue;
                    var c = buildTree(child, depth + 1, maxDepth);
                    if (c) children.push(c);
                }
                if (children.length > 0) node.children = children;

                // Skip wrapper nodes with no semantic value
                if (!effectiveRole && !ariaLabel && !text && !el.id &&
                    children.length === 1) return children[0];

                return node;
            }
            return buildTree(document.body, 0, arguments[0]);
        """, max_depth)
        return {"success": True, "tree": tree}

    # ==== PDF ====
    elif action == "print_to_pdf":
        params = {
            "landscape": cmd.get("landscape", False),
            "printBackground": cmd.get("print_background", True),
            "paperWidth": cmd.get("paper_width", 8.5),
            "paperHeight": cmd.get("paper_height", 11),
            "marginTop": cmd.get("margin_top", 0.4),
            "marginBottom": cmd.get("margin_bottom", 0.4),
            "marginLeft": cmd.get("margin_left", 0.4),
            "marginRight": cmd.get("margin_right", 0.4),
        }
        result = browser.execute_cdp_cmd("Page.printToPDF", params)
        pdf_data = result["data"]
        if cmd.get("save_path"):
            with open(cmd["save_path"], "wb") as f:
                f.write(base64.b64decode(pdf_data))
            return {"success": True, "path": cmd["save_path"]}
        return {"success": True, "data_length": len(pdf_data)}

    # ==== Media control ====
    elif action == "control_media":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        action_type = cmd.get("media_action", "play")
        if action_type == "play":
            browser.execute_script("arguments[0].play();", el)
        elif action_type == "pause":
            browser.execute_script("arguments[0].pause();", el)
        elif action_type == "mute":
            browser.execute_script("arguments[0].muted = true;", el)
        elif action_type == "unmute":
            browser.execute_script("arguments[0].muted = false;", el)
        return {"success": True}

    elif action == "get_media_state":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        state = browser.execute_script(
            """
            var m = arguments[0];
            return {
                paused: m.paused, muted: m.muted, volume: m.volume,
                currentTime: m.currentTime, duration: m.duration || 0,
                ended: m.ended, loop: m.loop, playbackRate: m.playbackRate,
                src: m.currentSrc || m.src,
            };
        """,
            el,
        )
        return {"success": True, **state}

    elif action == "seek_media":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        browser.execute_script(
            "arguments[0].currentTime = arguments[1];", el, cmd["time"]
        )
        return {"success": True}

    # ==== Window management ====
    elif action == "set_window_size":
        browser.set_window_size(cmd.get("width", 1920), cmd.get("height", 1080))
        return {"success": True}

    elif action == "maximize_window":
        browser.maximize_window()
        return {"success": True}

    # ==== File save ====
    elif action == "save_html":
        with open(cmd["path"], "w", encoding="utf-8") as f:
            f.write(browser.page_source)
        return {"success": True, "path": cmd["path"]}

    # ==== Search shortcuts ====
    elif action == "google_search":
        q = urllib.parse.quote_plus(cmd["query"])
        browser.get(f"https://www.google.com/search?q={q}")
        time.sleep(1)
        return {"success": True, "url": browser.current_url, "title": browser.title}

    elif action == "duckduckgo_search":
        q = urllib.parse.quote_plus(cmd["query"])
        browser.get(f"https://duckduckgo.com/?q={q}")
        time.sleep(1)
        return {"success": True, "url": browser.current_url, "title": browser.title}

    # ==== Inject error catcher ====
    elif action == "inject_error_catcher":
        browser.execute_script("""
            if (!window.__automate_js_errors) {
                window.__automate_js_errors = [];
                window.addEventListener('error', function(e) {
                    window.__automate_js_errors.push({
                        type: 'error', message: e.message, filename: e.filename,
                        lineno: e.lineno, colno: e.colno, timestamp: Date.now()
                    });
                });
                window.addEventListener('unhandledrejection', function(e) {
                    window.__automate_js_errors.push({
                        type: 'unhandled_rejection', reason: String(e.reason), timestamp: Date.now()
                    });
                });
            }
        """)
        return {"success": True}

    # ==== Canvas data ====
    elif action == "get_canvas_data":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        data = browser.execute_script(
            "return arguments[0].toDataURL(arguments[1] || 'image/png');",
            el,
            cmd.get("format", "image/png"),
        )
        return {
            "success": True,
            "data_url": data[:200] + "...",
            "data_length": len(data),
        }

    # ==== Emulation ====
    elif action == "emulate_device":
        metrics = {
            "width": cmd.get("width", 375),
            "height": cmd.get("height", 812),
            "deviceScaleFactor": cmd.get("scale", 3),
            "mobile": cmd.get("mobile", True),
        }
        browser.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", metrics)
        if cmd.get("user_agent"):
            browser.execute_cdp_cmd(
                "Emulation.setUserAgentOverride",
                {"userAgent": cmd["user_agent"]},
            )
        return {"success": True}

    # ==== Close ====
    elif action == "close":
        browser.quit()
        if display:
            display.stop()
        return {"success": True}

    else:
        return {"success": False, "error": f"Unknown action: {action}"}


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    start()
    print("READY", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd_data = json.loads(line)
            result = handle_command(cmd_data)
            print(json.dumps(result), flush=True)

            if cmd_data.get("action") == "close":
                sys.exit(0)
        except Exception as e:
            print(
                json.dumps(
                    {
                        "success": False,
                        "error": str(e),
                        "traceback": traceback.format_exc(),
                    }
                ),
                flush=True,
            )
