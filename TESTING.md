# TESTING.md

How this repo is tested, and a running log of what testing found. Newest first.

## The two suites

`npm test` in `server/` runs both. Current state: relay 23/23, e2e 118/118.

**`test:relay`** needs no browser. Fake extensions (WebSocket clients sending the extension's Origin) talk to real server processes on a separate port, so it never touches a live setup.

- First server becomes primary, later ones join as peers and are relayed
- A server exits when its client goes away, so a crashed agent session leaves no orphan holding the port
- Origin check: web pages, other extensions and header-less clients are rejected
- No extension: a clear error after a 12s grace period, not a hang
- Extension drops mid-call: fails in milliseconds, not the 30s timeout. Same when the primary dies under a peer
- Primary exits: a peer takes over the port and the extension follows
- Two profiles: latest connected is active, each is told whether it is the one in use, the popup's switch works, closing one falls back to the other
- Extension notices reach the tool result, once, including through the relay
- An outdated extension is called out in `tabs_context`. A stuck `tabs_close` explains itself after 10s

**`test:e2e`** drives all 12 tools through the real extension and Chrome, against an instrumented local page that records every event it receives. Effects are asserted by reading page state back, not by "it didn't error". It reloads the extension from disk first, so it always tests the code in the repo, and it only touches a throwaway tab.

- **read_page / find / get_page_text**: filters, depth, truncation, subtree focus, ranking, no duplicate hits, aria-labelled contenteditables, no-match message
- **Clicks by ref**: single, double, triple, right, modifier clicks, verified from the page's recorded events
- **Clicks by pixels**: the test decodes the screenshot, finds a solid-colored target by its pixels and clicks that point, the way an agent would. Repeated on an emulated 2x display and on a scrolled page. `zoom` must return exactly the requested region
- **Keyboard**: type (with input events), key repeat, select-all, character sequences, Tab focus, Enter submits a form, multi-line unicode
- **form_input**: text, number, textarea, checkbox on/off, radio, select by text and by value, contenteditable, and both failure messages
- **Native UI never opens** (macOS: checked by counting OS-level windows): right-click fires the page's event unprevented but Chrome's menu stays closed, page-drawn context menus still work, same inside an iframe, `<select>` clicks and opening keys are refused with guidance, file pickers from a click, a script and the keyboard are suppressed and reported
- **Dialogs never freeze the tab**: alert, confirm, prompt return promptly and are reported; the documented `window.confirm` override works; a dialog that opened while the agent was idle is cleared by the next command
- **Scrolling**: targets the element under the pointer, all four directions, settled by the time the tool returns, `scroll_to`
- **Console / network**: levels, uncaught exceptions, onlyErrors, patterns, limit, clear, failed requests
- **Navigation**: held at an unsaved-changes prompt without `force`, through it with `force`, back, forward, stale refs rejected, unreachable URL reported, tab recovers afterwards
- **Error paths**: every `computer` action's missing or invalid arguments, unknown tab ids, page exceptions
- **Hidden tabs**: a click on a background tab is fast, lands, and reports the tab switch; a scroll returns; reading needs no switch
- **Sessions**: a second server joins as a peer and acts on the same tab
- **Closing**: `tabs_close` goes through an unsaved-changes prompt, and nothing native is left open
- **The extension itself**: its popup and "How it works" page render, it logged no errors during the run, and a command that outlives its connection has its reply withheld instead of sent on a dead or newer connection

Not covered, and why:

- `read_page`/`find` inside iframes, cross-site iframes: not implemented yet
- The extension's service worker being suspended and restarted: the recovery code exists but nothing can force a suspension from a test
- Two real Chrome profiles at once: only with fake extensions, since a test can't click a toolbar icon
- Windows and Linux: the native-window checks are macOS only and skip elsewhere
- Real sites: single-page apps, virtualized lists, shadow-DOM-heavy UIs. This needs ordinary use, not a test page

## Log

### Two errors on the extension's Errors page, and a run broken by switching tabs (2026-09-21)

Both were verified before and after in a real Chrome, then turned into permanent checks.

- **"WebSocket is already in CLOSING or CLOSED state".** The extension replied on whatever the current socket was when a command finished. A command that outlived its connection (tab closes stuck behind the native menu below) replied on a dead socket, and could have replied on a newer connection with reused ids. Reproduced by killing the server under a 5s in-page promise: the old logic called `send()` on a socket in readyState 3, the fix withholds the reply. The first attempt at observing this failed and was instructive: `send()` on a closed socket doesn't throw, Chrome only prints a console message, so an exception log sees nothing
- **`ERR_CONNECTION_REFUSED` entries.** Expected whenever no server is running, and Chrome logs them where code can't silence them. The retry now backs off (2s, 4s, 8s, then every 10s) instead of every 2s forever. A 30s cap was tried first and dropped: measured, it made a new session wait too long for the browser
- **A suite run failed while the Chrome window was in use.** Cause: the test tab was no longer the visible one. Measured on a hidden tab: reading, typing and screenshots fine, a click 5028ms, a wheel scroll never returned. After the fix (make the tab visible first): click 301ms, scroll 306ms
- The extension had no way to report its own failures to anything automated. It now keeps an error log the bridge can read, and records any `send()` on a socket that isn't open (the exact condition behind that Chrome message), so e2e's "logged no errors" check covers it on every run
- One later run failed 21 input checks while a person was using the same Chrome window. Two systematic causes were tested and ruled out, each with effects checked: keyboard input on a hidden tab works, and a dialog that opens in a hidden tab is dismissed and the next click lands. Untouched runs before and after were 118/118. So: the suite is not robust to someone driving the same window at the same time, and says so in AGENTS.md

### Growing the e2e suite found a browser-wedging bug (2026-09-21)

Going from 33 happy-path checks to error paths and edge cases, the final `tabs_close` began timing out. Isolating it showed even a blank, never-touched tab would not close. Cause: the suite's own `right_click`. A synthetic right-click opens Chrome's native context menu, synthetic input can never close it (it only listens to real OS input), and on macOS an open native menu stalls tab closing for the whole browser. Confirmed by watching an OS-level menu window appear, and by failing to clear it with a CDP Escape, Apple Events, navigation and reload. `<select>` popups and file pickers are the same kind of UI, and JavaScript dialogs freeze the tab in a similar way. All four are now prevented (see README, "Native UI never opens" and "Dialogs never freeze the tab").

Also found and fixed in the same round:

- A dropped extension left calls hanging for 30s. They now fail immediately
- Refs survived a failed navigation, pointing into a page that no longer existed
- `find` returned a button and its own label text as two hits
- `scroll` returned before the scroll landed, so an immediate screenshot showed the old position
- Screenshots were device pixels, so on a 2x display a point read off a screenshot would click the wrong place
- Two profiles with the extension silently fought over the connection
- The new server code had only ever run as a peer of an older process. It now also runs as primary under test
- A server outlived a client that died without killing it, because its WebSocket listener kept it alive. It now exits when stdin closes (found when stopping the reload watcher left one behind)

### Tool surface rework + rename (2026-09-21)

The 10 ad-hoc tools became the 12 Claude-for-Chrome-shaped ones, and Chrome Bridge became Browser Bridge. First tested by hand over MCP stdio against a real logged-in Chrome: example.com end to end (tabs, navigate, read_page, find, ref click, back, page text, scroll, keys, screenshot, zoom, console/network capture), plus form_input against httpbin.org/forms/post. That pass found that `javascript_tool` rejected top-level await (`Runtime.evaluate` needed `replMode`) and that aria-labelled `generic` nodes were invisible to `read_page`/`find`. It then grew into the automated suite.
