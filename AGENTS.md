# Working on Browser Bridge

Instructions for AI agents (and people) changing this repo. `CLAUDE.md` is a symlink to this file.

## Verifying changes

- **Prove fixes in the real environment.** Reproduce the problem first, then show it gone with the same steps, against a real Chrome with the extension loaded. Reasoning about the cause is not verification, and the suites passing does not prove a specific bug is fixed unless a check covers it.
- **Anything verified by hand goes into a suite.** A one-off experiment that found or confirmed something becomes a permanent check in `test/relay.mjs` or `test/e2e.mjs` before the work is done.
- **Assert effects, not absence of errors.** Read page state back, measure timing, count OS windows. "The call returned" proves little.
- Run `npm test` in `server/` before committing. `test:relay` needs no browser. `test:e2e` needs Chrome with the extension loaded and reloads it from disk first. Don't use that Chrome window while e2e runs.
- **Know how long a command should take, and act when it doesn't.** Measured: `test:relay` takes about 30 seconds, `test:e2e` about 45. Both abort themselves with the name of the stuck check (after 2 and 3 minutes). Measure, don't estimate: the first numbers written here were guesses and were off by 4x. When anything runs well past its usual time, stop and investigate: don't keep waiting, and don't make the person ask.
- Keep `TESTING.md` current: what is covered, what is not and why, and a short log of what testing found. Concise and scannable.

## Extension changes

- Never ask for a manual reload at `chrome://extensions`. Use `npm run reload`, or `npm run dev` to reload on every change. The one exception is an edit that stops the extension from starting.
- Bump the version in `extension/manifest.json` when the extension changes, and keep `server/package.json` on the same number, so the loaded version can be checked (the toolbar popup and `tabs_context` both show it).
- The extension's failures only show on `chrome://extensions`, which nothing automated can read. So the extension reports on itself: the `diagnostics` message returns its error log, and `console.watch` makes it mirror what Chrome prints into its own console, which is what fills that Errors page. e2e asserts both stay empty. If a person reports something on that page, reproduce it through the mirror before changing anything.
- Don't call something unavoidable before measuring it. The refused-connection errors were "unavoidable" until each connection method was measured against a closed port.

## Rules learned the hard way

- **Synthetic input must never open native OS UI**: Chrome's context menu, `<select>` popups, file pickers. It cannot be closed again, and on macOS an open native menu stalls tab closing for the whole browser until a person clicks. JavaScript dialogs freeze the tab the same way. Every new input path needs the same guards.
- **Mouse input needs a visible tab.** On a hidden tab a click takes 5s and a wheel scroll never returns.
- **Reply on the connection that asked**, and only if it is still open. A command can outlive its connection.
- Tool names and input shapes stay consistent with Claude for Chrome's. `reference/` (gitignored) holds definitions extracted from that extension: never commit, cite, or copy from it. Implementations here are written independently.

## Keeping it small

- Before adding a mechanism, look for the one that already exists. The extension is a per-tab state map, a self-reporting block, a commands table and the server link; the server is one function per concern and one `tool(...)` per tool. New behavior goes into that shape.
- Test-only hooks (`probe`, `console.watch`, `diagnostics`) are fine but stay in the "extension itself" group of commands, and each needs a comment saying what property it exists to check.
- After a run of fixes, re-read the file top to bottom and collapse what grew. The suites are the safety net for that.

## Writing

- README and docs: short, no repetition, no unexplained acronyms (MCP is fine), "your" not "my", no claims that can't be backed up.
- Commit and push as separate commands. No attribution lines in commits.
