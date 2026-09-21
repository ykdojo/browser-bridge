# Browser Bridge

A Chrome extension plus a local MCP server that lets AI agents (Claude Code or any other) control your real, logged-in Chrome. Think of it as an open source alternative to Claude for Chrome, built a slightly different way: everything stays local (extension ↔ localhost WebSocket ↔ MCP server, no third-party relay), it works with any MCP client rather than one product, and it's a deliberately small codebase - one background script and one server file. The tool names and input shapes are kept consistent with Claude for Chrome's, since models are tuned for that surface. Not affiliated with Anthropic.

Started 2026-09-19 as CDP experiments (notes below); the extension + server under "Browser Bridge" is the main artifact. MIT licensed.

## How this relates to Claude for Chrome

**Same interface, independent implementation.** The 12 tools use the same names, parameters and enums as Claude for Chrome's browser tools (`computer` with its action enum, `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `read_console_messages`, `read_network_requests`, `navigate`, and the tabs tools). That's deliberate: models are trained against that tool surface, so matching the shapes gets better tool use for free. Everything behind the shapes is written from scratch on raw CDP - no code, prompts or assets from the extension are used. Some implementations are intentionally simpler: `find` is heuristic text matching over the accessibility tree rather than an LLM call, and refs come straight from CDP backend node IDs.

**What's different by design:**

- **Local and client-agnostic.** Claude for Chrome is a product: a sidebar in Chrome that talks to claude.ai and works only with Claude. Browser Bridge is plumbing: extension → localhost WebSocket → MCP server on stdio, no accounts, no remote calls, and any MCP client can drive it - Claude Code, another agent, or a script.
- **Small on purpose.** One background script, one server file. Easy to read end to end before trusting it with a logged-in browser.
- **Multi-session.** Several agent sessions share the one extension connection through the peer relay.

**What's deliberately not implemented:**

- **Product-coupled tools**: `upload_image` (uploads images from the Claude conversation's own image store), `file_upload`, `gif_creator`, `resize_window`, `update_plan` (Claude's plan-approval flow), `shortcuts_*`. They're features of the Claude product, not browser primitives; an MCP client brings its own equivalents where it needs them.
- **Guardrails.** Claude for Chrome ships site permissions, blocked categories and confirmation prompts. Browser Bridge has none of that yet: the agent gets every tab. That's the biggest gap to close before recommending this to anyone else (see Known gaps).

## The goal

Give an agent access to my logged-in browser, not a fresh logged-out Playwright one. I was considering building my own version of Claude for Chrome.

## What exists (checked Sep 2026)

- **chrome-devtools-mcp `--autoConnect`** (Google, official) - attaches to the running Chrome, no extension. This is what I tried first.
- **Playwright MCP `--extension`** (Microsoft, official) - "Playwright MCP Bridge" extension, reuses logged-in tabs.
- **Claude for Chrome** - extension + native messaging host + `chrome.debugger`.
- Open source extension + MCP projects with the same architecture I had in mind: real-browser-mcp, agent360dk/browser-mcp, chrome-use-mcp, blueprint-mcp, Browser MCP, hangwin/mcp-chrome. Not evaluated in depth.

## How autoConnect works

1. Turn on the toggle at `chrome://inspect/#remote-debugging` (Chrome 144+). The running Chrome starts a debugging server for the real profile. No launch flags.
2. Chrome writes `DevToolsActivePort` into the user data dir (`~/Library/Application Support/Google/Chrome/` on macOS). Line 1 is the port, line 2 is the WebSocket path.
3. A client connects to `ws://127.0.0.1:<port><path>`. chrome-devtools-mcp does this with Puppeteer (see `src/browser.ts` in its repo).
4. Chrome shows an "Allow remote debugging?" dialog, plus an automation banner while a session is active.
5. After Allow, the client has full CDP access to every tab and window of that profile.

Any CDP client works, not just the MCP server. The scripts here talk to it directly with Bun's built-in WebSocket.

## Limitations

