# Karakeep Iceraven Inline Extension Plan

## Goal

Build a personal Karakeep browser extension optimized for Iceraven/Firefox Android that saves the current page inline, without opening a popup window or sending Android notifications.

Required behavior:

1. Run on Iceraven.
2. Render inside the current page instead of a separate popup/window.
3. Save the current page URL to Karakeep automatically when activated.
4. Let the user optionally add the saved link to a List.
5. Show clear progress, success, and error messages inline in the page.
6. Avoid Android/browser notifications entirely.

## Existing Implementations Reviewed

### Official Karakeep Extension

Repository: `https://github.com/karakeep-app/karakeep/tree/main/apps/browser-extension`

Key implementation details:

1. Uses Manifest V3 with `action.default_popup: "index.html"`.
2. Uses a background script at `src/background/background.ts`.
3. Uses React, Vite, `@crxjs/vite-plugin`, TanStack Query, and tRPC client helpers.
4. Stores Karakeep settings in `chrome.storage.sync`.
5. Saves bookmarks through `api.bookmarks.createBookmark`.
6. Uses `chrome.storage.session` as a handoff from background/context-menu actions to the popup save page.
7. Supports auto-save through `settings.autoSave` in `SavePage.tsx`.
8. After saving, popup UI allows notes, tags, and lists.
9. The official selector uses `lists.list`, `lists.getListsOfBookmark`, `lists.addToList`, and `lists.removeFromList`.
10. Uses `chrome.action.openPopup()` after context-menu or command activation, which is the part this extension should avoid.

Important reusable API behavior:

1. Create link bookmark payload:

```json
{
  "type": "link",
  "url": "https://example.com",
  "title": "Example",
  "source": "extension"
}
```

2. `bookmarks.createBookmark` returns a bookmark object with `id` and may return `alreadyExists: true`.
3. Add saved bookmark to a List with `lists.addToList` using `{ "bookmarkId": "...", "listId": "..." }`.
4. List available Lists with `lists.list`.
5. List entries include `id`, `name`, `icon`, `parentId`, `type`, and `userRole`.
6. Viewer-only lists should not be shown as selectable targets for adding bookmarks.

### Third-Party `hoarder-firefox` Extension

Repository: `https://github.com/bym0/hoarder-firefox`

Key implementation details:

1. Uses Manifest V2.
2. Uses `browser_action.default_popup: "popup/popup.html"`.
3. Uses `background.js` for shortcut-triggered saving.
4. Uses direct `fetch` calls to Karakeep/Hoarder tRPC HTTP endpoints.
5. Stores URL/token/settings in `browser.storage.local`.
6. Has optional `hoardOnOpen` behavior that saves when the popup opens.
7. Sends success/failure through `browser.notifications.create` when enabled.
8. Does not have inline page UI.
9. Does not support selecting a Karakeep List/List after saving.

Useful takeaway:

1. A small direct-HTTP implementation is feasible without importing Karakeep's monorepo packages.
2. The extension should not copy its popup or notification model because both conflict with the desired mobile inline UX.

## Recommended Architecture

Use a minimal WebExtension with a persistent background script plus an injected content-script overlay.

Preferred shape for Iceraven reliability:

1. Start with Manifest V2 for Firefox Android/Iceraven compatibility unless testing confirms Manifest V3 background service workers and `action.onClicked` are reliable on target Iceraven versions.
2. Use `browser.*` APIs with the `webextension-polyfill` style promise API, or keep a tiny compatibility wrapper that uses `browser` when available and `chrome` otherwise.
3. Do not define `default_popup`. The toolbar/action click should trigger background logic directly.
4. Do not request `notifications` permission.
5. Use `activeTab`, `tabs`, `storage`, and host permissions for the configured Karakeep origin.
6. Inject an overlay content script into the active tab when the extension is activated.
7. Keep all status display inside the content script overlay.
8. Keep API calls in the background script where extension permissions and stored credentials are available.

Proposed files:

```text
manifest.json
src/background.js
src/content/overlay.js
src/content/overlay.css
src/options/options.html
src/options/options.js
icons/
```

If using TypeScript/build tooling:

```text
src/background.ts
src/content/overlay.ts
src/content/overlay.css
src/options/options.html
src/options/options.ts
```

## Activation Flow

