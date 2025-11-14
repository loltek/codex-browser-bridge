# Codex Browser Bridge

Codex Browser Bridge lets an OpenAI Codex CLI session control a real browser tab.

## Installation

first clone:
```
git clone 'https://github.com/loltek/codex-browser-bridge.git' --depth 1
```
then in chrome go to `chrome://extensions/` and make sure `Developer Mode` is enabled,
then press `Load unpacked extension`,navigate to codex-browser-bridge/extension/src and pick it:
![install image illustration](/extension/images/install-illustration.png
 "install title")



## Usage

it's trivial, find the extension box and press "give access to codex" and follow the instructions.

![usage illustration](/extension/images/usage-illustration.png "usage illustration")

todo write a better usage section. 

## Troubleshooting

- **Service worker inactive:** The extension now keeps a `chrome.runtime.connect` port with periodic pings, but if you still see “worker inactive”, re-open the popup or reload the extension. (It seems to happen randomly despite best efforts to avoid it. Don't know why :( )


## Tech Stack

1. **Server (`server/`)** – a lightweight PHP API (`api3.php`) backed by SQLite that stores sessions, commands, and responses.

2. **Browser extension (`extension/`)** – a Chrome MV3 service worker that polls the server, performs trusted interactions (clicks, keyboard input, screenshots, script execution), and reports the results.

Together they enable Codex to request a human to load the extension, grant access on any tab, and then send commands with `curl` while polling for responses.


## Contributing

- Open to issues, PRs, thanks for the interest 👍


## TODO

- Server: move to a WebSocket design so commands/responses land instantly instead of 1-second polling behind nginx.
- Server+Client: support self-hosting (privacy, security, speed~)
- Client: expose the bridge via an MCP server so Codex doesn't need to shell out to curl for every command.
- Funding/donation options



## Permissions

- activeTab: needed so the extension can run trusted clicks/keyboard input and capture screenshots in the currently active tab when the user presses "Enable Codex Access".
- scripting/tabs/debugger: used to inject helper scripts and attach Chrome's debugger for trusted input.
- storage: persists session keys between service-worker restarts.