- **The Allow dialog fires on every new connection, by design.** Request to persist it was closed as not planned (chrome-devtools-mcp #825). Maintainers recommend a dedicated profile for unattended use.
- **Fix for the dialog: hold one connection open.** One script run per action means one popup per action. `scripts/daemon.ts` keeps a single WebSocket alive and takes commands over a unix socket, so there is one popup per daemon start.
- **All-or-nothing access.** Every logged-in tab, cookies, storage, arbitrary JS. No per-tab or per-site scoping, no confirmations. Prompt injection defense is on me. Close sensitive tabs first, or use a dedicated profile for tasks that don't need real logins.
- Only one tool should be connected at a time. Parallel agents each trigger their own dialog.
- Users with hundreds of tabs report hangs and memory blowups with chrome-devtools-mcp (#1921, partly fixed).
- Connects to the default profile only.
- The HTTP discovery endpoints (`/json/list` etc.) reportedly return 404 on the toggle route, so use the WebSocket path from `DevToolsActivePort`.
- Turning access off: flip the toggle off, or click Deny, or kill the client.

## When an extension is still the better build

An extension using `chrome.debugger` + a native messaging host avoids the Allow dialog and lets me enforce tab and origin scoping in code. Costs: a "started debugging this browser" infobar, a subset of CDP domains, one debugger client per tab, MV3 service worker reconnect logic. Native messaging is more robust than WebSocket for the bridge (keeps the service worker alive, no open localhost port). Loading it unpacked avoids Web Store review. WebMCP (site opt-in) and Gemini auto browse (closed to third parties) don't make this obsolete.

## Browser Bridge (my own extension + MCP server)

Two pieces. Chrome extensions can only connect out, never be called from outside, so a local process is unavoidable. That process is the MCP server itself.

- `extension/` - MV3, thin relay. Connects to `ws://127.0.0.1:17333`, forwards CDP commands to tabs through `chrome.debugger`. Pings every 20s to keep the service worker alive, retries every 30s via `chrome.alarms` when the server is not running.
- `server/` - Node MCP server over stdio that also hosts the WebSocket. All logic lives here, so most changes need no extension reload. Tools: `tabs_context`, `tabs_create`, `tabs_close`, `navigate`, `computer`, `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `read_console_messages`, `read_network_requests`.

Design choices:

- **`chrome.debugger` over content scripts.** Trusted input events, accessibility tree, screenshots, works regardless of page CSP. Cost: the "started debugging this browser" bar while attached.
- **WebSocket over native messaging.** Two-step install for other people later (add extension, run one command). Native messaging needs a per-OS host manifest.
- **No tab scoping, on purpose for now.** The agent gets every open tab. I built per-tab sharing first (click the icon to share a tab), then a share-all toggle, then dropped both to keep it simple. Worth revisiting before other people install it.
- **Multiple sessions.** The first server to start owns port 17333 and the extension connection. Later servers join it as peers (no Origin + `x-bridge-peer` header) and get relayed. If the primary exits, a peer takes over the port and the extension reconnects within about 2s.
- **Origin check instead of a token.** The manifest has a fixed `key`, so the unpacked extension ID is always `epjnmpnkphfbonblfmfeokijfhmjcfne`. The server only accepts WebSocket upgrades with that `chrome-extension://` Origin, which web pages and other extensions cannot forge. A local process can, so this is not a defense against malware already on the machine. The private key is in `.keys/` (gitignored).
- **Tool shapes match Claude for Chrome.** Models are tuned for that tool surface, so the names, parameters and enums mirror it: one `computer` tool with an `action` enum (clicks, type, key, scroll, screenshot, zoom, hover, drag, wait) instead of separate click/type tools, `read_page`/`find` handing out string refs like `ref_3`, and every tool taking `tabId`. Product-specific tools (image/file upload, GIF recording, plans, shortcuts) are deliberately left out. Implementations are our own, written against the shapes.
- **Refs.** `read_page` and `find` return `ref_N` ids mapped to CDP `backendDOMNodeId`s per tab; `computer` clicks and `form_input` resolve them to coordinates or nodes with `DOM.getBoxModel`/`DOM.resolveNode`. Refs reset on navigation.
- **Console/network capture lives in the extension.** `chrome.debugger` events are buffered per tab (capped at 500/1000 entries) from the moment a tab is first attached; buffers reset when the tab changes site. `find` is heuristic text matching over the accessibility tree, not an LLM call.

Known gaps: no per-origin allowlist or confirmations yet. No iframe handling. Sessions share tabs with no locking between them.

Setup: `cd server && npm install`, then `chrome://extensions` - Developer mode - Load unpacked - pick `extension/`. Registered in Claude Code with `claude mcp add -s user browser-bridge -- node <repo>/server/index.js`.

## Testing

`npm test` in `server/` runs the end-to-end suite (`test/e2e.mjs`): it spawns the server, serves an instrumented local page, and drives all 12 tools through the extension against the real Chrome, asserting effects by reading page state back - 33 checks covering refs and coordinates, clicks with modifiers, keyboard, forms, scrolling, screenshots, console/network capture and navigation. Chrome must be running with the extension loaded. [TESTING.md](TESTING.md) is the running log of what was tested when, manual passes included.

## Scripts

All run with Bun (`~/.bun/bin/bun run ...`).

- `scripts/tabs.ts` - list open tabs. One connection, one popup.
- `scripts/cdp.ts <urlSubstring> <jsFile>` - evaluate a JS file in the matching tab. One popup per run.
- `scripts/daemon.ts` - persistent connection. Run it from a directory with a short path (unix socket paths max out around 104 chars; a long scratchpad path failed with ENAMETOOLONG). Then:
  - `curl --unix-socket cdp.sock http://x/tabs`
  - `curl --unix-socket cdp.sock -X POST --data-binary @file.js "http://x/eval?tab=<urlSubstring>"`
  - `curl --unix-socket cdp.sock -X POST -d '{"method":"Target.createTarget","params":{"url":"..."}}' http://x/cdp`

## First real use: Build Day demo

At the Vancouver Claude Code Build Day (2026-09-19) I had Claude read the Luma guest list from my logged-in manage tab and build a visualization of the 30 attendees, then open it in a new tab through the same connection.

- Reading `document.body.innerText` worked but only covered the loaded rows.
- Better: find the API the page already calls (`performance.getEntriesByType('resource')`), then `fetch` it from inside the page with `credentials: "include"`. That returned all 258 guests with registration answers.
- Hitting an internal API like this is fine as a one-off read with my own host session. It is undocumented, can change without notice, and heavy automated use could go against the site's terms. For anything recurring, use the official Luma API with a key.
- Guest data and the demo page are gitignored. No emails or phone numbers went into the visualization.

## Side quest: broken Node

Homebrew's Node 21.7.1 died with a missing `libicui18n.74.dylib` (icu4c got upgraded underneath it). `brew reinstall node` failed with "no bottle available" since this macOS version is Tier 3 for Homebrew. Fix: official Node LTS tarball (v24.21.0) extracted to `~/.local/`, with `node`, `npm`, `npx`, `corepack` symlinked into `~/.local/bin`, which is ahead of Homebrew on PATH. This is likely also why the Playwright MCP server was failing to connect (not confirmed).
