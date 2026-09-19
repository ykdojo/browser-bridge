# Chrome CDP access

Notes and scripts for letting AI agents (Claude Code or any other) control my real, logged-in Chrome. Started 2026-09-19.

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

## Chrome Bridge (my own extension + MCP server)

Two pieces. Chrome extensions can only connect out, never be called from outside, so a local process is unavoidable. That process is the MCP server itself.

- `extension/` - MV3, thin relay. Connects to `ws://127.0.0.1:17333`, forwards CDP commands to tabs through `chrome.debugger`. Pings every 20s to keep the service worker alive, retries every 30s via `chrome.alarms` when the server is not running.
- `server/` - Node MCP server over stdio that also hosts the WebSocket. All logic lives here, so most changes need no extension reload. Tools: `list_tabs`, `new_tab`, `close_tab`, `navigate`, `snapshot`, `click`, `type`, `press_key`, `screenshot`, `evaluate`.

Design choices:

- **`chrome.debugger` over content scripts.** Trusted input events, accessibility tree, screenshots, works regardless of page CSP. Cost: the "started debugging this browser" bar while attached.
- **WebSocket over native messaging.** Two-step install for other people later (add extension, run one command). Native messaging needs a per-OS host manifest.
- **No tab scoping, on purpose for now.** The agent gets every open tab. I built per-tab sharing first (click the icon to share a tab), then a share-all toggle, then dropped both to keep it simple. Worth revisiting before other people install it.
- **Multiple sessions.** The first server to start owns port 17333 and the extension connection. Later servers join it as peers (no Origin + `x-bridge-peer` header) and get relayed. If the primary exits, a peer takes over the port and the extension reconnects within about 2s.
- **Origin check instead of a token.** The manifest has a fixed `key`, so the unpacked extension ID is always `epjnmpnkphfbonblfmfeokijfhmjcfne`. The server only accepts WebSocket upgrades with that `chrome-extension://` Origin, which web pages and other extensions cannot forge. A local process can, so this is not a defense against malware already on the machine. The private key is in `.keys/` (gitignored).
- **Snapshot first.** `snapshot` returns the accessibility tree as text with `[ref]` numbers (`backendDOMNodeId`); `click` and `type` take a ref and resolve it to coordinates with `DOM.getBoxModel`.

Known gaps: no per-origin allowlist or confirmations yet. No iframe handling. Sessions share tabs with no locking between them.

Setup: `cd server && npm install`, then `chrome://extensions` - Developer mode - Load unpacked - pick `extension/`. Registered in Claude Code with `claude mcp add -s user chrome-bridge -- node <repo>/server/index.js`.

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
