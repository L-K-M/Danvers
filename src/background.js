(function () {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULT_SETTINGS = {
    serverUrl: "https://cloud.karakeep.app",
    apiToken: "",
    defaultListId: "",
    showListSelector: true,
    autoDismiss: true,
    allowHttp: false,
  };
  const SAVE_TIMEOUT_MS = 30000;
  const LIST_TIMEOUT_MS = 20000;
  const CONTENT_SCRIPT_PATH = "src/content/overlay.js";
  const CONTENT_CSS_PATH = "src/content/overlay.css";

  const actionApi = ext.action || ext.browserAction;

  actionApi.onClicked.addListener(async (tab) => {
    await activateForTab(tab);
  });

  ext.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message.type !== "string") {
      return undefined;
    }

    if (message.type === "CREATE_BOOKMARK") {
      return createBookmark(message.payload, sender);
    }

    if (message.type === "GET_LISTS") {
      return getLists();
    }

    if (message.type === "ADD_TO_LIST") {
      return addToList(message.payload);
    }

    if (message.type === "OPEN_OPTIONS") {
      return openOptions();
    }

    if (message.type === "GET_SETTINGS_SUMMARY") {
      return getSettingsSummary();
    }

    return undefined;
  });

  async function activateForTab(clickedTab) {
    const tab = clickedTab && typeof clickedTab.id === "number" ? clickedTab : await getActiveTab();
    if (!tab || typeof tab.id !== "number") {
      return;
    }

    const requestId = createRequestId();
    const payload = {
      requestId,
      url: tab.url || "",
      title: tab.title || "",
    };

    if (!isHttpPageUrl(payload.url)) {
      try {
        await injectOverlay(tab.id);
        await ext.tabs.sendMessage(tab.id, {
          type: "SHOW_OVERLAY",
          payload: {
            ...payload,
            immediateError:
              "This page cannot be saved. Only HTTP/HTTPS pages are supported.",
          },
        });
      } catch (error) {
        console.warn("Unable to show overlay on unsupported page:", error);
      }
      return;
    }

    try {
      await injectOverlay(tab.id);
      await ext.tabs.sendMessage(tab.id, {
        type: "SHOW_OVERLAY",
        payload,
      });
    } catch (error) {
      console.error("Failed to inject Karakeep overlay:", error);
    }
  }

  async function getActiveTab() {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  async function injectOverlay(tabId) {
    try {
      if (ext.scripting && ext.scripting.insertCSS) {
        await ext.scripting.insertCSS({
          target: { tabId },
          files: [CONTENT_CSS_PATH],
        });
      } else {
        await ext.tabs.insertCSS(tabId, { file: CONTENT_CSS_PATH });
      }
    } catch (error) {
      console.warn("Overlay CSS injection failed:", error);
    }

    try {
      if (ext.scripting && ext.scripting.executeScript) {
        await ext.scripting.executeScript({
          target: { tabId },
          files: [CONTENT_SCRIPT_PATH],
        });
      } else {
        await ext.tabs.executeScript(tabId, { file: CONTENT_SCRIPT_PATH });
      }
    } catch (error) {
      if (!isAlreadyInjectedError(error)) {
        throw error;
      }
    }
  }

  function isAlreadyInjectedError(error) {
    const message = error && error.message ? error.message : String(error);
    return /danvers karakeep overlay already loaded/i.test(message);
  }

  async function createBookmark(payload, sender) {
    try {
      const settings = await getSettings();
      ensureConfigured(settings);

      const tabUrl = payload && payload.url ? payload.url : sender.tab && sender.tab.url;
      const title = payload && payload.title ? payload.title : sender.tab && sender.tab.title;

      if (!isHttpPageUrl(tabUrl)) {
        throw userError("This page cannot be saved. Only HTTP/HTTPS pages are supported.");
      }

      const bookmark = await karakeepRequest(
        settings,
        "bookmarks.createBookmark",
        {
          type: "link",
          url: tabUrl,
          title: title || undefined,
          source: "extension",
        },
        SAVE_TIMEOUT_MS,
      );

      if (!bookmark || !bookmark.id) {
        throw userError("Karakeep saved the link but returned an unexpected response.");
      }

      let autoListResult = null;
      if (settings.defaultListId) {
        try {
          await karakeepRequest(
            settings,
            "lists.addToList",
            { bookmarkId: bookmark.id, listId: settings.defaultListId },
            LIST_TIMEOUT_MS,
          );
          autoListResult = { ok: true, listId: settings.defaultListId };
        } catch (error) {
          autoListResult = { ok: false, message: normalizeErrorMessage(error) };
        }
      }

      return {
        ok: true,
        bookmark,
        alreadyExists: Boolean(bookmark.alreadyExists),
        preferences: {
          showListSelector: settings.showListSelector,
          autoDismiss: settings.autoDismiss,
          defaultListId: settings.defaultListId,
        },
        autoListResult,
      };
    } catch (error) {
      return { ok: false, error: normalizeErrorMessage(error) };
    }
  }

  async function getLists() {
    try {
      const settings = await getSettings();
      ensureConfigured(settings);

      const result = await karakeepRequest(
        settings,
        "lists.list",
        undefined,
        LIST_TIMEOUT_MS,
        "GET",
      );
      const lists = Array.isArray(result.lists) ? result.lists : [];
      const editableLists = buildListPaths(lists).filter(
        (list) => list.userRole !== "viewer" && list.userRole !== "public",
      );

      return { ok: true, lists: editableLists };
    } catch (error) {
      return { ok: false, error: normalizeErrorMessage(error) };
    }
  }

  async function addToList(payload) {
    try {
      if (!payload || !payload.bookmarkId || !payload.listId) {
        throw userError("Missing bookmark or List id.");
      }

      const settings = await getSettings();
      ensureConfigured(settings);

      await karakeepRequest(
        settings,
        "lists.addToList",
        { bookmarkId: payload.bookmarkId, listId: payload.listId },
        LIST_TIMEOUT_MS,
      );

      return { ok: true };
    } catch (error) {
      return { ok: false, error: normalizeErrorMessage(error) };
    }
  }

  async function openOptions() {
    try {
      await ext.runtime.openOptionsPage();
    } catch (_error) {
      await ext.tabs.create({ url: ext.runtime.getURL("src/options/options.html") });
    }
    return { ok: true };
  }

  async function getSettingsSummary() {
    const settings = await getSettings();
    return {
      ok: true,
      configured: Boolean(settings.serverUrl && settings.apiToken),
      serverUrl: settings.serverUrl,
      showListSelector: settings.showListSelector,
      autoDismiss: settings.autoDismiss,
      hasDefaultList: Boolean(settings.defaultListId),
    };
  }

  async function getSettings() {
    const stored = await ext.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      serverUrl: normalizeServerUrl(stored.serverUrl || DEFAULT_SETTINGS.serverUrl),
      apiToken: typeof stored.apiToken === "string" ? stored.apiToken.trim() : "",
      defaultListId:
        typeof stored.defaultListId === "string" ? stored.defaultListId : "",
      showListSelector: stored.showListSelector !== false,
      autoDismiss: stored.autoDismiss !== false,
      allowHttp: stored.allowHttp === true,
    };
  }

  function ensureConfigured(settings) {
    if (!settings.serverUrl) {
      throw userError("Karakeep server URL is not configured.");
    }
    if (!settings.apiToken) {
      throw userError("Karakeep API token is not configured.");
    }
    validateServerUrl(settings.serverUrl, settings.allowHttp);
  }

  function normalizeServerUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function validateServerUrl(url, allowHttp) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      throw userError("Karakeep server URL is invalid.");
    }

    if (parsed.protocol === "https:") {
      return;
    }

    if (allowHttp && parsed.protocol === "http:") {
      return;
    }

    throw userError("Karakeep server URL must use HTTPS unless HTTP is enabled in settings.");
  }

  async function karakeepRequest(settings, procedure, input, timeoutMs, method) {
    const requestMethod = method || "POST";
    const baseUrl = `${settings.serverUrl}/api/trpc/${procedure}`;
    const batchInput = {
      "0": {
        json: input || null,
      },
    };
    const url =
      requestMethod === "GET"
        ? `${baseUrl}?batch=1&input=${encodeURIComponent(JSON.stringify(batchInput))}`
        : `${baseUrl}?batch=1`;
    const headers = {
      Authorization: `Bearer ${settings.apiToken}`,
    };
    const options = {
      method: requestMethod,
      headers,
    };

    if (requestMethod !== "GET") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(batchInput);
    }

    const response = await fetchWithTimeout(url, options, timeoutMs);
    const text = await response.text();
    const parsed = text ? parseJson(text) : null;

    if (!response.ok) {
      throw apiErrorFromResponse(response, parsed, text);
    }

    return unwrapTrpcResponse(parsed);
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      return await fetch(url, {
        ...options,
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw userError("Karakeep request timed out.");
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      throw userError("Karakeep returned an invalid response.");
    }
  }

  function unwrapTrpcResponse(parsed) {
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      if (!first) {
        return null;
      }
      if (first.error) {
        throw userError(first.error.message || "Karakeep API request failed.");
      }
      return unwrapTrpcResult(first.result);
    }

    if (parsed && parsed.error) {
      throw userError(parsed.error.message || "Karakeep API request failed.");
    }

    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "result")) {
      return unwrapTrpcResult(parsed.result);
    }

    return parsed;
  }

  function unwrapTrpcResult(result) {
    if (!result) {
      return null;
    }
    if (result.data && Object.prototype.hasOwnProperty.call(result.data, "json")) {
      return result.data.json;
    }
    if (Object.prototype.hasOwnProperty.call(result, "json")) {
      return result.json;
    }
    return result.data || result;
  }

  function apiErrorFromResponse(response, parsed, text) {
    const message = extractErrorMessage(parsed) || text || `Karakeep request failed with HTTP ${response.status}.`;

    if (response.status === 401 || response.status === 403) {
      return userError("Karakeep rejected the API token. Check extension settings.");
    }

    return userError(message);
  }

  function extractErrorMessage(parsed) {
    if (!parsed) {
      return "";
    }
    if (Array.isArray(parsed)) {
      return parsed.map(extractErrorMessage).find(Boolean) || "";
    }
    if (parsed.error && parsed.error.message) {
      return parsed.error.message;
    }
    if (parsed.message) {
      return parsed.message;
    }
    return "";
  }

  function buildListPaths(lists) {
    const byId = new Map();
    lists.forEach((list) => byId.set(list.id, list));

    return lists
      .map((list) => {
        const path = [];
        const seen = new Set();
        let current = list;

        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          path.unshift(current);
          current = current.parentId ? byId.get(current.parentId) : null;
        }

        return {
          id: list.id,
          name: list.name || "Untitled List",
          icon: list.icon || "",
          path: path.map(formatListName).join(" / "),
          userRole: list.userRole,
          type: list.type,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  function formatListName(list) {
    return `${list.icon ? `${list.icon} ` : ""}${list.name || "Untitled List"}`;
  }

  function isHttpPageUrl(url) {
    if (!url) {
      return false;
    }
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (_error) {
      return false;
    }
  }

  function createRequestId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function userError(message) {
    const error = new Error(message);
    error.isUserError = true;
    return error;
  }

  function normalizeErrorMessage(error) {
    if (!error) {
      return "Something went wrong.";
    }
    if (error.message) {
      return error.message;
    }
    return String(error);
  }
})();
