#!/usr/bin/env python3
"""
AutoMate Browser Engine - Persistent undetected Chrome browser process.
Uses: undetected-chromedriver + selenium-stealth + Xvfb
Communicates via stdin/stdout JSON lines.
"""

import sys
import json
import os
import time
import traceback

import undetected_chromedriver as uc
from selenium_stealth import stealth
from pyvirtualdisplay import Display
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys
from selenium.common.exceptions import (
    TimeoutException,
    NoSuchElementException,
    WebDriverException,
    StaleElementReferenceException,
)

browser = None
display = None


def start():
    global browser, display
    display = Display(visible=False, size=(1920, 1080))
    display.start()

    opts = uc.ChromeOptions()
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1920,1080")
    opts.add_argument("--start-maximized")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--disable-infobars")
    opts.add_argument("--disable-browser-side-navigation")
    opts.add_argument("--disable-extensions")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--disable-features=VizDisplayCompositor")
    prefs = {
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
        "profile.default_content_setting_values.notifications": 2,
    }
    opts.add_experimental_option("prefs", prefs)

    chrome_paths = [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    for p in chrome_paths:
        if os.path.exists(p):
            opts.binary_location = p
            break

    driver_paths = [
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

    stealth(
        browser,
        languages=["en-US", "en"],
        vendor="Google Inc.",
        platform="Win32",
        webgl_vendor="Intel Inc.",
        renderer="Intel Iris OpenGL Engine",
        fix_hairline=True,
    )

    try:
        browser.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {
                "source": """
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                const oq = window.navigator.permissions.query;
                window.navigator.permissions.query = (p) => (
                    p.name === 'notifications' ?
                    Promise.resolve({state: Notification.permission}) : oq(p)
                );
                Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
                window.chrome = {runtime: {}};
            """
            },
        )
    except Exception:
        pass

    browser.set_window_size(1920, 1080)
    return {"success": True}


def by_str(s):
    m = {
        "css": By.CSS_SELECTOR,
        "xpath": By.XPATH,
        "id": By.ID,
        "class": By.CLASS_NAME,
        "tag": By.TAG_NAME,
        "name": By.NAME,
    }
    return m.get(s, By.CSS_SELECTOR)


def el_dict(el):
    try:
        return {
            "tag": el.tag_name,
            "text": el.text[:500],
            "displayed": el.is_displayed(),
            "enabled": el.is_enabled(),
            "attrs": {
                "id": el.get_attribute("id"),
                "class": el.get_attribute("class"),
                "name": el.get_attribute("name"),
                "href": el.get_attribute("href"),
                "src": el.get_attribute("src"),
                "value": el.get_attribute("value"),
                "type": el.get_attribute("type"),
                "placeholder": el.get_attribute("placeholder"),
            },
        }
    except StaleElementReferenceException:
        return {"error": "stale"}


KEY_MAP = {
    "enter": Keys.ENTER,
    "tab": Keys.TAB,
    "escape": Keys.ESCAPE,
    "backspace": Keys.BACKSPACE,
    "delete": Keys.DELETE,
    "space": Keys.SPACE,
    "up": Keys.ARROW_UP,
    "down": Keys.ARROW_DOWN,
    "left": Keys.ARROW_LEFT,
    "right": Keys.ARROW_RIGHT,
}


def handle_command(cmd):
    global browser, display
    action = cmd.get("action")

    if action == "navigate":
        browser.get(cmd["url"])
        return {"success": True, "title": browser.title, "url": browser.current_url}

    elif action == "screenshot":
        data = browser.get_screenshot_as_base64()
        if cmd.get("save_path"):
            browser.save_screenshot(cmd["save_path"])
            return {"success": True, "path": cmd["save_path"]}
        else:
            return {
                "success": True,
                "data_length": len(data),
                "data_preview": data[:200] + "...",
            }

    elif action == "screenshot_full":
        data = browser.get_screenshot_as_base64()
        return {"success": True, "data": data}

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
        try:
            json.dumps(r)
            return {"success": True, "result": r}
        except (TypeError, ValueError):
            return {"success": True, "result": str(r)}

    elif action == "wait_element":
        wait = WebDriverWait(browser, cmd.get("timeout", 10))
        conds = {
            "present": EC.presence_of_element_located,
            "visible": EC.visibility_of_element_located,
            "clickable": EC.element_to_be_clickable,
        }
        c = conds.get(cmd.get("condition", "present"), EC.presence_of_element_located)
        el = wait.until(c((by_str(cmd.get("by", "css")), cmd["selector"])))
        return {"success": True, "element": el_dict(el)}

    elif action == "back":
        browser.back()
        return {"success": True, "url": browser.current_url, "title": browser.title}

    elif action == "forward":
        browser.forward()
        return {"success": True, "url": browser.current_url, "title": browser.title}

    elif action == "refresh":
        browser.refresh()
        return {"success": True, "url": browser.current_url, "title": browser.title}

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

    elif action == "hover":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        ActionChains(browser).move_to_element(el).perform()
        return {"success": True}

    elif action == "scroll_to":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        browser.execute_script("arguments[0].scrollIntoView(true);", el)
        return {"success": True}

    elif action == "submit":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        el.submit()
        return {"success": True, "url": browser.current_url}

    elif action == "cookies":
        return {"success": True, "cookies": browser.get_cookies()}

    elif action == "set_cookie":
        cookie = {"name": cmd["name"], "value": cmd["value"]}
        if cmd.get("domain"):
            cookie["domain"] = cmd["domain"]
        browser.add_cookie(cookie)
        return {"success": True}

    elif action == "delete_cookies":
        browser.delete_all_cookies()
        return {"success": True}

    elif action == "find_links":
        els = browser.find_elements(By.TAG_NAME, "a")[: cmd.get("limit", 20)]
        links = [
            {"text": e.text.strip() or "[no text]", "href": e.get_attribute("href")}
            for e in els
            if e.get_attribute("href")
        ]
        return {"success": True, "count": len(links), "links": links}

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
                    "inputs": [
                        {
                            "tag": inp.tag_name,
                            "type": inp.get_attribute("type"),
                            "name": inp.get_attribute("name"),
                            "id": inp.get_attribute("id"),
                        }
                        for inp in inputs
                    ],
                }
            )
        return {"success": True, "forms": fdata}

    elif action == "press_key":
        k = KEY_MAP.get(cmd["key"].lower(), cmd["key"])
        if cmd.get("selector"):
            el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
            el.send_keys(k)
        else:
            ActionChains(browser).send_keys(k).perform()
        return {"success": True}

    elif action == "select":
        from selenium.webdriver.support.ui import Select

        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        sel = Select(el)
        if cmd.get("value"):
            sel.select_by_value(cmd["value"])
        elif cmd.get("text"):
            sel.select_by_visible_text(cmd["text"])
        elif cmd.get("index") is not None:
            sel.select_by_index(cmd["index"])
        return {"success": True}

    elif action == "tabs":
        return {
            "success": True,
            "current": browser.current_window_handle,
            "handles": browser.window_handles,
        }

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

    elif action == "fill_form":
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

    elif action == "switch_frame":
        if cmd.get("selector"):
            el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
            browser.switch_to.frame(el)
        elif cmd.get("index") is not None:
            browser.switch_to.frame(cmd["index"])
        else:
            browser.switch_to.default_content()
        return {"success": True}

    elif action == "alert":
        alert = browser.switch_to.alert
        if cmd.get("accept", True):
            alert.accept()
        else:
            alert.dismiss()
        return {"success": True}

    elif action == "upload":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        el.send_keys(cmd["file_path"])
        return {"success": True}

    elif action == "wait":
        time.sleep(cmd.get("seconds", 1))
        return {"success": True}

    elif action == "close":
        browser.quit()
        if display:
            display.stop()
        return {"success": True}

    elif action == "get_performance":
        perf = browser.execute_script(
            "return window.performance.timing.toJSON ? window.performance.timing.toJSON() : {}"
        )
        return {"success": True, "performance": perf}

    elif action == "local_storage_get":
        data = browser.execute_script(
            "var s={}; for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);s[k]=localStorage.getItem(k);} return s;"
        )
        return {"success": True, "data": data}

    elif action == "local_storage_set":
        browser.execute_script(
            f"localStorage.setItem('{cmd['key']}', '{cmd['value']}');"
        )
        return {"success": True}

    elif action == "console_logs":
        logs = browser.get_log(cmd.get("log_type", "browser"))
        return {
            "success": True,
            "logs": [{"level": l["level"], "message": l["message"]} for l in logs[:50]],
        }

    elif action == "highlight":
        el = browser.find_element(by_str(cmd.get("by", "css")), cmd["selector"])
        browser.execute_script(
            "arguments[0].style.outline='3px solid red';arguments[0].style.outlineOffset='2px';",
            el,
        )
        return {"success": True}

    elif action == "get_images":
        imgs = browser.find_elements(By.TAG_NAME, "img")[: cmd.get("limit", 20)]
        return {
            "success": True,
            "images": [
                {
                    "src": i.get_attribute("src"),
                    "alt": i.get_attribute("alt"),
                    "width": i.size["width"],
                    "height": i.size["height"],
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
        else:
            found = query in body_text
        return {"success": True, "found": found, "text_length": len(body_text)}

    elif action == "save_html":
        with open(cmd["path"], "w") as f:
            f.write(browser.page_source)
        return {"success": True, "path": cmd["path"]}

    elif action == "google_search":
        browser.get(f"https://www.google.com/search?q={cmd['query']}")
        time.sleep(1)
        return {"success": True, "url": browser.current_url, "title": browser.title}

    elif action == "duckduckgo_search":
        browser.get(f"https://duckduckgo.com/?q={cmd['query']}")
        time.sleep(1)
        return {"success": True, "url": browser.current_url, "title": browser.title}

    else:
        return {"success": False, "error": f"Unknown action: {action}"}


if __name__ == "__main__":
    # Start browser immediately
    start()
    print("READY", flush=True)

    # Command loop
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            result = handle_command(cmd)
            print(json.dumps(result), flush=True)

            # Exit after close
            if cmd.get("action") == "close":
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
