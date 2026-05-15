(function () {
  "use strict";

  if (window.__danversKarakeepOverlayLoaded) {
    throw new Error("Danvers Karakeep overlay already loaded");
  }
  window.__danversKarakeepOverlayLoaded = true;

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const HOST_ID = "danvers-karakeep-overlay-host";
  const DEFAULT_AUTO_DISMISS_SECONDS = 5;
  const FADE_OUT_MS = 180;
  const state = {
    requestId: "",
    url: "",
    title: "",
    status: "idle",
    detail: "",
    error: "",
    bookmark: null,
    alreadyExists: false,
    lists: [],
    listsLoaded: false,
    listsLoading: false,
    selectedListId: "",
    selectedListIds: [],
    updatingListIds: [],
    listMessage: "",
    listError: "",
    showListSelector: true,
    autoDismiss: true,
    autoDismissMs: DEFAULT_AUTO_DISMISS_SECONDS * 1000,
    defaultListId: "",
    popupPosition: "bottom-right",
    interacted: false,
    dismissTimer: null,
    dismissStartedAt: 0,
  };

  let host = null;
  let shadow = null;

  ext.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "SHOW_OVERLAY") {
      return undefined;
    }

    showOverlay(message.payload || {});
    return Promise.resolve({ ok: true });
  });

  function showOverlay(payload) {
    ensureOverlay();
    clearDismissTimer();

    state.requestId = payload.requestId || `${Date.now()}`;
    state.url = payload.url || window.location.href;
    state.title = payload.title || document.title;
    state.popupPosition = normalizePopupPosition(payload.popupPosition);
    applyHostPosition();
    state.status = payload.immediateError ? "error" : "saving";
    state.detail = "";
    state.error = payload.immediateError || "";
    state.bookmark = null;
    state.alreadyExists = false;
    state.lists = [];
    state.listsLoaded = false;
    state.listsLoading = false;
    state.selectedListId = "";
    state.selectedListIds = [];
    state.updatingListIds = [];
    state.listMessage = "";
    state.listError = "";
    state.interacted = false;
    state.dismissStartedAt = 0;

    render();

    if (!payload.immediateError) {
      saveCurrentPage(state.requestId);
    }
  }

  async function saveCurrentPage(requestId) {
    setState({ status: "saving", detail: "Saving link...", error: "" });

    const response = await sendMessage({
      type: "CREATE_BOOKMARK",
      payload: {
        requestId,
        url: state.url,
        title: state.title,
      },
    });

    if (requestId !== state.requestId) {
      return;
    }

    if (!response || !response.ok) {
      setState({
        status: "error",
        error: response && response.error ? response.error : "Failed to save link.",
        detail: "",
      });
      return;
    }

    const preferences = response.preferences || {};
    const autoListResult = response.autoListResult || null;
    const serverDetail = response.server ? ` via ${response.server.label}` : "";
    const baseDetail = response.alreadyExists
      ? `Already saved in Karakeep${serverDetail}.`
      : `Saved to Karakeep${serverDetail}.`;
    const autoListError =
      autoListResult && !autoListResult.ok
        ? `Default List failed: ${autoListResult.message}`
        : "";
    setState({
      status: "success",
      detail: autoListError ? `${baseDetail} ${autoListError}` : baseDetail,
      bookmark: response.bookmark,
      alreadyExists: Boolean(response.alreadyExists),
      showListSelector: preferences.showListSelector !== false,
      autoDismiss: preferences.autoDismiss !== false,
      autoDismissMs: normalizeAutoDismissMs(preferences.autoDismissSeconds),
      defaultListId: preferences.defaultListId || "",
      listMessage:
        autoListResult && autoListResult.ok
          ? `Added to default List via ${autoListResult.serverLabel}.`
          : "",
      listError: autoListError,
    });

    scheduleDismiss();

    if (state.showListSelector) {
      loadLists(requestId);
    }
  }

  async function loadLists(requestId) {
    if (!state.bookmark || state.listsLoading) {
      return;
    }

    setState({ listsLoading: true, listError: "", listMessage: state.listMessage });
    const response = await sendMessage({
      type: "GET_LISTS",
      payload: { bookmarkId: state.bookmark.id },
    });

    if (requestId !== state.requestId) {
      return;
    }

    if (!response || !response.ok) {
      setState({
        listsLoading: false,
        listsLoaded: true,
        listError: response && response.error ? response.error : "Could not load Lists.",
      });
      return;
    }

    setState({
      lists: Array.isArray(response.lists) ? response.lists : [],
      selectedListIds: Array.isArray(response.selectedListIds)
        ? response.selectedListIds
        : [],
      listsLoading: false,
      listsLoaded: true,
    });

    scheduleDismiss();
  }

  async function setListSelection(listId, selected) {
    if (!state.bookmark || !listId || state.updatingListIds.includes(listId)) {
      return;
    }

    if (selected && state.selectedListIds.includes(listId)) {
      return;
    }

    if (!selected && !state.selectedListIds.includes(listId)) {
      return;
    }

    state.interacted = true;
    clearDismissTimer();
    const selectedList = state.lists.find((list) => list.id === listId);
    setState({
      updatingListIds: [...state.updatingListIds, listId],
      listError: "",
      listMessage: selected ? "Adding to List..." : "Removing from List...",
    });

    const response = await sendMessage({
      type: selected ? "ADD_TO_LIST" : "REMOVE_FROM_LIST",
      payload: {
        bookmarkId: state.bookmark.id,
        listId,
      },
    });

    if (!response || !response.ok) {
      setState({
        updatingListIds: state.updatingListIds.filter((id) => id !== listId),
        listMessage: "",
        listError: response && response.error ? response.error : "Could not update List.",
      });
      return;
    }

    const selectedListIds = selected
      ? [...new Set([...state.selectedListIds, listId])]
      : state.selectedListIds.filter((id) => id !== listId);

    setState({
      selectedListIds,
      selectedListId: selected ? listId : "",
      updatingListIds: state.updatingListIds.filter((id) => id !== listId),
      listMessage: selected
        ? `Added to ${selectedList ? selectedList.path : "List"}${response.server ? ` via ${response.server.label}` : ""}.`
        : `Removed from ${selectedList ? selectedList.path : "List"}${response.server ? ` via ${response.server.label}` : ""}.`,
      listError: "",
    });
    scheduleDismiss();
  }

  function ensureOverlay() {
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
    }

    if (!shadow || shadow.host !== host) {
      shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    }
    applyHostPosition();
  }

  function render() {
    if (!shadow) {
      return;
    }

    const title = state.status === "error" ? "Karakeep save failed" : "Save to Karakeep";
    const statusClass = state.status === "error" ? "danger" : state.status === "success" ? "success" : "saving";
    const statusText = state.status === "saving" ? state.detail || "Saving link..." : state.status === "success" ? state.detail : state.error;

    shadow.innerHTML = `
      <style>${styles()}</style>
      <section class="panel" role="status" aria-live="polite">
        ${renderDismissProgress()}
        <div class="header">
          <div>
            <div class="eyebrow">Karakeep</div>
            <div class="title">${escapeHtml(title)}</div>
          </div>
          <div class="header-actions">
            <button class="icon-button" type="button" data-action="options" aria-label="Settings">⚙</button>
            <button class="icon-button" type="button" data-action="close" aria-label="Close">×</button>
          </div>
        </div>
        <div class="status ${statusClass}">
          ${state.status === "saving" ? '<span class="spinner" aria-hidden="true"></span>' : ""}
          <span>${escapeHtml(statusText || "Working...")}</span>
        </div>
        ${renderUrl()}
        ${renderActions()}
        ${renderLists()}
      </section>
    `;

    bindEvents();
  }

  function renderDismissProgress() {
    if (state.status !== "success" || state.listError || !state.dismissStartedAt) {
      return "";
    }

    const elapsed = Math.max(0, Date.now() - state.dismissStartedAt);
    const progress = Math.min(100, (elapsed / state.autoDismissMs) * 100);
    const remaining = Math.max(1, state.autoDismissMs - elapsed);

    return `<div class="dismiss-progress" aria-hidden="true"><div class="dismiss-progress-bar" style="width: ${progress}%; animation-duration: ${remaining}ms;"></div></div>`;
  }

  function renderUrl() {
    if (!state.url) {
      return "";
    }
    return `<div class="url" title="${escapeHtml(state.url)}">${escapeHtml(state.url)}</div>`;
  }

  function renderActions() {
    if (state.status === "error") {
      return `
        <div class="actions">
          <button class="button primary" type="button" data-action="retry-save">Retry save</button>
        </div>
      `;
    }

    return "";
  }

  function renderLists() {
    if (state.status !== "success" || !state.bookmark || !state.showListSelector) {
      return "";
    }

    if (state.listsLoading) {
      return `<div class="list-box muted"><span class="spinner" aria-hidden="true"></span><span>Loading Lists...</span></div>`;
    }

    if (state.listError) {
      return `
        <div class="list-box error">
          <div>${escapeHtml(state.listError)}</div>
          <button class="button" type="button" data-action="retry-lists">Retry Lists</button>
        </div>
      `;
    }

    if (state.listMessage) {
      return `<div class="list-box success-text">${escapeHtml(state.listMessage)}</div>${renderListPicker()}`;
    }

    return renderListPicker();
  }

  function renderListPicker() {
    if (!state.listsLoaded) {
      return "";
    }

    if (state.lists.length === 0) {
      return `<div class="list-box muted">No editable Lists found.</div>`;
    }

    const selectedDropdownListId = state.selectedListId || state.selectedListIds[0] || "";
    const options = state.lists
      .map((list) => {
        const selected = list.id === selectedDropdownListId ? " selected" : "";
        return `<option value="${escapeHtml(list.id)}"${selected}>${escapeHtml(list.path)}</option>`;
      })
      .join("");

    if (state.lists.length <= 3) {
      return renderListCheckboxes();
    }

    return renderListDropdown(options);
  }

  function renderListCheckboxes() {
    const items = state.lists
      .map((list) => {
        const checked = state.selectedListIds.includes(list.id) ? " checked" : "";
        const disabled = state.updatingListIds.includes(list.id) ? " disabled" : "";
        return `
          <label class="list-check-row">
            <input type="checkbox" value="${escapeHtml(list.id)}" data-action="toggle-list"${checked}${disabled}>
            <span>${escapeHtml(list.path)}</span>
          </label>
        `;
      })
      .join("");

    return `
      <div class="list-box">
        <div class="label">Optional Lists</div>
        <div class="list-checks">${items}</div>
      </div>
    `;
  }

  function renderListDropdown(options) {
    return `
      <div class="list-box">
        <label class="label" for="danvers-list-select">Optional List</label>
        <select id="danvers-list-select" class="select" data-action="select-list">
          <option value="">Choose List...</option>
          ${options}
        </select>
      </div>
    `;
  }

  function bindEvents() {
    const panel = shadow.querySelector(".panel");
    if (panel) {
      panel.addEventListener("pointerdown", cancelDismissFromInteraction);
      panel.addEventListener("click", cancelDismissFromInteraction);
    }

    const closeButtons = shadow.querySelectorAll('[data-action="close"]');
    closeButtons.forEach((button) => button.addEventListener("click", closeOverlay));

    const retrySave = shadow.querySelector('[data-action="retry-save"]');
    if (retrySave) {
      retrySave.addEventListener("click", () => {
        state.interacted = true;
        clearDismissTimer();
        saveCurrentPage(state.requestId);
      });
    }

    const retryLists = shadow.querySelector('[data-action="retry-lists"]');
    if (retryLists) {
      retryLists.addEventListener("click", () => {
        state.interacted = true;
        loadLists(state.requestId);
      });
    }

    const optionsButton = shadow.querySelector('[data-action="options"]');
    if (optionsButton) {
      optionsButton.addEventListener("click", () => {
        state.interacted = true;
        sendMessage({ type: "OPEN_OPTIONS" });
      });
    }

    const select = shadow.querySelector('[data-action="select-list"]');
    if (select) {
      select.addEventListener("change", (event) => {
        state.interacted = true;
        setState({ selectedListId: event.target.value, listMessage: "", listError: "" });
        if (event.target.value) {
          setListSelection(event.target.value, true);
        }
      });
    }

    const listToggles = shadow.querySelectorAll('[data-action="toggle-list"]');
    listToggles.forEach((toggle) => {
      toggle.addEventListener("change", (event) => {
        setListSelection(event.target.value, event.target.checked);
      });
    });
  }

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  function closeOverlay() {
    clearDismissTimer();
    if (host) {
      host.remove();
    }
    host = null;
    shadow = null;
  }

  function cancelDismissFromInteraction() {
    if (state.dismissTimer) {
      state.interacted = true;
      clearDismissTimer();
      const progress = shadow && shadow.querySelector(".dismiss-progress");
      if (progress) {
        progress.remove();
      }
    }
  }

  function fadeOutAndCloseOverlay() {
    if (!host) {
      return;
    }
    host.dataset.closing = "true";
    setTimeout(closeOverlay, FADE_OUT_MS);
  }

  function normalizePopupPosition(position) {
    if (
      position === "top-left" ||
      position === "top-right" ||
      position === "bottom-left" ||
      position === "bottom-right"
    ) {
      return position;
    }
    return "bottom-right";
  }

  function applyHostPosition() {
    if (host) {
      host.dataset.position = state.popupPosition;
    }
  }

  function scheduleDismiss() {
    if (
      !state.autoDismiss ||
      state.status !== "success" ||
      state.listError ||
      state.dismissTimer
    ) {
      return;
    }

    state.dismissStartedAt = Date.now();
    state.dismissTimer = setTimeout(() => {
      fadeOutAndCloseOverlay();
    }, state.autoDismissMs);
    render();
  }

  function clearDismissTimer() {
    if (state.dismissTimer) {
      clearTimeout(state.dismissTimer);
      state.dismissTimer = null;
    }
    state.dismissStartedAt = 0;
    if (host) {
      delete host.dataset.closing;
    }
  }

  function sendMessage(message) {
    return ext.runtime.sendMessage(message).catch((error) => ({
      ok: false,
      error: error && error.message ? error.message : String(error),
    }));
  }

  function normalizeAutoDismissMs(value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 60) {
      return seconds * 1000;
    }
    return DEFAULT_AUTO_DISMISS_SECONDS * 1000;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function styles() {
    return `
      :host {
        all: initial;
        color-scheme: dark;
        pointer-events: auto;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * {
        box-sizing: border-box;
      }
      :host([data-closing="true"]) .panel {
        animation: fade-out ${FADE_OUT_MS}ms ease forwards;
      }
      .panel {
        position: relative;
        width: 100%;
        max-width: 420px;
        margin: 0 auto;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 18px;
        background: rgba(18, 20, 26, 0.96);
        box-shadow: 0 18px 45px rgba(0, 0, 0, 0.4);
        color: #f7f7fb;
        overflow: hidden;
        backdrop-filter: blur(14px);
      }
      .dismiss-progress {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 4px;
        background: rgba(255, 255, 255, 0.08);
        overflow: hidden;
      }
      .dismiss-progress-bar {
        height: 100%;
        background: #5ff0a8;
        animation-name: dismiss-progress;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
      }
      .header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 16px 10px;
      }
      .header-actions {
        display: flex;
        flex: 0 0 auto;
        gap: 8px;
      }
      .eyebrow {
        color: #9fa8bd;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .title {
        margin-top: 2px;
        font-size: 18px;
        font-weight: 750;
        line-height: 1.2;
      }
      .icon-button {
        min-width: 44px;
        min-height: 44px;
        border: 0;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        color: #f7f7fb;
        font: inherit;
        font-size: 20px;
        line-height: 1;
      }
      .status {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 0 16px 12px;
        padding: 12px;
        border-radius: 14px;
        font-size: 15px;
        line-height: 1.35;
      }
      .status.saving {
        background: rgba(105, 117, 255, 0.16);
        color: #dfe3ff;
      }
      .status.success {
        background: rgba(43, 184, 116, 0.16);
        color: #c9f7df;
      }
      .status.danger {
        background: rgba(255, 91, 91, 0.16);
        color: #ffd1d1;
      }
      .spinner {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        border: 2px solid rgba(255, 255, 255, 0.25);
        border-top-color: #ffffff;
        border-radius: 999px;
        animation: spin 0.8s linear infinite;
      }
      .url {
        margin: 0 16px 12px;
        color: #aeb6c8;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .actions {
        display: flex;
        gap: 8px;
        padding: 0 16px 14px;
      }
      .button,
      .select {
        min-height: 44px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.08);
        color: #f7f7fb;
        font: inherit;
        font-size: 14px;
      }
      .button {
        padding: 0 14px;
        font-weight: 700;
      }
      .button.primary {
        border-color: rgba(112, 122, 255, 0.85);
        background: #707aff;
        color: #ffffff;
      }
      .button.quiet {
        margin-left: auto;
      }
      .button:disabled {
        opacity: 0.55;
      }
      .list-box {
        margin: 0 16px 16px;
        padding: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.06);
        color: #f7f7fb;
        font-size: 14px;
      }
      .list-box.muted {
        display: flex;
        align-items: center;
        gap: 10px;
        color: #aeb6c8;
      }
      .list-box.error {
        color: #ffd1d1;
      }
      .success-text {
        color: #c9f7df;
      }
      .label {
        display: block;
        margin-bottom: 8px;
        color: #aeb6c8;
        font-size: 12px;
        font-weight: 750;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .list-checks {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .list-check-row {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
      }
      .list-check-row input {
        width: 20px;
        height: 20px;
        flex: 0 0 auto;
        accent-color: #707aff;
      }
      .list-check-row span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .select {
        min-width: 0;
        flex: 1;
        padding: 0 10px;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      @keyframes dismiss-progress {
        to { width: 100%; }
      }
      @keyframes fade-out {
        from {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        to {
          opacity: 0;
          transform: translateY(6px) scale(0.98);
        }
      }
      @media (max-width: 360px) {
        .actions {
          flex-direction: column;
        }
        .button.quiet {
          margin-left: 0;
        }
      }
    `;
  }
})();
