# TESTING.md

A running log of how changes to this repo were tested. One section per change, newest first.

## Automated e2e suite: every tool, refs and coordinates

`test/e2e.mjs`, run with `npm test` from `server/`. It needs Chrome running with the Browser Bridge extension loaded; it spawns the server (joining any running one as a peer, so it's safe alongside live sessions), serves an instrumented page (`test/test-page.html`) on `127.0.0.1:18444` that records every event it receives, drives all 12 tools over MCP stdio in a throwaway tab, and asserts each effect by reading page state back. 33 checks, currently all passing.

What it covers, and how each is verified rather than just "didn't error":

- **read_page**: full tree, `filter: interactive` (no headings leak through), `depth: 0` (root only), `max_chars` truncation note, `ref_id` subtree focus.
- **find**: ranks the right button first; finds an aria-labelled contenteditable (role `generic`) - see fix below.
- **Clicks by ref AND by coordinate**: single, double, right, and modifier clicks (`shift+alt`) land on the button, confirmed from the page's own recorded events (type, button, modifier flags). Coordinate clicks use `getBoundingClientRect`, the same frame a screenshot gives.
- **Keyboard**: `type` into a focused input, `key` with `repeat` (6 backspaces leave exactly "hello "), `cmd+a` select-all then retype (the CDP editing-command mapping), `triple_click` selects the whole value.
- **form_input**: select by visible option text (fires `change`), text/radio/checkbox verified earlier against httpbin.org/forms/post, contenteditable via the named-generic fix.
- **computer misc**: `hover` flips a CSS hover class, `left_click_drag` moves a drag target 120px (measured 119px), `scroll` changes `scrollY` (async - settles ~200ms after the wheel event, the test waits), `scroll_to` brings the bottom paragraph into the viewport, `wait` takes the requested second, `screenshot` returns a real JPEG, `zoom` returns a clipped region capture.
- **Console/network**: `onlyErrors` excludes plain logs, `pattern`/`urlPattern` filter, `limit` reports "showing last N of M", `clear` empties the buffer.
- **navigate**: bare-domain https default, `back` via history entries, `force: true` gets through an armed `onbeforeunload`.
- **tabs**: `tabs_context` shows the test tab with its title, `tabs_create`/`tabs_close` bracket the run.

Fixes that came out of writing the suite:

- `javascript_tool` rejected top-level await despite promising REPL semantics. `Runtime.evaluate` needed `replMode: true` (`b2ba5c6`).
- Aria-labelled containers with AX role `generic` (contenteditable divs) were invisible to `read_page` and `find` because `generic` is in the skip list. A name now rescues the role.
- One test-side correction: skipped wrapper nodes don't add tree depth, so a button can sit at depth 1 of a deeply nested DOM - the `depth` test expected otherwise and was wrong, not the server.

Not covered: iframes (known gap), file/image upload (deliberately not implemented), shortcut keys beyond the cmd/ctrl edit-command mapping, and Windows/Linux modifier conventions.

## Tool surface rework: match Claude for Chrome shapes (+ rename to Browser Bridge)

Commits: `2fbaccc` (rework), `7388fae`/`26c84d8` (rename), `b2ba5c6` (replMode fix). Replaced the 10 ad-hoc tools with 12 tools mirroring Claude for Chrome's names and schemas, moved console/network event buffering into the extension, and renamed everything from Chrome Bridge to Browser Bridge (repo included, old URLs redirect).

First tested 2026-09-21 by hand against the real setup: the reworked server driven over MCP stdio with raw JSON-RPC, joining the already-running server as a peer, through the reloaded extension, against the real logged-in Chrome. That pass walked example.com end to end (tabs, navigate, read_page, find, ref click to iana.org, back, page text, scroll, keys, screenshot, zoom, console and network capture with filters) and found the top-level-await bug. It then grew into the automated suite above, which supersedes it.

Rename checks: `grep -ri "chrome.bridge"` over the repo comes back empty (minus the gitignored `reference/`), `claude mcp list` shows `browser-bridge` connected at the new path, and the GitHub repo responds at `ykdojo/browser-bridge`.

## Initial extension + server (Chrome Bridge v0.4)

Built 2026-09-19 during the Build Day session. Smoke tested at the time: tool listing, origin check (rejects other origins, accepts the extension's fixed ID), extension connect/reconnect, tab listing, snapshot against the Build Day visualization page, and the multi-session takeover cases (primary exits, peer takes over) against a stand-in for the extension. Click and type were registered but not exercised against a real page. First real use was reading the Luma guest list and blasts pages, listing tabs repeatedly, and opening new tabs for the demo. Superseded by the rework above.
