# Browser Bridge

A Chrome extension plus a local MCP server that lets AI agents (Antigravity, Claude Code, or any other) control your real, logged-in Chrome. You can think of it as an open source alternative to Claude for Chrome, built a slightly different way.

- **Everything stays local.** Extension ↔ localhost WebSocket ↔ MCP server, no third-party relay, no accounts.
- **Any MCP client can drive it**, not just one product.
- **The codebase is deliberately small**: two files. The extension is one background script acting as a thin relay into Chrome; the MCP server is one file holding all the logic, talking to the extension over the local WebSocket.
- **The tool names and input shapes are kept consistent with Claude for Chrome's.** The implementation is independent.

Tools that are features of the Claude product rather than browser primitives are left out: image/file upload, GIF recording, plan approval, shortcuts, window resizing. Also not replicated yet: Claude for Chrome's guardrails (site permissions, blocked categories, confirmation prompts) - see Known gaps.

## How it works

- `extension/` - Manifest V3, thin relay. Connects to `ws://127.0.0.1:17333`, forwards Chrome DevTools Protocol (CDP) commands to tabs through `chrome.debugger`, and buffers console/network events per tab. Pings every 20s to keep the service worker alive, retries every 30s via `chrome.alarms` when the server is not running.
- `server/` - Node MCP server over stdio that also hosts the WebSocket. All logic lives here, so most changes need no extension reload. Tools: `tabs_context`, `tabs_create`, `tabs_close`, `navigate`, `computer`, `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `read_console_messages`, `read_network_requests`.

Design choices:

- **`chrome.debugger` over content scripts.** Trusted input events, accessibility tree, screenshots, works regardless of the page's Content Security Policy. Cost: the "started debugging this browser" bar while attached.
- **WebSocket over native messaging.** Two-step install (add extension, run one command). Native messaging needs a per-OS host manifest.
- **Refs.** `read_page` and `find` return `ref_N` ids mapped to CDP `backendDOMNodeId`s per tab; `computer` clicks and `form_input` resolve them to coordinates or nodes. Refs reset on navigation. `find` is heuristic text matching over the accessibility tree, not an LLM call.
- **Multiple sessions.** This is a stdio MCP server: each client launches its own copy as a child process and talks to it over stdin/stdout - that's how the stdio transport works, so three agent sessions means three server processes. (The alternative, an HTTP MCP server, would be one shared process on a port, but then you'd have to run and manage that process yourself; with stdio the client handles start and stop.) The catch is that the extension holds a single WebSocket connection, so the server copies coordinate: the first one to start owns port 17333 and the extension, later ones join it as peers and get relayed, and if the owner exits, a peer takes over within about 2s. Without this, a second session would fail with "port in use".
- **Origin check instead of a token.** The manifest has a fixed `key`, so the unpacked extension ID is stable, and the server only accepts connections whose `Origin` header is that `chrome-extension://` ID - browsers set that header themselves, so web pages and other extensions cannot forge it. A local process can, so this is not a defense against malware already on the machine.
- **No tab scoping, on purpose for now.** The agent gets every open tab. Per-tab sharing existed early on and was dropped to keep things simple; worth revisiting.

Known gaps: no per-origin allowlist or confirmations yet. No iframe handling. Sessions share tabs with no locking between them.

## Setup

`cd server && npm install`, then `chrome://extensions` - Developer mode - Load unpacked - pick `extension/`. Register with your MCP client, e.g. `claude mcp add -s user browser-bridge -- node <repo>/server/index.js`.

## Testing

`npm test` in `server/` runs the end-to-end suite: 33 checks driving all 12 tools through the extension against the real Chrome, asserting effects by reading page state back. Chrome must be running with the extension loaded. [TESTING.md](TESTING.md) is the running log, manual passes included.

