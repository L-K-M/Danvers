# Danvers Code Review — Findings & Ideas

A thorough review of the current codebase (`v0.2.10`): bugs, general issues,
missing features, and ideas for improvements. Items marked **[implemented]**
have a companion PR; the rest are written down for future consideration.

---

## 1. Bugs

### B1. Pending fade-out can delete a freshly re-opened overlay **[implemented]**

`fadeOutAndCloseOverlay()` (`src/content/overlay.js`) schedules
`setTimeout(closeOverlay, FADE_OUT_MS)` but never stores the timer handle. If
the user taps the toolbar button again while the fade-out is in flight (or
within the 180 ms window after auto-dismiss fires), `showOverlay()` happily
reuses the existing host element — and then the stale timeout fires and
removes it. The new save proceeds in the background with no visible UI,
because every subsequent `render()` bails out on `overlayRoot === null`.

**Fix:** track the fade-out timer and cancel it in `clearDismissTimer()`,
which `showOverlay()` already calls.

### B2. List add/remove responses are not guarded against overlay reuse **[implemented]**

`saveCurrentPage()` and `loadLists()` both compare `requestId !==
state.requestId` after their `await` to drop stale responses, but
`setListSelection()` does not. Sequence: user toggles a list, immediately
re-invokes the overlay on a new save; the old `ADD_TO_LIST` response lands and
overwrites `selectedListIds` / `listMessage` for the *new* bookmark's UI.

**Fix:** capture `state.requestId` at entry and discard the response if it no
longer matches.

### B3. Title truncation can split a surrogate pair **[implemented]**

`normalizeBookmarkTitle()` (`src/background.js`) does
`title.slice(0, 1000)`. `String.prototype.slice` counts UTF-16 code units, so
a title whose 1000th/1001st units are an emoji's surrogate pair gets cut in
half, producing a lone surrogate. Lone surrogates serialize as U+FFFD or
trigger server-side validation errors depending on the stack — exactly the
"titles longer than 1000 characters" bug class this code was added to fix.

**Fix:** after slicing, drop a trailing high surrogate.

### B4. Saving on non-injectable pages fails completely silently

