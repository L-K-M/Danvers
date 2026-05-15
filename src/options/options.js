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

  const form = document.getElementById("settings-form");
  const serverUrlInput = document.getElementById("serverUrl");
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
    serverUrlInput.value = settings.serverUrl;
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
      await ext.storage.local.set(settings);
      setBusy(testButton, true, "Testing...");
      const response = await sendMessage({ type: "GET_LISTS" });
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "Connection test failed.");
      }
      setStatus(`Connected. Found ${response.lists.length} editable List${response.lists.length === 1 ? "" : "s"}.`, "success");
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
        setStatus(`Loaded ${response.lists.length} editable List${response.lists.length === 1 ? "" : "s"}.`, "success");
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
    const stored = await ext.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      serverUrl: normalizeServerUrl(stored.serverUrl || DEFAULT_SETTINGS.serverUrl),
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
      serverUrl: normalizeServerUrl(serverUrlInput.value),
      apiToken: apiTokenInput.value.trim(),
      defaultListId: defaultListSelect.value,
      showListSelector: showListSelectorInput.checked,
      autoDismiss: autoDismissInput.checked,
      allowHttp: allowHttpInput.checked,
    };
  }

  function validateSettings(settings, requireToken) {
    if (!settings.serverUrl) {
      throw new Error("Karakeep server URL is required.");
    }

    let parsed;
    try {
      parsed = new URL(settings.serverUrl);
    } catch (_error) {
      throw new Error("Karakeep server URL is invalid.");
    }

    if (parsed.protocol !== "https:" && !(settings.allowHttp && parsed.protocol === "http:")) {
      throw new Error("Karakeep server URL must use HTTPS unless HTTP is enabled.");
    }

    if (requireToken && !settings.apiToken) {
      throw new Error("API token is required for this action.");
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
