(function () {
  "use strict";

  if (window.__danversKarakeepOverlayLoaded) {
    return;
  }
  window.__danversKarakeepOverlayLoaded = true;

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const HOST_ID = "danvers-karakeep-overlay-host";
  const ROOT_CLASS = "danvers-karakeep-overlay-root";
  const STYLE_ID = "danvers-karakeep-overlay-style";
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
    serverUrl: "",
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
    overlayCss: "",
  };

  let host = null;
  let shadowRoot = null;
  let overlayRoot = null;

  window.__danversKarakeepOverlayApi = { show: showOverlay };

  function showOverlay(payload) {
    state.overlayCss = typeof payload.overlayCss === "string" ? payload.overlayCss : state.overlayCss;
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
    state.serverUrl = "";
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
      serverUrl: response.server && response.server.url ? response.server.url : "",
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
    if (host && !host.shadowRoot) {
      host.remove();
      host = null;
    }

    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
    }

    shadowRoot = host.shadowRoot || host.attachShadow({ mode: "open" });
    ensureShadowStyle();
    overlayRoot = shadowRoot.querySelector(`.${ROOT_CLASS}`);
    if (!overlayRoot) {
      overlayRoot = document.createElement("div");
      overlayRoot.className = ROOT_CLASS;
      shadowRoot.appendChild(overlayRoot);
    }

    applyHostPosition();
  }

  function ensureShadowStyle() {
    if (!shadowRoot) {
      return;
    }

    let style = shadowRoot.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      shadowRoot.prepend(style);
    }

    const css = getShadowCss(state.overlayCss);
    if (style.textContent !== css) {
      style.textContent = css;
    }
  }

  function getShadowCss(css) {
    let shadowCss = String(css || "");
    shadowCss = replaceAllText(
      shadowCss,
      `#${HOST_ID}[data-closing="true"]`,
      ':host([data-closing="true"])',
    );
    shadowCss = replaceAllText(
      shadowCss,
      `#${HOST_ID}[data-position="top-left"]`,
      ':host([data-position="top-left"])',
    );
    shadowCss = replaceAllText(
      shadowCss,
      `#${HOST_ID}[data-position="top-right"]`,
      ':host([data-position="top-right"])',
    );
    shadowCss = replaceAllText(
      shadowCss,
      `#${HOST_ID}[data-position="bottom-left"]`,
      ':host([data-position="bottom-left"])',
    );
    shadowCss = replaceAllText(
      shadowCss,
      `#${HOST_ID}[data-position="bottom-right"]`,
      ':host([data-position="bottom-right"])',
    );
    return replaceAllText(shadowCss, `#${HOST_ID}`, ":host");
  }

  function replaceAllText(value, search, replacement) {
    return value.split(search).join(replacement);
  }

  function render() {
    if (!overlayRoot) {
      return;
    }

    const title = state.status === "error" ? "Karakeep save failed" : "Save to Karakeep";
    const statusClass = state.status === "error" ? "danger" : state.status === "success" ? "success" : "saving";
    const statusText = getStatusText();

    overlayRoot.innerHTML = `
      <section class="panel" role="status" aria-live="polite">
        ${renderDismissProgress()}
        <div class="header">
          <div class="header-copy">
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
    syncDismissProgress();
  }

  function getStatusText() {
    if (state.status === "saving") {
      return state.detail || "Saving link...";
    }

    if (state.status === "success") {
      return state.listMessage || state.detail;
    }

    return state.error;
  }

  function renderDismissProgress() {
    if (state.status !== "success" || state.listError || !state.dismissStartedAt) {
      return "";
    }

    return `<div class="dismiss-progress" aria-hidden="true"><div class="dismiss-progress-bar"></div></div>`;
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

    if (state.status === "success" && state.bookmark && state.serverUrl) {
      const href = `${state.serverUrl}/dashboard/preview/${encodeURIComponent(state.bookmark.id)}`;
      return `
        <div class="actions">
          <a class="button" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open in Karakeep</a>
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
            <input class="list-check-input" type="checkbox" value="${escapeHtml(list.id)}" data-action="toggle-list"${checked}${disabled}>
            <span class="list-check-mark" aria-hidden="true"></span>
            <span class="list-check-text">${escapeHtml(list.path)}</span>
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
    const panel = overlayRoot.querySelector(".panel");
    if (panel) {
      panel.addEventListener("pointerdown", cancelDismissFromInteraction);
      panel.addEventListener("click", cancelDismissFromInteraction);
    }

    const closeButtons = overlayRoot.querySelectorAll('[data-action="close"]');
    closeButtons.forEach((button) => button.addEventListener("click", closeOverlay));

    const retrySave = overlayRoot.querySelector('[data-action="retry-save"]');
    if (retrySave) {
      retrySave.addEventListener("click", () => {
        state.interacted = true;
        clearDismissTimer();
        saveCurrentPage(state.requestId);
      });
    }

    const retryLists = overlayRoot.querySelector('[data-action="retry-lists"]');
    if (retryLists) {
      retryLists.addEventListener("click", () => {
        state.interacted = true;
        loadLists(state.requestId);
      });
    }

    const optionsButton = overlayRoot.querySelector('[data-action="options"]');
    if (optionsButton) {
      optionsButton.addEventListener("click", () => {
        state.interacted = true;
        sendMessage({ type: "OPEN_OPTIONS" });
      });
    }

    const select = overlayRoot.querySelector('[data-action="select-list"]');
    if (select) {
      select.addEventListener("change", (event) => {
        state.interacted = true;
        setState({ selectedListId: event.target.value, listMessage: "", listError: "" });
        if (event.target.value) {
          setListSelection(event.target.value, true);
        }
      });
    }

    const listToggles = overlayRoot.querySelectorAll('[data-action="toggle-list"]');
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
    shadowRoot = null;
    overlayRoot = null;
  }

  function cancelDismissFromInteraction() {
    if (state.dismissTimer) {
      state.interacted = true;
      clearDismissTimer();
      const progress = overlayRoot && overlayRoot.querySelector(".dismiss-progress");
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

  function syncDismissProgress() {
    const bar = overlayRoot && overlayRoot.querySelector(".dismiss-progress-bar");
    if (!bar || !state.dismissStartedAt) {
      return;
    }

    const elapsed = Math.max(0, Date.now() - state.dismissStartedAt);
    const progress = Math.min(1, elapsed / state.autoDismissMs);
    const remaining = Math.max(1, state.autoDismissMs - elapsed);

    if (typeof bar.animate !== "function") {
      bar.classList.add("complete");
      return;
    }

    bar.animate(
      [{ transform: `scaleX(${progress})` }, { transform: "scaleX(1)" }],
      { duration: remaining, easing: "linear", fill: "forwards" }
    );
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

})();
