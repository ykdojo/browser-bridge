# TESTING.md

How this repo is tested, and a running log of what testing found. Newest first.

## The two suites

`npm test` in `server/` runs both. Current state: relay 21/21, e2e 110/110.

**`test:relay`** needs no browser. Fake extensions (WebSocket clients sending the extension's Origin) talk to real server processes on a separate port, so it never touches a live setup.

- First server becomes primary, later ones join as peers and are relayed
- Origin check: web pages, other extensions and header-less clients are rejected
- No extension: a clear error after a 5s grace period, not a hang
- Extension drops mid-call: fails in milliseconds, not the 30s timeout. Same when the primary dies under a peer
- Primary exits: a peer takes over the port and the extension follows
- Two profiles: latest connected is active, icon click switches, closing one falls back to the other
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
- **Sessions**: a second server joins as a peer and acts on the same tab
- **Closing**: `tabs_close` goes through an unsaved-changes prompt, and nothing native is left open

Not covered, and why:

- `read_page`/`find` inside iframes, cross-site iframes: not implemented yet
- The extension's service worker being suspended and restarted: the recovery code exists but nothing can force a suspension from a test
- Two real Chrome profiles at once: only with fake extensions, since a test can't click a toolbar icon
- Windows and Linux: the native-window checks are macOS only and skip elsewhere
- Real sites: single-page apps, virtualized lists, shadow-DOM-heavy UIs. This needs ordinary use, not a test page

## Log

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

### Tool surface rework + rename (2026-09-21)

The 10 ad-hoc tools became the 12 Claude-for-Chrome-shaped ones, and Chrome Bridge became Browser Bridge. First tested by hand over MCP stdio against a real logged-in Chrome: example.com end to end (tabs, navigate, read_page, find, ref click, back, page text, scroll, keys, screenshot, zoom, console/network capture), plus form_input against httpbin.org/forms/post. That pass found that `javascript_tool` rejected top-level await (`Runtime.evaluate` needed `replMode`) and that aria-labelled `generic` nodes were invisible to `read_page`/`find`. It then grew into the automated suite.