1. User taps the extension action in Iceraven.
2. Background script queries the active tab.
3. Background validates the current URL is `http:` or `https:`.
4. Background injects the overlay content script and CSS into the active tab if not already present.
5. Background sends a `SAVE_CURRENT_PAGE` message to the content script with the tab URL/title or a request id.
6. Content script immediately renders inline status: `Saving to Karakeep...`.
7. Content script asks background to create the bookmark.
8. Background reads settings from storage and calls Karakeep.
9. Background returns success or error to the content script.
10. Content script renders success UI and loads selectable Lists.
11. If the user selects a List, content script sends `ADD_TO_LIST` to background.
12. Background calls `lists.addToList`.
13. Content script updates inline status to `Added to List` or shows a clear error.

## Inline Overlay UX

The overlay should be small, touch-friendly, and isolated from page styles.

Recommended behavior:

1. Render a fixed panel near the bottom of the viewport on mobile.
2. Use high `z-index` and a Shadow DOM root to avoid host page CSS conflicts.
3. Include a close button.
4. Auto-save immediately on activation.
5. Keep the panel open after save so the user can optionally choose a List.
6. Auto-dismiss only after a successful save if the user has not interacted, with a short delay such as 4-6 seconds.
7. Do not block the page with a full-screen modal unless an error requires action.

States to render:

1. `Checking configuration...`
2. `Saving link...`
3. `Saved to Karakeep.`
4. `Already saved in Karakeep.` when `alreadyExists` is returned.
5. `Choose List` selector after bookmark id is known.
6. `Loading Lists...`
7. `Adding to List...`
8. `Added to List.`
9. `Karakeep is not configured. Open extension settings.`
10. `This page cannot be saved. Only HTTP/HTTPS pages are supported.`
11. Network/auth/API errors with a concise retry action.

Mobile UI constraints:

1. Minimum tap target height: 44px.
2. Avoid hover-only controls.
3. Use a searchable/selectable list only if the List count is large; otherwise use a simple select/list.
4. Avoid external fonts or remote assets.
5. Account for Android viewport resizing and browser UI by using `position: fixed`, `left/right: 12px`, and bottom safe spacing.

## Karakeep API Plan

The extension can use direct tRPC HTTP calls instead of importing Karakeep's workspace packages.

Settings required:

1. Karakeep server URL, for example `https://cloud.karakeep.app`.
2. API token.
3. Optional default List id.

Normalize server URL:

1. Trim whitespace.
2. Remove trailing slashes.
3. Require `https:` by default, but allow `http:` for explicitly configured local/self-hosted instances if desired.

Create bookmark endpoint:

```text
POST {server}/api/trpc/bookmarks.createBookmark?batch=1
Authorization: Bearer {apiToken}
Content-Type: application/json
```

Body:

```json
{
  "0": {
    "json": {
      "type": "link",
      "url": "https://example.com",
      "title": "Example title",
      "source": "extension"
    }
  }
}
```

List Lists endpoint:

```text
GET or POST {server}/api/trpc/lists.list?batch=1
Authorization: Bearer {apiToken}
```

Add bookmark to List endpoint:

```text
POST {server}/api/trpc/lists.addToList?batch=1
Authorization: Bearer {apiToken}
Content-Type: application/json
```

Body:

```json
{
  "0": {
    "json": {
      "bookmarkId": "bookmark-id",
      "listId": "list-id"
    }
  }
}
```

Implementation note:

1. Verify exact tRPC response shapes against the current Karakeep version during implementation.
2. Treat Lists as the user-facing label but map them to Karakeep Lists internally.
3. Build List display paths from `parentId` so nested lists appear as `Parent / Child`.
4. Filter out `userRole: "viewer"` and `userRole: "public"` because they cannot be modified.
5. If `bookmarks.createBookmark` returns an existing bookmark, still allow adding that returned bookmark id to a List.

## Message Protocol

Use explicit typed message names even in plain JavaScript.

Background receives:

```text
CREATE_BOOKMARK
GET_LISTS
ADD_TO_LIST
OPEN_OPTIONS
```

Content script receives:

```text
SHOW_OVERLAY
SAVE_STARTED
SAVE_SUCCESS
SAVE_ERROR
LISTS_SUCCESS
LISTS_ERROR
ADD_LIST_SUCCESS
ADD_LIST_ERROR
```

Each request should include a request id so stale responses do not overwrite newer UI state.

## Options Page

Use an extension options page for configuration because the save flow itself should stay inline and fast.

Fields:

1. Karakeep server URL.
2. API token.
3. Test connection button.
4. Optional default List.
5. Optional setting: show List selector after each save.
6. Optional setting: auto-dismiss success panel.

Storage:

1. Use `browser.storage.local` for Iceraven reliability.
2. Store only the server URL, API token, and preferences.
3. Do not store transient bookmark payloads unless needed for retry.

## Permissions

Manifest V2 baseline:

