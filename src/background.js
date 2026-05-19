(function () {
  "use strict";

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULT_SETTINGS = {
    primaryServerUrl: "https://cloud.karakeep.app",
    secondaryServerUrl: "",
    apiToken: "",
    defaultListId: "",
    showListSelector: true,
    autoDismiss: true,
    autoDismissSeconds: 5,
    popupPosition: "bottom-right",
    allowHttp: false,
  };
  const SAVE_TIMEOUT_MS = 30000;
  const LIST_TIMEOUT_MS = 20000;
  const MAX_BOOKMARK_TITLE_LENGTH = 1000;
  const CONTENT_SCRIPT_PATH = "src/content/overlay.js";
  const CONTENT_CSS_PATH = "src/content/overlay.css";
  let overlayCssPromise = null;

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
      return getLists(message.payload);
    }

    if (message.type === "ADD_TO_LIST") {
      return addToList(message.payload);
    }

    if (message.type === "REMOVE_FROM_LIST") {
      return removeFromList(message.payload);
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
    const settings = await getSettings();
    const overlayCss = await getOverlayCss();
    const payload = {
      requestId,
      url: tab.url || "",
      title: tab.title || "",
      popupPosition: settings.popupPosition,
      overlayCss,
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

  async function getOverlayCss() {
    if (!overlayCssPromise) {
      overlayCssPromise = fetch(ext.runtime.getURL(CONTENT_CSS_PATH))
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Unable to load overlay CSS: ${response.status}`);
          }
          return response.text();
        })
        .catch((error) => {
          overlayCssPromise = null;
          throw error;
        });
    }

    return overlayCssPromise;
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
      const bookmarkTitle = normalizeBookmarkTitle(title);

      if (!isHttpPageUrl(tabUrl)) {
        throw userError("This page cannot be saved. Only HTTP/HTTPS pages are supported.");
      }

      const bookmarkResponse = await karakeepRequest(
        settings,
        "bookmarks.createBookmark",
        {
          type: "link",
          url: tabUrl,
          title: bookmarkTitle || undefined,
          source: "extension",
        },
        SAVE_TIMEOUT_MS,
      );
      const bookmark = bookmarkResponse.data;

      if (!bookmark || !bookmark.id) {
        throw userError("Karakeep saved the link but returned an unexpected response.");
      }

      let autoListResult = null;
      if (settings.defaultListId) {
        try {
          const autoListResponse = await karakeepRequest(
            settings,
            "lists.addToList",
            { bookmarkId: bookmark.id, listId: settings.defaultListId },
            LIST_TIMEOUT_MS,
          );
          autoListResult = {
            ok: true,
            listId: settings.defaultListId,
            serverLabel: autoListResponse.server.label,
          };
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
          autoDismissSeconds: settings.autoDismissSeconds,
          defaultListId: settings.defaultListId,
        },
        autoListResult,
        server: bookmarkResponse.server,
      };
    } catch (error) {
      return { ok: false, error: normalizeErrorMessage(error) };
    }
  }

  async function getLists(payload) {
    try {
      const settings = await getSettings();
      ensureConfigured(settings);

      const response = await karakeepRequest(
        settings,
        "lists.list",
        undefined,
        LIST_TIMEOUT_MS,
        "GET",
      );
      const result = response.data;
      const lists = Array.isArray(result.lists) ? result.lists : [];
      const editableLists = buildListPaths(lists).filter(
        (list) => list.userRole !== "viewer" && list.userRole !== "public",
      );
      let selectedListIds = [];

      if (payload && payload.bookmarkId) {
        const selectedResponse = await karakeepRequest(
          settings,
          "lists.getListsOfBookmark",
          { bookmarkId: payload.bookmarkId },
          LIST_TIMEOUT_MS,
          "GET",
        );
        const selectedLists = Array.isArray(selectedResponse.data.lists)
          ? selectedResponse.data.lists
          : [];
        selectedListIds = selectedLists.map((list) => list.id);
      }

      return { ok: true, lists: editableLists, selectedListIds, server: response.server };
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

      const response = await karakeepRequest(
        settings,
        "lists.addToList",
        { bookmarkId: payload.bookmarkId, listId: payload.listId },
        LIST_TIMEOUT_MS,
      );

      return { ok: true, server: response.server };
    } catch (error) {
      return { ok: false, error: normalizeErrorMessage(error) };
    }
  }

  async function removeFromList(payload) {
    try {
      if (!payload || !payload.bookmarkId || !payload.listId) {
        throw userError("Missing bookmark or List id.");
      }

      const settings = await getSettings();
      ensureConfigured(settings);

      const response = await karakeepRequest(
        settings,
        "lists.removeFromList",
        { bookmarkId: payload.bookmarkId, listId: payload.listId },
        LIST_TIMEOUT_MS,
      );

      return { ok: true, server: response.server };
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
      configured: Boolean(settings.primaryServerUrl && settings.apiToken),
      primaryServerUrl: settings.primaryServerUrl,
      secondaryServerUrl: settings.secondaryServerUrl,
      showListSelector: settings.showListSelector,
      autoDismiss: settings.autoDismiss,
      autoDismissSeconds: settings.autoDismissSeconds,
      hasDefaultList: Boolean(settings.defaultListId),
    };
  }

  async function getSettings() {
    const stored = await ext.storage.local.get([
      ...Object.keys(DEFAULT_SETTINGS),
      "serverUrl",
    ]);
    const primaryServerUrl = normalizeServerUrl(
      stored.primaryServerUrl || stored.serverUrl || DEFAULT_SETTINGS.primaryServerUrl,
    );
    const secondaryServerUrl = normalizeServerUrl(stored.secondaryServerUrl || "");

    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      primaryServerUrl,
      secondaryServerUrl,
      apiToken: typeof stored.apiToken === "string" ? stored.apiToken.trim() : "",
      defaultListId:
        typeof stored.defaultListId === "string" ? stored.defaultListId : "",
      showListSelector: stored.showListSelector !== false,
      autoDismiss: stored.autoDismiss !== false,
      autoDismissSeconds: normalizeAutoDismissSeconds(stored.autoDismissSeconds),
      popupPosition: normalizePopupPosition(stored.popupPosition),
      allowHttp: stored.allowHttp === true,
    };
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
    return DEFAULT_SETTINGS.popupPosition;
  }

  function normalizeAutoDismissSeconds(value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 60) {
      return seconds;
    }
    return DEFAULT_SETTINGS.autoDismissSeconds;
  }

  function ensureConfigured(settings) {
    if (!settings.primaryServerUrl) {
      throw userError("Primary Karakeep server URL is not configured.");
    }
    if (!settings.apiToken) {
      throw userError("Karakeep API token is not configured.");
    }
    getConfiguredServers(settings).forEach((server) => {
      validateServerUrl(server.url, settings.allowHttp, server.label);
    });
  }

  function normalizeServerUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function validateServerUrl(url, allowHttp, label) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      throw userError(`${label} Karakeep server URL is invalid.`);
    }

    if (parsed.protocol === "https:") {
      return;
    }

    if (allowHttp && parsed.protocol === "http:") {
      return;
    }

    throw userError(`${label} Karakeep server URL must use HTTPS unless HTTP is enabled in settings.`);
  }

  async function karakeepRequest(settings, procedure, input, timeoutMs, method) {
    const servers = getConfiguredServers(settings);
    let primaryError = null;

    for (let i = 0; i < servers.length; i += 1) {
      const server = servers[i];
      try {
        return {
          data: await karakeepRequestToServer(
            settings,
            server,
            procedure,
            input,
            timeoutMs,
            method,
          ),
          server,
          usedFallback: i > 0,
        };
      } catch (error) {
        if (i === 0) {
          primaryError = error;
        }

        if (!shouldFallback(error)) {
          throw error;
        }

        if (i === servers.length - 1) {
          throw userError(formatAllServersFailedMessage(primaryError, error, i > 0));
        }
      }
    }

    throw userError("No Karakeep server URL is configured.");
  }

  async function karakeepRequestToServer(settings, server, procedure, input, timeoutMs, method) {
    const requestMethod = method || "POST";
    const baseUrl = `${server.url}/api/trpc/${procedure}`;
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

  function getConfiguredServers(settings) {
    const servers = [{ label: "Primary", url: settings.primaryServerUrl }];
    if (
      settings.secondaryServerUrl &&
      settings.secondaryServerUrl !== settings.primaryServerUrl
    ) {
      servers.push({ label: "Secondary", url: settings.secondaryServerUrl });
    }
    return servers;
  }

  function shouldFallback(error) {
    return !error || error.shouldNotFallback !== true;
  }

  function formatAllServersFailedMessage(primaryError, finalError, triedSecondary) {
    if (!triedSecondary || !primaryError || primaryError === finalError) {
      return normalizeErrorMessage(finalError || primaryError);
    }

    return `Primary failed: ${normalizeErrorMessage(primaryError)} Secondary failed: ${normalizeErrorMessage(finalError)}`;
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
        throw userError(unwrapTrpcErrorMessage(first.error));
      }
      return unwrapTrpcResult(first.result);
    }

    if (parsed && parsed.error) {
      throw userError(unwrapTrpcErrorMessage(parsed.error));
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
      return userError("Karakeep rejected the API token. Check extension settings.", {
        shouldNotFallback: true,
      });
    }

    if (response.status >= 400 && response.status < 500) {
      return userError(message, { shouldNotFallback: true });
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
    if (parsed.error) {
      const message = extractErrorMessage(parsed.error);
      if (message) {
        return message;
      }
    }
    if (parsed.json) {
      const message = extractErrorMessage(parsed.json);
      if (message) {
        return message;
      }
    }
    if (parsed.data && parsed.data.zodError) {
      const message = formatZodError(parsed.data.zodError);
      if (message) {
        return message;
      }
    }
    if (parsed.zodError) {
      const message = formatZodError(parsed.zodError);
      if (message) {
        return message;
      }
    }
    if (parsed.message) {
      const message = parseEmbeddedValidationMessage(parsed.message) || parsed.message;
      return cleanupErrorMessage(message);
    }
    return "";
  }

  function normalizeBookmarkTitle(title) {
    if (typeof title !== "string") {
      return "";
    }
    return title.slice(0, MAX_BOOKMARK_TITLE_LENGTH);
  }

  function formatZodError(zodError) {
    const messages = [];
    const fieldErrors = zodError.fieldErrors || {};

    Object.keys(fieldErrors).forEach((field) => {
      const errors = Array.isArray(fieldErrors[field]) ? fieldErrors[field] : [];
      errors.filter(Boolean).forEach((error) => {
        messages.push(`${formatFieldName(field)}: ${cleanupErrorMessage(error)}`);
      });
    });

    if (Array.isArray(zodError.formErrors)) {
      zodError.formErrors.filter(Boolean).forEach((error) => {
        messages.push(cleanupErrorMessage(error));
      });
    }

    return messages.length ? `Karakeep rejected the request: ${messages.join(" ")}` : "";
  }

  function parseEmbeddedValidationMessage(message) {
    if (typeof message !== "string") {
      return "";
    }

    try {
      const parsed = JSON.parse(message);
      if (!Array.isArray(parsed)) {
        return "";
      }

      const messages = parsed
        .map((issue) => {
          if (!issue || !issue.message) {
            return "";
          }
          const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
          return path
            ? `${formatFieldName(path)}: ${cleanupErrorMessage(issue.message)}`
            : cleanupErrorMessage(issue.message);
        })
        .filter(Boolean);

      return messages.length ? `Karakeep rejected the request: ${messages.join(" ")}` : "";
    } catch (_error) {
      return "";
    }
  }

  function formatFieldName(field) {
    return String(field || "field")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function cleanupErrorMessage(message) {
    return String(message || "")
      .replace(/character\(s\)/g, "characters")
      .replace(/string/i, "value")
      .trim();
  }

  function unwrapTrpcErrorMessage(error) {
    if (!error) {
      return "Karakeep API request failed.";
    }
    const message = extractErrorMessage(error);
    if (message) {
      return message;
    }
    return "Karakeep API request failed.";
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

  function userError(message, options) {
    const error = new Error(message);
    error.isUserError = true;
    if (options && Object.prototype.hasOwnProperty.call(options, "shouldNotFallback")) {
      error.shouldNotFallback = options.shouldNotFallback;
    }
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
