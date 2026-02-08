# Discord MCP Server

A compact, practical MCP (Minimal Control Plane) server for automating Discord's web UI using Selenium + Firefox (geckodriver). This MCP exposes a set of high-level tools for starting/stopping browser sessions, authenticating (including handling 2FA), navigating servers/channels and DMs, reading and sending messages, handling basic notifications, and limited voice-channel interactions (note: headless mode limits voice functionality).

---

## Features

- Login with 2FA (TOTP support and manual entry flows)
- Channel & server navigation (list and select servers/channels)
- Message reading and sending (including replies and reactions)
- Notifications and mention checks
- Direct Messages (DMs) navigation and messaging
- Voice channel join/leave and basic mute/unmute control (limited in headless environments)
- Presence/status setting
- Search within the UI
- Automation helpers (execute JS, wait for elements, scrolling, screenshots)

---

## Prerequisites

- Python 3.8 or newer
- Firefox browser (compatible with chosen geckodriver)
- geckodriver (in PATH or configured explicitly)
- selenium and any project-specific Python dependencies (see requirements.txt)

Notes:
- On many Linux distributions install Firefox and geckodriver from your package manager or download the official geckodriver binary and make it executable and available on PATH.
- Keep tokens, credentials, and 2FA secrets out of source control; prefer environment variables or secrets managers.

---

## Installation

1. Clone this project repository (if not already present):

   git clone <repo-url>
   cd <repo>/mcps/discord

2. Create and activate a virtual environment and install dependencies:

   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt

3. Ensure Firefox and geckodriver are installed and compatible.
4. Create a configuration file (see below) or configure with environment variables.

---

## Configuration (MCP config example)

Below is a canonical example configuration in YAML format. Adapt field names or locations to your project's MCP config scheme.

```yaml
discord_mcp:
  geckodriver_path: "/usr/bin/geckodriver"
  firefox_binary: "/usr/bin/firefox"       # optional
  headless: true
  default_timeout: 15                       # seconds (element waits, timeouts)
  viewport:
    width: 1280
    height: 800

  # Optional credentials section - recommend using env vars instead
  auth:
    username: "%DISCORD_USER%"
    password: "%DISCORD_PASSWORD%"
    totp_secret: "%DISCORD_TOTP_SECRET%"  # optional, base32 for automatic TOTP

  # Alternative: token-based login (store securely and do not commit)
  token: "%DISCORD_TOKEN%"
```

Security notes:
- If both token and username/password are present, token login may take precedence if configured.
- Keep tokens and 2FA secrets secured (environment variables, key vault, etc.).

---

## Available Tools (grouped)

These are the high-level operations provided by the Discord MCP. Each tool is a convenience wrapper around Selenium flows.

Browser Session
- start_discord_browser(options): Start a Firefox browser session configured for Discord (headless optional). Returns a session handle.
- stop_discord_browser(session): Stop/cleanup the browser session.
- get_discord_status(session): Query the current browser/session status (current URL, logged-in state, last error).

Authentication
- discord_login(session, username, password): Log in using credentials; will follow the login UI.
- discord_submit_2fa(session, code): Submit a 2FA/TOTP code when a 2FA prompt appears.
- discord_login_with_token(session, token): Log in using a Discord token (bypass UI flows).
- discord_logout(session): Log out of the current session.

Navigation
- get_servers(session): List available servers (names + IDs) shown in the sidebar.
- select_server(session, server_id_or_name): Select a server.
- get_channels(session, server_id_or_name): Get channels for a server.
- select_channel(session, channel_id_or_name): Navigate to a channel.
- navigate_to_dms(session): Navigate to the Direct Messages/DMs view.
- get_dm_conversations(session): List recent DM conversations.
- open_dm(session, user_id_or_name): Open a DM conversation with a user.

Messages
- get_messages(session, channel_id_or_name, limit=50): Retrieve messages (author, content, message_id, timestamp).
- send_message(session, channel_id_or_name, text, attachments=None): Send a text message to a channel or DM.
- send_message_with_js(session, channel_id_or_name, javascript_snippet): Send content using JS shortcuts when necessary.
- reply_to_message(session, channel_id_or_name, message_id, text): Reply to a specific message.
- add_reaction(session, channel_id_or_name, message_id, emoji): Add a reaction emoji to a message.

