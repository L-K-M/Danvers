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
    allowHttp: false,
  };

  const form = document.getElementById("settings-form");
  const primaryServerUrlInput = document.getElementById("primaryServerUrl");
  const secondaryServerUrlInput = document.getElementById("secondaryServerUrl");
  const apiTokenInput = document.getElementById("apiToken");
  const allowHttpInput = document.getElementById("allowHttp");
  const showListSelectorInput = document.getElementById("showListSelector");
  const autoDismissInput = document.getElementById("autoDismiss");
  const defaultListSelect = document.getElementById("defaultListId");
  const testButton = document.getElementById("testConnection");
  const reloadListsButton = document.getElementById("reloadLists");
  const status = document.getElementById("status");

  document.addEventListener("DOMContentLoaded", init);
  form.addEventListener("submit", saveSettings);
  testButton.addEventListener("click", testConnection);
  reloadListsButton.addEventListener("click", loadListsFromSettings);

  async function init() {
    const settings = await getSettings();
    primaryServerUrlInput.value = settings.primaryServerUrl;
    secondaryServerUrlInput.value = settings.secondaryServerUrl;
    apiTokenInput.value = settings.apiToken;
    allowHttpInput.checked = settings.allowHttp;
    showListSelectorInput.checked = settings.showListSelector;
    autoDismissInput.checked = settings.autoDismiss;
    await populateLists(settings.defaultListId, false);
  }

  async function saveSettings(event) {
    event.preventDefault();
    const settings = readFormSettings();

    try {
      validateSettings(settings, false);
      await ensureServerPermissions(settings);
      await ext.storage.local.set(settings);
      setStatus("Settings saved.", "success");
      await populateLists(settings.defaultListId, false);
    } catch (error) {
      setStatus(error.message || String(error), "error");
    }
  }

  async function testConnection() {
    const settings = readFormSettings();
    try {
      validateSettings(settings, true);
      await ensureServerPermissions(settings);
      await ext.storage.local.set(settings);
      setBusy(testButton, true, "Testing...");
      const response = await sendMessage({ type: "GET_LISTS" });
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "Connection test failed.");
      }
      setStatus(`Connected via ${response.server.label}. Found ${response.lists.length} editable List${response.lists.length === 1 ? "" : "s"}.`, "success");
      renderListOptions(response.lists, settings.defaultListId);
    } catch (error) {
      setStatus(error.message || String(error), "error");
    } finally {
      setBusy(testButton, false, "Test Connection");
    }
  }

  async function loadListsFromSettings() {
    const settings = readFormSettings();
    try {
      validateSettings(settings, true);
      await ensureServerPermissions(settings);
      await ext.storage.local.set(settings);
      await populateLists(settings.defaultListId, true);
    } catch (error) {
      setStatus(error.message || String(error), "error");
    }
  }

  async function populateLists(selectedListId, showResult) {
    try {
      setBusy(reloadListsButton, true, "Loading...");
      const response = await sendMessage({ type: "GET_LISTS" });
      if (!response || !response.ok) {
        renderListOptions([], selectedListId);
        if (showResult) {
          throw new Error(response && response.error ? response.error : "Could not load Lists.");
        }
        return;
      }

      renderListOptions(response.lists, selectedListId);
      if (showResult) {
        setStatus(`Loaded via ${response.server.label}: ${response.lists.length} editable List${response.lists.length === 1 ? "" : "s"}.`, "success");
      }
    } catch (error) {
      setStatus(error.message || String(error), "error");
    } finally {
      setBusy(reloadListsButton, false, "Reload Lists");
    }
  }

  function renderListOptions(lists, selectedListId) {
    defaultListSelect.innerHTML = "";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "No default List";
    defaultListSelect.appendChild(emptyOption);

    let selectedListWasFound = !selectedListId;

    lists.forEach((list) => {
      const option = document.createElement("option");
      option.value = list.id;
      option.textContent = list.path;
      option.selected = list.id === selectedListId;
      selectedListWasFound = selectedListWasFound || option.selected;
      defaultListSelect.appendChild(option);
    });

    if (!selectedListWasFound) {
      const preservedOption = document.createElement("option");
      preservedOption.value = selectedListId;
      preservedOption.textContent = `Saved default List (${selectedListId})`;
      preservedOption.selected = true;
      defaultListSelect.appendChild(preservedOption);
    }
  }

  async function getSettings() {
    const stored = await ext.storage.local.get([
      ...Object.keys(DEFAULT_SETTINGS),
      "serverUrl",
    ]);
    const primaryServerUrl = normalizeServerUrl(
      stored.primaryServerUrl || stored.serverUrl || DEFAULT_SETTINGS.primaryServerUrl,
    );

    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      primaryServerUrl,
      secondaryServerUrl: normalizeServerUrl(stored.secondaryServerUrl || ""),
      apiToken: typeof stored.apiToken === "string" ? stored.apiToken : "",
      defaultListId:
        typeof stored.defaultListId === "string" ? stored.defaultListId : "",
      showListSelector: stored.showListSelector !== false,
      autoDismiss: stored.autoDismiss !== false,
      allowHttp: stored.allowHttp === true,
    };
  }

  function readFormSettings() {
    return {
      primaryServerUrl: normalizeServerUrl(primaryServerUrlInput.value),
      secondaryServerUrl: normalizeServerUrl(secondaryServerUrlInput.value),
      apiToken: apiTokenInput.value.trim(),
      defaultListId: defaultListSelect.value,
      showListSelector: showListSelectorInput.checked,
      autoDismiss: autoDismissInput.checked,
      allowHttp: allowHttpInput.checked,
    };
  }

  function validateSettings(settings, requireToken) {
    if (!settings.primaryServerUrl) {
      throw new Error("Primary Karakeep server URL is required.");
    }

    validateServerUrl(settings.primaryServerUrl, settings.allowHttp, "Primary");
    if (settings.secondaryServerUrl) {
      validateServerUrl(settings.secondaryServerUrl, settings.allowHttp, "Secondary");
    }

    if (requireToken && !settings.apiToken) {
      throw new Error("API token is required for this action.");
    }
  }

  function validateServerUrl(url, allowHttp, label) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      throw new Error(`${label} Karakeep server URL is invalid.`);
    }

    if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
      throw new Error(`${label} Karakeep server URL must use HTTPS unless HTTP is enabled.`);
    }
  }

  async function ensureServerPermissions(settings) {
    if (!ext.permissions || !ext.permissions.request) {
      return;
    }

    const origins = getServerPermissionOrigins(settings);
    if (origins.length === 0) {
      return;
    }

    // Firefox requires permissions.request to be the first permission call made
    // from the user gesture. Calling permissions.contains first can consume the
    // gesture and make request fail.
    const granted = await ext.permissions.request({ origins });
    if (!granted) {
      throw new Error("Permission to connect to the configured Karakeep server was not granted.");
    }
  }

  function getServerPermissionOrigins(settings) {
    return [settings.primaryServerUrl, settings.secondaryServerUrl]
      .filter(Boolean)
      .map(urlToPermissionOrigin)
      .filter(Boolean)
      .filter((origin, index, origins) => origins.indexOf(origin) === index);
  }

  function urlToPermissionOrigin(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}/*`;
    } catch (_error) {
      return "";
    }
  }

  function normalizeServerUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function setStatus(message, kind) {
    status.textContent = message || "";
    status.className = `status ${kind || ""}`.trim();
  }

  function setBusy(button, busy, text) {
    button.disabled = busy;
    button.textContent = text;
  }

  function sendMessage(message) {
    return ext.runtime.sendMessage(message).catch((error) => ({
      ok: false,
      error: error && error.message ? error.message : String(error),
    }));
  }
})();