```json
{
  "manifest_version": 2,
  "permissions": ["activeTab", "tabs", "storage", "<all_urls>"],
  "browser_action": {
    "default_icon": "icons/icon-48.png",
    "default_title": "Save to Karakeep"
  },
  "background": {
    "scripts": ["src/background.js"]
  },
  "options_ui": {
    "page": "src/options/options.html",
    "open_in_tab": true
  }
}
```

Permission notes:

1. Prefer `activeTab` for injection into the current page after user activation.
2. Avoid `notifications` completely.
3. Avoid `bookmarks` unless importing browser bookmarks becomes a future requirement.
4. If direct API requests fail due to host permissions, request or declare host permission for the configured Karakeep origin.
5. For a personal extension, `<all_urls>` may be acceptable, but a narrower permission model is preferable if Iceraven allows it.

Manifest V3 alternative:

1. Use `action` without `default_popup`.
2. Use `background.service_worker`.
3. Use `scripting.executeScript` and `scripting.insertCSS`.
4. Test carefully on Iceraven before committing to MV3 because Firefox Android/Iceraven behavior can differ from desktop Firefox.

## Error Handling

Handle these cases explicitly in the overlay:

1. Extension not configured.
2. Invalid Karakeep URL.
3. Missing API token.
4. Current tab has no URL.
5. Current URL is not HTTP/HTTPS.
6. Content script injection blocked by browser page, extension page, PDF viewer, `about:*`, or restricted domain.
7. Network timeout.
8. Unauthorized API token.
9. Karakeep server returns validation error.
10. Bookmark saved but List add failed.
11. List loading fails.

Retry behavior:

1. `Retry save` should re-run create bookmark.
2. `Retry Lists` should reload Lists without re-saving the bookmark.
3. `Open Settings` should open the options page.
4. If save succeeded but List add failed, keep the bookmark id in overlay state so retry only repeats `lists.addToList`.

## Implementation Phases

### Phase 1: Minimal Inline Save

1. Create base extension manifest without popup and without notifications.
2. Add options page for server URL and API token.
3. Add background action click handler.
4. Inject content overlay into the active tab.
5. Save current page automatically through `bookmarks.createBookmark`.
6. Render inline saving/success/error states.

### Phase 2: Lists

1. Fetch Karakeep Lists after a bookmark is saved.
2. Render them as Lists in the overlay.
3. Support nested path labels.
4. Filter non-editable Lists.
5. Add selected List through `lists.addToList`.
6. Show success/error inline.

### Phase 3: Mobile Hardening

1. Test on Iceraven with real action button activation.
2. Test content-script injection on common pages.
3. Make overlay resilient to page CSS with Shadow DOM.
4. Tune touch targets and viewport positioning.
5. Add timeouts around API calls.
6. Verify no Android notifications are requested or sent.

### Phase 4: Packaging

1. Build unsigned temporary package for manual Iceraven testing.
2. Document install steps for Iceraven.
3. Add release packaging command.
4. If publishing, validate against AMO requirements.

## Verification Checklist

Desktop Firefox smoke tests:

1. Open options page and save server/token.
2. Click extension action on an HTTP page.
3. Confirm overlay appears in the same page.
4. Confirm bookmark is created in Karakeep.
5. Confirm duplicate save reports success or already-saved state.
6. Confirm Lists load.
7. Confirm selecting a List adds the bookmark.
8. Confirm no popup opens.
9. Confirm no notification permission is requested.

Iceraven tests:

1. Install extension.
2. Configure server/token.
3. Save a normal web page.
4. Save a page with a long title and URL.
5. Save on slow network.
6. Add to List.
7. Rotate screen or resize viewport while overlay is visible.
8. Close overlay manually.
9. Test an unsupported page such as `about:` and verify clear inline or fallback error behavior.
10. Confirm there are no Android notifications.

Karakeep API tests:

1. Valid API token.
2. Invalid API token.
3. Self-hosted URL with trailing slash.
4. Server unavailable.
5. User with no Lists.
6. User with nested Lists.
7. User with viewer-only shared Lists.

## Open Decisions

1. Manifest V2 or V3 after Iceraven compatibility testing.
2. Whether to allow `http:` Karakeep server URLs for local/self-hosted instances.
3. Whether List selection should always appear after save or only behind a setting.
4. Whether to support a default List that is applied automatically.
5. Whether to implement with no build step or with TypeScript/Vite.

## Non-Goals For First Version

1. No browser bookmark import.
2. No Android/browser notifications.
3. No popup save UI.
4. No SingleFile page capture.
5. No tags or notes unless added later.
6. No context-menu support unless toolbar activation works well first.