Notifications
- get_notifications(session): Fetch the notifications/alerts available in the UI.
- check_mentions(session, user_identifier=None): Return messages where the logged-in user was mentioned.

Voice
- join_voice_channel(session, channel_id_or_name): Join a voice channel (headless limitations apply).
- leave_voice_channel(session): Leave the current voice channel.
- mute_unmute(session, muted=True/False): Toggle microphone mute state (true/false).

Utilities
- take_discord_screenshot(session, path=None, full_page=False): Take and optionally save a screenshot.
- get_current_page_info(session): Return page metadata (title, URL, active channel/server).
- scroll_messages(session, amount_or_selector): Scroll message history (pagination/older messages).
- search_discord(session, query): Use the UI search to find messages or members.
- get_user_profile(session, user_id_or_name): Open and fetch a user's profile card details.
- set_status(session, status_text, presence_type="online"|"idle"|"dnd"): Update presence/status.
- execute_discord_js(session, javascript_snippet): Run custom JS in the page context—use with caution.
- wait_for_element(session, selector, timeout): Wait for a UI element to appear.

---

## Usage Examples

Below are example flows using the MCP's high-level functions. Replace these with actual imports/calls from your project's MCP client.

Basic start + login (manual 2FA):

```python
session = start_discord_browser(headless=True, geckodriver_path="/usr/bin/geckodriver")
discord_login(session, username="me@example.com", password="supersecret")
# Wait for 2FA prompt and submit
code = input("Enter 2FA code: ")
discord_submit_2fa(session, code)
# Select server and channel
select_server(session, "My Server")
select_channel(session, "general")
# Send a message
send_message(session, "general", "Hello from MCP!")
# Stop when done
stop_discord_browser(session)
```

Login with token (bypass 2FA UI):

```python
session = start_discord_browser(headless=True)
discord_login_with_token(session, os.environ["DISCORD_TOKEN"])
select_server(session, "My Server")
select_channel(session, "announcements")
send_message(session, "announcements", "Posting via token-based login")
```

Reading messages and replying:

```python
msgs = get_messages(session, "general", limit=25)
for m in msgs:
    print(m["timestamp"], m["author"], m["content"])
# Reply to the first message
reply_to_message(session, "general", msgs[0]["message_id"], "Thanks for the update!")
```

DM example:

```python
navigate_to_dms(session)
open_dm(session, "friendusername#1234")
send_message(session, "friendusername#1234", "Hey! Got a sec?")
```

Screenshot & search example:

```python
take_discord_screenshot(session, "/tmp/discord_view.png")
results = search_discord(session, "deployment status")
```

Voice example (non-headless recommended):

```python
# Prefer running a non-headless browser if you need actual voice I/O
join_voice_channel(session, "Voice Channel")
# Mute microphone
mute_unmute(session, muted=True)
leave_voice_channel(session)
```

---

## Headless Mode Limitations & Notes

- Voice functionality is typically limited or unavailable in headless mode because audio devices and real-time media interfaces are not exposed. If your workflow needs stable voice input/output, run in headed mode on a machine with audio devices.
- Some browser dialogs, file upload flows, and media permission prompts behave differently in headless mode.
- UI layout or element selectors may change when Discord updates their web client. Expect occasional maintenance when Discord ships UI changes.

---

## Discord Terms of Service & Safety

- Automation that results in spam, scraping of private data, or abuse of Discord services can violate Discord's Terms of Service and Developer Policies. Use UI automation responsibly.
- For bot-style automation (message bots, events, webhooks), prefer the official Discord Bot API (discord.py, discord.js, etc.). Use this MCP primarily for automating user-interface flows that cannot be achieved with the official API or for personal workflows.
- Never commit or share tokens, passwords or 2FA secrets. Treat them as sensitive credentials.

---

## Troubleshooting

- geckodriver not found or version mismatch: ensure geckodriver is on PATH and compatible with installed Firefox.
- Login failures: confirm credentials and 2FA code. If using token login, ensure the token is valid and has not been revoked.
- Selectors failing after Discord UI update: inspect the web UI and update CSS/XPath selectors used by helper functions.

---

If you want any additional sections (example scripts, tests, CI configuration, or sample TOTP helper functions) added to this README, tell me what you'd like to see and I will expand it.