When the page is injectable but unsupported (e.g. `about:config` typed as a
URL won't be, but a `file://` page may be), the overlay shows a friendly
error. But on pages where Firefox refuses script injection entirely
(`about:*`, `addons.mozilla.org`, reader view, PDF viewer), both injection
attempts throw, the error goes to `console.warn`/`console.error`, and the user
sees *nothing* when tapping the button. On mobile, where there is no devtools
console, this looks like the extension is broken.

**Suggested fix:** fall back to `action.setBadgeText({ text: "!" })` (plus a
title tooltip) for a few seconds, or use the `notifications` API. No new
permissions are needed for the badge route.

### B5. With more than 3 lists, a bookmark can be added to lists but never removed

`renderListPicker()` switches to a `<select>` dropdown when there are more
than 3 lists. The dropdown only ever calls `setListSelection(id, true)` —
there is no UI path to *remove* the bookmark from a list, and re-selecting an
already-selected list silently no-ops. The checkbox mode (≤3 lists) supports
both directions. Also, multi-list membership is invisible in dropdown mode
(only the first selected id is reflected).

**Suggested fix:** always use checkboxes, inside a scrollable container
(`max-height` + `overflow-y: auto`) when the list count is large; optionally
add a filter input above it.

### B6. `cleanupErrorMessage()` rewrites the word "string" anywhere in a message

`.replace(/string/i, "value")` replaces the first occurrence of "string"
*case-insensitively anywhere*, so a server message like `"Connection string
is invalid"` becomes `"Connection value is invalid"`. It also only replaces
the first occurrence, so messages with several Zod `string` mentions come out
half-translated.

**Suggested fix:** anchor the rewrite to the Zod phrasing it targets (e.g.
`/^String must contain/`) or drop the cosmetic rewrite entirely.

### B7. "Test Connection" and "Reload Lists" silently persist settings

Both handlers in `src/options/options.js` call `ext.storage.local.set(settings)`
before talking to the background script, because the background reads settings
from storage. The surprising side effect: pressing *Test Connection* with a
half-edited form **saves** that half-edited form, clobbering known-good
settings even when the test fails. A user who edits the URL, tests, sees a
failure, and closes the page has lost their working configuration.

**Suggested fix:** support an explicit settings override in the
`GET_LISTS` message payload so testing doesn't need to persist, or snapshot
and restore the previous settings when the test fails.

### B8. Legacy `serverUrl` migration is read-only

`getSettings()` (both copies) falls back to the legacy `serverUrl` key but
never writes the migrated value back to `primaryServerUrl`, so the migration
logic must live forever in both files. Writing it back once would let the
fallback be deleted later.

### B9. Fractional auto-dismiss seconds pass validation

`normalizeAutoDismissSeconds()` accepts any finite number in `[1, 60]`, e.g.
`2.5` (the HTML input has `step="1"`, but storage can hold anything that was
set programmatically or via an earlier version). Harmless today since it's
only multiplied by 1000, but `Math.round()` would make the stored shape
predictable.

---

## 2. General issues

### G1. The overlay's list fetch does two sequential round-trips **[implemented]**

`getLists()` in `src/background.js` awaits `lists.list` and then
`lists.getListsOfBookmark`. The two requests are independent — running them
in parallel halves the latency of populating the list picker, which matters
on the flaky local-Wi-Fi connections this extension explicitly targets.

### G2. A failure of `lists.getListsOfBookmark` discards the successful list fetch

If the membership lookup fails after `lists.list` succeeded, the whole picker
shows an error and a Retry button. Degrading gracefully (show the lists,
treat membership as unknown/empty, surface a soft warning) would be friendlier
— though "unknown membership" rendered as unchecked boxes has its own
confusion cost, so this one is a judgment call rather than a clear win.

### G3. Dead code / dead CSS

- `src/content/overlay.css` styles `.button.quiet` and `.success-text`;
  nothing renders those classes.
- `renderListPicker()` builds the `options` string before deciding to render
  checkboxes, wasting the work for ≤3 lists.
- `state.selectedListId` and `state.detail` carry subtly duplicated meaning
  with `selectedListIds` / `listMessage`.

### G4. Three private copies of the same helpers

`normalizeServerUrl`, `normalizePopupPosition`, `normalizeAutoDismissSeconds`,
`validateServerUrl`, `DEFAULT_SETTINGS`, and the `sendMessage` wrapper are
duplicated across `background.js`, `options.js`, and (partially) `overlay.js`.
Without a bundler the practical option is a shared
`src/common.js` loaded ahead of the others (background `scripts` array and a
second `<script>` tag in options). Worth doing before the next behavioral
change to these functions — they have already started drifting (the options
copy of `getSettings()` doesn't trim the token; the background copy does).

### G5. Full innerHTML re-render on every state change

`render()` rebuilds the whole panel and re-binds listeners on each
`setState()`. At this scale it's fine, and the `escapeHtml()` discipline is
consistently applied (good!), but it does reset things like `<select>`
focus/open state mid-interaction. Targeted DOM updates would remove that
class of glitch — only worth it if the overlay grows.

### G6. No CI / no linting

`npm run check` is a syntax check only. A tiny GitHub Actions workflow running
`npm run check` plus `web-ext lint` on PRs would catch manifest mistakes
before they reach a device.

---

## 3. Missing features

### F1. API token visibility toggle in options **[implemented]**

The token field is `type="password"` with no way to verify what you pasted —
on mobile, where paste mishaps are common, a Show/Hide toggle is near
mandatory.

### F2. "Open in Karakeep" link after saving **[implemented]**

After a successful save, the overlay knows the bookmark id and which server
handled the request — one anchor (`{server}/dashboard/preview/{id}`) lets the
user jump straight to the saved bookmark to add tags or notes.

### F3. Tags support

Karakeep's other clients support tagging at save time; Danvers only handles
lists. A tag input (or the same checkbox treatment used for lists) on the
success panel would close the biggest feature gap with the official extension.

### F4. Keyboard shortcut

A `commands` block in the manifest (e.g. `Ctrl+Shift+S` →
`_execute_action` or a custom save command) costs ~6 lines and makes the
desktop-Firefox experience much faster.

### F5. Context menu items

`menus.create({ contexts: ["link"] })` would allow saving a *link target*
without visiting it, and a `"selection"` context could save highlighted text
as a Karakeep text bookmark. (Needs the `menus` permission; mobile Firefox
support varies, but it's pure progressive enhancement.)

### F6. Editable title before/after save

The tab title is sent as-is. A small editable title row on the success panel
(PATCH `bookmarks.updateBookmark`) would cover the common "page title is
garbage" case.

### F7. Light theme

The overlay and options page are hardcoded dark. A
`prefers-color-scheme: light` block would make it look native on light-mode
devices.

### F8. Settings export/import

Self-hosters configure multiple devices; a copyable JSON blob (token
optional) in the options page would save the cross-device retyping ritual.

---

## 4. Novel / delightful ideas

### N1. Undo within the auto-dismiss window

The success panel already has a countdown progress bar. Add an **Undo**
button that calls `bookmarks.deleteBookmark` — the progress bar becomes the
undo window. Accidentally saving a page becomes a non-event instead of a
"open the web app, find it, delete it" chore.

### N2. Duplicate-aware messaging

`alreadyExists` is already detected. Karakeep returns the existing bookmark,
so the overlay could say *"Already saved on May 3"* (from `createdAt`) with
the F2 link — turning a dry dedupe message into a tiny memory aid.

### N3. Offline queue

The target environment is "phone on flaky Wi-Fi". When both servers are
unreachable, offer *"Save when back online"*: persist the pending bookmark in
`storage.local` and flush the queue from the background script's `runtime.onStartup`
/ next invocation. The failover logic already distinguishes network errors
from validation errors (`shouldNotFallback`), so the trigger condition is
already computed.

### N4. Per-domain default list suggestions

Track (locally, in `storage.local`) the last list chosen per hostname. Next
save on that domain pre-highlights it: "youtube.com → 📺 Watch Later" emerges
naturally from usage without any AI or server support.

### N5. Save streak / counter easter egg

A tiny `"42nd save"` footnote in the eyebrow line on round numbers. Zero
functional value, pure delight, ~10 lines.

### N6. Badge as ambient status channel

Beyond the B4 error case: flash `✓` on the action badge when a save
succeeds with the overlay auto-dismissed, so power users can disable the
panel entirely (`showListSelector: false`, `autoDismissSeconds: 1`) and still
get confirmation.

---

## Implementation notes

Implemented items were split into separate PRs that touch disjoint files (or
disjoint regions) to keep them independently revertable and conflict-free:

| PR | Scope | Files |
|----|-------|-------|
| this PR | the review document | `awesome.md` |
| overlay race fixes (B1, B2) | content script | `src/content/overlay.js` |
| background fixes (B3, G1) | background | `src/background.js` |
| token visibility toggle (F1) | options | `src/options/*` |
| open-in-Karakeep link (F2) | content script | `src/content/overlay.js`, `src/content/overlay.css` |

`manifest.json`/`package.json` version bumps were deliberately left out of the
implementation PRs (every PR bumping the version would guarantee conflicts);
bump once after merging.
