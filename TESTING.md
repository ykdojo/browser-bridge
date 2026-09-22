# TESTING.md

How this repo is tested, and a log of what testing found. Newest first.

## The two suites

`npm test` in `server/` runs both. Current state: relay 23/23, e2e 129/129 (one skipped while another session owns the port). Relay takes about 30s, e2e about 45s; each aborts itself past 2 or 3 minutes, naming the last check that passed.

**`test:relay`** needs no browser: fake extensions talk to real server processes on a separate port.

- Primary/peer roles, relay, takeover when the primary exits
- Origin check rejects pages, other extensions and header-less clients
- No extension: clear error after 12s, not a hang. Drops mid-call fail in milliseconds
- Server exits when its client goes away (no orphans)
- Two profiles: both listed with profile labels, a command reaches the profile owning its tab, `tabs_create` targets a profile, a label survives a reconnect, one closing leaves the other
- Notices reach the tool result once, including through a peer
- Outdated extension is called out; a stuck `tabs_close` explains itself after 10s

**`test:e2e`** drives all 13 tools through the real extension and Chrome, against a local page that records every event it receives. It asserts effects (page state, timing, OS windows), reloads the extension from disk first, and works in the Chrome window you are using: its tabs open in the background and stay there, and nothing it does takes the foreground: a watchdog polls the active tab of your window throughout and names the check during which it changed. Not covered: `tabs_create` with `active: true`, which would flash a tab over what you are doing on every run, and `tabs_create` making a window when Chrome has none open, which would need all your windows closed.

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

**"Leave site?" prompts brought the tab forward.** The suite kept flashing a tab over the person's work even with the foreground check gone. A watchdog polling the active tab every 250ms named the moment: the unsaved-changes checks. Measured on a background tab: the moment Chrome shows a beforeunload prompt it makes that tab the active one, before the extension's answer arrives. So the prompt must never show. The server now asks the page first, by dispatching a beforeunload event that unloads nothing and watching for `preventDefault`, a set `returnValue` or a legacy handler's return value, and only when the page has had a user gesture (Chrome prompts for no other page). A plain `navigate` is held back on that answer alone; a forced one and `tabs_close` first silence the page by patching `BeforeUnloadEvent.prototype` and clearing `onbeforeunload`, which was measured to leave the tab in the background and land on the new page. Tried and rejected: a capture listener that stops propagation runs last, not first, at the window; `getEventListeners` is not in the command line API through `chrome.debugger`, and `DOMDebugger.getEventListeners` returns no handler objects there. Found on the way: the silenced document comes back from the back/forward cache still silenced and still "active", so the probe checks for its own patch. Not covered: a link the agent clicks on a guarded page, which still prompts and still brings the tab forward.

**Three group states, and done only when said.** The 🌉 group flipped between "active" and "done" while an agent worked: it went done after 1.5s of quiet, and an agent thinks for longer than that between commands. Now each label is only ever true: "🌉 active" (orange) while a command ran in the last 30s, "🌉 idle" (blue) after that, "🌉 done" (grey) only when the agent calls the new `done` tool or the server's socket closes. Idle never becomes done on a timer. The suite shortens the idle wait to 1s through a raw `groups.idleAfter` message and checks all four transitions. The extension's service worker can be restarted with its timers, so a group still reading active when it starts is settled to idle. Also removed: the one check that opened a foreground tab, which flashed over the person's work on every run; nothing in the suite takes the foreground now, and `tabs.activate` went with it.

**Background tabs and the 🌉 group.** `tabs_create` took over the tab the person was looking at. It now opens in the background (`active: true` on request) and in a "🌉" group whose title and color show whether the agent is active or done. Found on the way: `chrome.tabs.group` without `createProperties` puts the new group in the focused window, not the tab's, which dragged test tabs into the person's window; and a window created with `focused: false` still took focus (measured by reading the frontmost window before and after). The suite no longer makes a window: it works in the person's window like an agent does, opens every tab in the background, tracks what it opened, and gives the person their tab back at the end.

**No more switching to the tab.** Mouse actions used to make the agent's tab the visible one, which is exactly the focus-stealing a person notices. Measured on fresh hidden tabs: a click landed in 15ms as is, a wheel scroll never returned; with `Emulation.setFocusEmulationEnabled` both took about 13ms, while `Page.setWebLifecycleState` and `Page.startScreencast` changed nothing. The extension now enables focus emulation on attach, the server never activates a tab, and the whole suite runs on a tab the person never sees. Found on the way: a tab that has never been shown renders with the primary display's pixel ratio and color space (2x and Display P3 here) rather than its window's display (1x, sRGB), and adopts the window's the first time it is shown. Screenshot coordinates are unaffected (the clip scales by the page's ratio), colors are P3-encoded, so the suite's lime match is loose.

**Simplification pass.** Extension rewritten from 15 message types and 27 globals into four sections, 349 to 303 lines; suites passed unchanged. Chrome was found to intermittently keep covered tabs rendering (comes and goes within minutes, nothing from the bridge in between), so the hidden-tab check asserts what the bridge controls. The suite got its own window; `tabs_create` follows the agent's window.

**Errors on the extension's page.** Reproduced by mirroring the extension's own console through the debugger, then measured:
- "WebSocket is already in CLOSING or CLOSED state": a reply sent on a dead socket. Replies now go only to the connection that asked
- `ERR_CONNECTION_REFUSED` whenever no server ran: a refused WebSocket makes Chrome log an error, a refused `fetch` doesn't. The extension now knocks with `fetch` first. 9s with no server: 4 errors before, 0 after
- A run broken by using the Chrome window: mouse input on a hidden tab (click 5s, scroll never). Mouse actions make the tab visible first: click 301ms, scroll 306ms

**Growing the suite found a browser-wedging bug.** A synthetic right-click opened Chrome's native menu, which nothing synthetic can close, and on macOS that blocked closing any tab. `<select>` popups, file pickers and JS dialogs are the same family; all are now prevented. Also fixed in that round: 30s hangs on a dropped extension, refs surviving failed navigation, duplicate `find` hits, `scroll` returning early, screenshots in device pixels, two profiles fighting over the connection, an orphaned server after a client crash.

**Tool surface rework.** 10 ad-hoc tools became the 12 Claude-for-Chrome-shaped ones. First tested by hand against example.com and httpbin's form; found `javascript_tool` rejecting top-level await (`replMode`) and aria-labelled `generic` nodes invisible to `read_page`/`find`. Grew into the automated suite.
