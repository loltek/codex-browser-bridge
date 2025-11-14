# Codex Browser Bridge

Codex Browser Bridge lets an OpenAI Codex CLI session control a real browser tab.

## Usage

1. **User side (browser):** Load the extension, open a tab, click the popup, and send the displayed `run curl ...session_key=XYZ` command to Codex.

## Troubleshooting

- **Service worker inactive:** The extension now keeps a `chrome.runtime.connect` port with periodic pings, but if you still see “worker inactive”, re-open the popup or reload the extension. (It seems to happen randomly despite best efforts to avoid it. Don't know why :( )


## Tech Stack

1. **Server (`server/`)** – a lightweight PHP API (`api3.php`) backed by SQLite that stores sessions, commands, and responses.

2. **Browser extension (`extension/`)** – a Chrome MV3 service worker that polls the server, performs trusted interactions (clicks, keyboard input, screenshots, script execution), and reports the results.

Together they enable Codex to request a human to load the extension, grant access on any tab, and then send commands with `curl` while polling for responses.

## Server

- **Tech stack:** PHP 8+, SQLite. Configuration lives in `server/src/www/api3.php`, while the `db.db3` file lives one directory above `src/www` to keep it out of the web root.
- **Endpoints:**
  - `task=create_session` – returns a random session key.
  - `task=<command>` (`execute_javascript`, `click_on_element`, `mouse_click_position`, `take_screenshot`, `keyboard_input`) – stores a command payload for the extension to pick up. Requests must be `multipart/form-data`.
  - `task=fetch_command` – polled by the extension.
  - `task=send_response` – extension posts execution results.
  - `task=fetch_response` – Codex polls to read the results (JSON for text, base64 data URLs for screenshots).
  - `task=session_instructions` (or no task) – returns human-readable instructions plus helper URLs.
  
## Extension

- **Location:** `extension/src/`

- **Background worker:** Polls `fetch_command`, executes trusted actions via the debugger API, and posts results to `send_response`. Keep-alive ports plus periodic pings keep the MV3 worker awake while a session is active.

## Contributing

- Open to issues, PRs, thanks for the interest 👍


## TODO

- Server: move to a WebSocket design so commands/responses land instantly instead of 1-second polling behind nginx.
- Server+Client: support self-hosting (privacy, security, speed~)
- Client: expose the bridge via an MCP server so Codex doesn't need to shell out to curl for every command.
- Funding/donation options


