# TESTING.md

A running log of how changes to this repo were tested. Newest first.

## Automated e2e suite

`test/e2e.mjs`, run with `npm test` from `server/`. Needs Chrome running with the extension loaded; joins any running server as a peer, so it's safe alongside live sessions. It serves an instrumented page that records every event it receives, drives all 12 tools over MCP stdio in a throwaway tab, and asserts each effect by reading page state back. 33 checks, all passing.

Coverage:

- **read_page**: full tree, interactive filter, depth, max_chars truncation, ref_id subtree focus
- **find**: ranks the right element first; finds aria-labelled contenteditables
- **Clicks by ref and by coordinate**: single, double, triple, right, and modifier clicks, verified from the page's recorded events
- **Keyboard**: type, key with repeat, cmd+a select-all, triple-click selection
- **form_input**: text, radio, checkbox (httpbin.org/forms/post), select by option text, contenteditable
- **computer misc**: hover, drag (moved a target 120px), scroll, scroll_to, wait, screenshot, zoom
- **Console/network**: onlyErrors, pattern/urlPattern filters, limit, clear
- **navigate**: bare-domain https default, back via history, force through onbeforeunload
- **tabs**: context, create, close

Fixes that came out of writing it:

- `javascript_tool` rejected top-level await; `Runtime.evaluate` needed `replMode: true`
- aria-labelled `generic` nodes (contenteditable divs) were invisible to `read_page`/`find`; a name now rescues the role
- (test-side) wheel scrolling settles asynchronously, and skipped wrapper nodes don't add tree depth

Not covered: iframes, uploads (deliberately not implemented), shortcut keys beyond the cmd/ctrl edit-command mapping, non-Mac modifier conventions.

## Tool surface rework + rename (2026-09-21)

The 10 ad-hoc tools became the 12 Claude-for-Chrome-shaped ones, and Chrome Bridge became Browser Bridge. First tested by hand over MCP stdio against the real logged-in Chrome: walked example.com end to end (tabs, navigate, read_page, find, ref click to iana.org, back, page text, scroll, keys, screenshot, zoom, console/network capture). That pass found the top-level-await bug, then grew into the automated suite above. Rename verified: no "chrome bridge" left in the repo, `claude mcp list` shows `browser-bridge` connected, GitHub responds at `ykdojo/browser-bridge`.

