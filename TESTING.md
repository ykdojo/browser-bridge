# TESTING.md

How this repo is tested, and a log of what testing found. Newest first.

## The two suites

`npm test` in `server/` runs both. Current state: relay 23/23, e2e 122/122. Relay takes about 30s, e2e about 45s; each aborts itself past 2 or 3 minutes, naming the last check that passed.

**`test:relay`** needs no browser: fake extensions talk to real server processes on a separate port.

- Primary/peer roles, relay, takeover when the primary exits
- Origin check rejects pages, other extensions and header-less clients
- No extension: clear error after 12s, not a hang. Drops mid-call fail in milliseconds
- Server exits when its client goes away (no orphans)
- Two profiles: latest is active, each is told which, the popup switch works, fallback when one closes
- Notices reach the tool result once, including through a peer
- Outdated extension is called out; a stuck `tabs_close` explains itself after 10s

**`test:e2e`** drives all 12 tools through the real extension and Chrome, against a local page that records every event it receives. It asserts effects (page state, timing, OS windows), reloads the extension from disk first, and works in a Chrome window of its own.

- **read_page / find / get_page_text**: filters, depth, truncation, subtree focus, ranking, no duplicate hits, no-match message
- **Clicks**: by ref and by pixel, the pixel found by decoding the screenshot; single, double, triple, right, modifiers; on an emulated 2x display; on a scrolled page
- **Keyboard**: type, key repeat, select-all, sequences, Tab, Enter submits, multi-line unicode
- **form_input**: text, number, textarea, checkbox, radio, select by text and value, contenteditable, failure messages
- **Native UI never opens** (macOS, by counting OS windows): right-click reaches the page but Chrome's menu stays closed, page-drawn menus work, `<select>` refused, file pickers suppressed and reported
- **Dialogs**: alert/confirm/prompt answered and reported, the `window.confirm` override works, a dialog left open is cleared by the next command
- **Scrolling**: element under the pointer, all directions, settled on return, `scroll_to`, `zoom` exact region
- **Console / network**: levels, uncaught exceptions, filters, limit, clear, failed requests
- **Navigation**: held at an unsaved-changes prompt, through it with `force`, back/forward, stale refs rejected, unreachable URL, recovery
- **Error paths**: every `computer` action's bad arguments, unknown tabs, page exceptions
- **Hidden tabs**: a click on a covered tab is fast and reports the switch; reading needs no switch
- **Sessions**: a second server acts on the same tab; a reply for a dead connection is withheld
- **The extension itself**: popup and about page render; no errors logged and nothing printed to its console all run, including a stretch with no server; a refused `fetch` is silent

Not covered: `read_page`/`find` inside iframes (not implemented); service worker suspension (can't be forced); two real profiles (fake ones only); Windows/Linux; real sites. About one run in ten dies with a `computer` timeout; the suite names where.

## Log (all 2026-09-21)

**Simplification pass.** Extension rewritten from 15 message types and 27 globals into four sections, 349 to 303 lines; suites passed unchanged. Chrome was found to intermittently keep covered tabs rendering (comes and goes within minutes, nothing from the bridge in between), so the hidden-tab check asserts what the bridge controls. The suite got its own window; `tabs_create` follows the agent's window.

**Errors on the extension's page.** Reproduced by mirroring the extension's own console through the debugger, then measured:
- "WebSocket is already in CLOSING or CLOSED state": a reply sent on a dead socket. Replies now go only to the connection that asked
- `ERR_CONNECTION_REFUSED` whenever no server ran: a refused WebSocket makes Chrome log an error, a refused `fetch` doesn't. The extension now knocks with `fetch` first. 9s with no server: 4 errors before, 0 after
- A run broken by using the Chrome window: mouse input on a hidden tab (click 5s, scroll never). Mouse actions make the tab visible first: click 301ms, scroll 306ms

**Growing the suite found a browser-wedging bug.** A synthetic right-click opened Chrome's native menu, which nothing synthetic can close, and on macOS that blocked closing any tab. `<select>` popups, file pickers and JS dialogs are the same family; all are now prevented. Also fixed in that round: 30s hangs on a dropped extension, refs surviving failed navigation, duplicate `find` hits, `scroll` returning early, screenshots in device pixels, two profiles fighting over the connection, an orphaned server after a client crash.

**Tool surface rework.** 10 ad-hoc tools became the 12 Claude-for-Chrome-shaped ones. First tested by hand against example.com and httpbin's form; found `javascript_tool` rejecting top-level await (`replMode`) and aria-labelled `generic` nodes invisible to `read_page`/`find`. Grew into the automated suite.
