# Browser Bridge

A Chrome extension plus a local MCP server that lets AI agents (Antigravity, Claude Code, or any other) control your real, logged-in Chrome. You can think of it as an open source alternative to Claude for Chrome, built a slightly different way.

- **Everything stays local.** Extension ↔ localhost WebSocket ↔ MCP server, no third-party relay, no accounts.
- **Any MCP client can drive it**, not just one product.
- **The codebase is deliberately small**: two files. The extension is one background script acting as a thin relay into Chrome; the MCP server is one file holding all the logic, talking to the extension over the local WebSocket.
- **The tool names and input shapes are kept consistent with Claude for Chrome's.** The implementation is independent.

Tools that are features of the Claude product rather than browser primitives are left out: image/file upload, GIF recording, plan approval, shortcuts, window resizing. Also not replicated yet: Claude for Chrome's guardrails (site permissions, blocked categories, confirmation prompts) - see Known gaps.

## How it works

- `extension/` - Manifest V3, thin relay. Connects to `ws://127.0.0.1:17333`, forwards Chrome DevTools Protocol (CDP) commands to tabs through `chrome.debugger`, buffers console/network events per tab, and answers JavaScript dialogs the agent triggers. Pings every 20s to keep the service worker alive, retries every 30s via `chrome.alarms` when the server is not running.
- `server/` - Node MCP server over stdio that also hosts the WebSocket. All logic lives here, so most changes need no extension reload. Tools: `tabs_context`, `tabs_create`, `tabs_close`, `navigate`, `computer`, `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `read_console_messages`, `read_network_requests`.

Design choices:

- **`chrome.debugger` over content scripts.** Trusted input events, accessibility tree, screenshots, works regardless of the page's Content Security Policy. Cost: the "started debugging this browser" bar while attached.
- **WebSocket over native messaging.** Two-step install (add extension, run one command). Native messaging needs a per-OS host manifest.
- **Refs.** `read_page` and `find` return `ref_N` ids mapped to CDP `backendDOMNodeId`s per tab; `computer` clicks and `form_input` resolve them to coordinates or nodes. Refs reset on navigation. `find` is heuristic text matching over the accessibility tree, not an LLM call.
- **Multiple sessions.** This is a stdio MCP server: each client launches its own copy as a child process and talks to it over stdin/stdout - that's how the stdio transport works, so three agent sessions means three server processes. (The alternative, an HTTP MCP server, would be one shared process on a port, but then you'd have to run and manage that process yourself; with stdio the client handles start and stop.) The catch is that the extension holds a single WebSocket connection, so the server copies coordinate: the first one to start owns port 17333 and the extension, later ones join it as peers and get relayed, and if the owner exits, a peer takes over within about 2s. Without this, a second session would fail with "port in use".
- **Native UI never opens.** Synthetic input can open operating-system UI but can never close it, and on macOS an open native menu stalls tab closing for the whole browser. So a right click reaches the page (page-drawn context menus work) while Chrome's own menu is suppressed, `<select>` dropdowns are refused with a pointer to `form_input`, and file pickers are intercepted for the duration of a click or keypress.
- **Dialogs never freeze the tab.** An `alert`/`confirm`/`prompt`/"Leave site?" blocks the page and every command behind it. Ones the agent causes are answered at once (cancelled, or accepted for `navigate` with `force` and for `tabs_close`) and reported in the next tool result, along with how to answer differently. A dialog that opens while only a person is using the tab is left for them.
- **Screenshots match click coordinates.** Always one image pixel per CSS pixel, whatever the display scaling, so a point read off a screenshot is a valid click target.
- **Multiple Chrome profiles.** Each profile with the extension connects; the most recently connected one is active, and clicking the extension's icon in another profile switches to it.
- **Origin check instead of a token.** The manifest has a fixed `key`, so the unpacked extension ID is stable, and the server only accepts connections whose `Origin` header is that `chrome-extension://` ID - browsers set that header themselves, so web pages and other extensions cannot forge it. A local process can, so this is not a defense against malware already on the machine.
- **No tab scoping, on purpose for now.** The agent gets every open tab. Per-tab sharing existed early on and was dropped to keep things simple; worth revisiting.

Known gaps: no per-origin allowlist or confirmations yet. `read_page` and `find` don't see inside iframes (coordinate clicks do reach them). Sessions share tabs with no locking between them.

## Setup

1. `cd server && npm install`
2. In Chrome, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick the `extension/` folder. The extension only reaches tabs in the Chrome profile it is loaded in.
3. Register the server with your MCP client, e.g. `claude mcp add -s user browser-bridge -- node <repo>/server/index.js`

### Updating

Loading the extension is the only time you need `chrome://extensions`. After that, run these from `server/`:

- `npm run reload` - reload the extension from disk once, e.g. after a `git pull`
- `npm run dev` - reload it on every change to `extension/`, for development
- `npm test` - the e2e suite reloads it before it runs

The one exception: if an edit breaks the extension so badly that it can't start, it can't reload itself either, and needs one click on the reload button. Server changes never need any of this: each new client session starts the current code.

## Testing

`npm test` in `server/` runs two suites. `test:relay` needs no browser: fake extensions on a separate port exercise the connection layer (relay, takeover, disconnects, origin check, profiles). `test:e2e` drives all 12 tools through the real extension and Chrome against an instrumented local page, asserting effects by reading page state back; it reloads the extension from disk first. [TESTING.md](TESTING.md) has what is covered and the log of what testing found.

