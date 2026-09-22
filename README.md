# Browser Bridge

A Chrome extension plus a local MCP server that lets AI agents (Antigravity, Claude Code, or any other) control your real, logged-in Chrome. You can think of it as an open source alternative to Claude for Chrome, built a slightly different way.

- **Everything stays local.** Extension ↔ localhost WebSocket ↔ MCP server, no third-party relay, no accounts.
- **Any MCP client can drive it**, not just one product.
- **The codebase is deliberately small**: two files. The extension is one background script acting as a thin relay into Chrome; the MCP server is one file holding all the logic, talking to the extension over the local WebSocket.
- **The tool names and input shapes are kept consistent with Claude for Chrome's.** The implementation is independent.

Tools that are features of the Claude product rather than browser primitives are left out: image/file upload, GIF recording, plan approval, shortcuts, window resizing. Also not replicated yet: Claude for Chrome's guardrails (site permissions, blocked categories, confirmation prompts) - see Known gaps.

## How it works

- `extension/` - Manifest V3, thin relay. Connects to `ws://127.0.0.1:17333`, forwards Chrome DevTools Protocol (CDP) commands to tabs through `chrome.debugger`, buffers console/network events per tab, and answers JavaScript dialogs the agent triggers. Its toolbar popup shows connection status and links to a short "How it works" page. Pings every 20s to keep the service worker alive, and a `chrome.alarms` tick every 30s wakes it to look for a server again.
- `server/` - Node MCP server over stdio that also hosts the WebSocket. All logic lives here, so most changes need no extension reload. Tools: `tabs_context`, `tabs_create`, `tabs_close`, `navigate`, `computer`, `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `read_console_messages`, `read_network_requests`.

Design choices:

- **`chrome.debugger`, not content scripts.** Trusted input events, the accessibility tree and screenshots, on any site. Cost: the "started debugging this browser" bar while attached.
- **WebSocket, not native messaging.** Native messaging needs a host manifest installed per operating system; this needs one command.
- **Refs.** `read_page` and `find` hand out `ref_N` ids that clicks and `form_input` resolve back to elements. Refs reset on navigation. `find` is text matching over the accessibility tree, not an LLM call.
- **One server process per client, coordinated.** This is a stdio MCP server, so each agent session runs its own copy. The first one owns port 17333 and the extension; later ones relay through it, and take over if it exits.
- **Native UI never opens.** Synthetic input can open Chrome's context menu, `<select>` popups and file pickers but can never close them, and an open native menu stalls tab closing browser-wide. All three are prevented; page-drawn context menus still work.
- **Dialogs never freeze the tab.** `alert`/`confirm`/`prompt` dialogs the agent causes are answered at once and reported in the next result. Ones a person causes are left alone. A "Leave site?" prompt would make Chrome bring the tab to the foreground, so it never shows: before leaving a page the bridge asks the page's own handlers whether they would object, holds a plain `navigate` back if so, and silences them for a forced navigation or a close.
- **Screenshots are 1:1 with click coordinates**, whatever the display scaling.
- **New tabs open in the background**, in the window the agent last worked in, and never in a window of their own. `tabs_create` keeps the tab you are looking at unless you ask the agent to work in the foreground (`active: true`). Every tool works on a hidden tab, mouse input included, so the agent never switches your window to its tab.
- **The agent's tabs are marked.** Tabs it opens sit in a "🌉" tab group whose label is only ever true: "🌉 active" (orange) while a command ran in one of them in the last 30 seconds, "🌉 idle" (blue) after that, and "🌉 done" (grey) only once the agent calls `done` or the session ends. Idle never becomes done on a timer, since an agent thinks for seconds between commands. Your own tabs are never grouped.
- **Quiet when idle.** With no server running the extension knocks with `fetch` every 2s, which Chrome doesn't log, and only then opens the WebSocket.
- **Several profiles at once.** Each Chrome profile with the extension loaded connects, and the agent sees every profile's tabs in one `tabs_context` list, each tab labeled with its profile. It picks the profile whose sign-ins fit the task: a command goes to the profile that owns its tab, and `tabs_create` takes a `profile`.
- **Origin check, not a token.** The extension ID is fixed, and the server only accepts connections whose `Origin` is that ID, which pages and other extensions can't forge. A local process could, so this isn't a defense against malware on the machine.
- **Every tab, not a tab group.** The agent sees and works in any tab open in its profile. Claude for Chrome only reaches tabs in its own tab group, so a tab you already have open has to be dragged into that group, or Claude has to open a new one.

Known gaps: no per-origin allowlist or confirmations yet. `read_page` and `find` don't see inside iframes (coordinate clicks do reach them). Sessions share tabs with no locking between them.

## Setup

1. `cd server && npm install`
2. In Chrome, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick the `extension/` folder. The extension only reaches tabs in the Chrome profile it is loaded in; load it in each profile the agent should be able to use.
3. Register the server with your MCP client, e.g. `claude mcp add -s user browser-bridge -- node <repo>/server/index.js`

### Updating

Loading the extension is the only time you need `chrome://extensions`. After that, run these from `server/`:

- `npm run reload` - reload the extension from disk once, e.g. after a `git pull`
- `npm run dev` - reload it on every change to `extension/`, for development
- `npm test` - the e2e suite reloads it before it runs

The one exception: if an edit breaks the extension so badly that it can't start, it can't reload itself either, and needs one click on the reload button. Server changes never need any of this: each new client session starts the current code.

## Testing

`npm test` in `server/` runs two suites. `test:relay` needs no browser: fake extensions on a separate port exercise the connection layer (relay, takeover, disconnects, origin check, profiles). `test:e2e` drives all 12 tools through the real extension and Chrome against an instrumented local page, asserting effects by reading page state back; it reloads the extension from disk first. [TESTING.md](TESTING.md) has what is covered and the log of what testing found.

