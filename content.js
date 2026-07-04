(() => {
  "use strict";

  const ITEM_SELECTOR = 'a[data-sidebar-item="true"][href^="/c/"]';
  const HISTORY_SELECTOR = "#history";
  const CHECKBOX_CLASS = "cgpt-bulk-checkbox";
  const SELECTED_CLASS = "cgpt-bulk-selected";
  const TOOLBAR_ID = "cgpt-bulk-toolbar";
  const API_DELAY_MS = 180;
  const REFRESH_DELAY_MS = 300;
  const WATCHDOG_DELAY_MS = 2000;

  const selectedIds = new Set();
  let observer = null;
  let isDeleting = false;
  let refreshTimer = 0;
  let watchdogTimer = 0;
  let isRefreshing = false;
  let isBatchMode = false;
  let ignoreMutations = false;

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getConversationId(item) {
    const href = item.getAttribute("href") || "";
    const match = href.match(/^\/c\/([^/?#]+)/);
    return match ? match[1] : "";
  }

  function getConversationTitle(item) {
    const span = item.querySelector('span[dir="auto"]');
    return (span?.textContent || item.getAttribute("aria-label") || "未命名会话").trim();
  }

  function getHistoryRoot() {
    return document.querySelector(HISTORY_SELECTOR);
  }

  function getItems() {
    const history = getHistoryRoot();
    if (!history) return [];
    return Array.from(history.querySelectorAll(ITEM_SELECTOR)).filter(getConversationId);
  }

  function getObserveTarget() {
    return getHistoryRoot() || document.body || document.documentElement;
  }

  function findItemById(id) {
    return getItems().find((item) => getConversationId(item) === id) || null;
  }

  function preventNavigation(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  let cachedAccessToken = null;
  let cachedDeviceId = null;

  function readStorageToken() {
    try {
      const raw = localStorage.getItem("oai/accessToken") || localStorage.getItem("accessToken");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
      return parsed.accessToken || parsed.token || parsed;
    } catch {
      return localStorage.getItem("oai/accessToken") || localStorage.getItem("accessToken") || null;
    }
  }

  function readStorageDeviceId() {
    try {
      const raw = localStorage.getItem("oai/deviceId") || localStorage.getItem("oai/did") || localStorage.getItem("deviceId");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
      return parsed.deviceId || parsed.id || parsed;
    } catch {
      return localStorage.getItem("oai/deviceId") || localStorage.getItem("oai/did") || localStorage.getItem("deviceId") || null;
    }
  }

  async function refreshAccessToken() {
    const fromStorage = readStorageToken();
    if (fromStorage) {
      cachedAccessToken = fromStorage;
      return cachedAccessToken;
    }

    try {
      const res = await fetch("/api/auth/session", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      cachedAccessToken = data.accessToken || data.access_token || null;
      return cachedAccessToken;
    } catch (e) {
      console.error("[ChatGPT Bulk Manager] 获取 access token 失败:", e);
      return null;
    }
  }

  async function getDeviceId() {
    if (cachedDeviceId) return cachedDeviceId;
    const fromStorage = readStorageDeviceId();
    if (fromStorage) {
      cachedDeviceId = fromStorage;
      return cachedDeviceId;
    }
    return null;
  }

  function updateItemState(item) {
    const id = getConversationId(item);
    const checked = selectedIds.has(id);
    item.classList.toggle(SELECTED_CLASS, checked);
    const checkbox = item.querySelector(`.${CHECKBOX_CLASS}`);
    if (checkbox) {
      checkbox.checked = checked;
      checkbox.setAttribute("aria-label", `${checked ? "取消选择" : "选择"} ${getConversationTitle(item)}`);
    }
  }

  function updateToolbar() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;

    const selectedCount = selectedIds.size;
    const visibleCount = getItems().length;
    const count = toolbar.querySelector("[data-cgpt-count]");
    const deleteButton = toolbar.querySelector("[data-cgpt-delete]");
    const clearButton = toolbar.querySelector("[data-cgpt-clear]");
    const selectVisibleButton = toolbar.querySelector("[data-cgpt-select-visible]");
    const toggleButton = toolbar.querySelector("[data-cgpt-toggle]");

    if (count) count.textContent = isDeleting ? "删除中..." : `已选 ${selectedCount}`;
    if (deleteButton) deleteButton.disabled = selectedCount === 0 || isDeleting;
    if (clearButton) clearButton.disabled = selectedCount === 0 || isDeleting;
    if (selectVisibleButton) selectVisibleButton.disabled = visibleCount === 0 || isDeleting;
    if (toggleButton) toggleButton.textContent = isBatchMode ? "退出" : "管理";
  }

  function syncSelectionToDom() {
    if (!isBatchMode) return;
    getItems().forEach(updateItemState);
    updateToolbar();
  }

  function createCheckbox(item) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = CHECKBOX_CLASS;
    checkbox.title = "选择会话";

    // 只阻止冒泡到 <a> 防止跳转，不 preventDefault，让浏览器立即画出勾选动画
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    checkbox.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });

    // change 在浏览器完成 checkbox 视觉切换后触发，再同步状态和后台 UI
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const id = getConversationId(item);
      if (!id || isDeleting) {
        // 如果正在删除，回滚状态到 selectedIds 的权威值
        setTimeout(() => updateItemState(item), 0);
        return;
      }

      if (checkbox.checked) {
        selectedIds.add(id);
      } else {
        selectedIds.delete(id);
      }

      // 立即更新本行背景色，不阻塞
      item.classList.toggle(SELECTED_CLASS, checkbox.checked);

      // 把 toolbar 和全量 DOM 同步推到下一事件循环，不卡勾选动画
      setTimeout(() => {
        updateToolbar();
      }, 0);
    });

    checkbox.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.stopPropagation();
      }
    });

    return checkbox;
  }

  function clearDecorations() {
    for (const item of getItems()) {
      const cb = item.querySelector(`.${CHECKBOX_CLASS}`);
      if (cb) cb.remove();
      item.classList.remove(SELECTED_CLASS, "cgpt-bulk-item");
    }
  }

  function decorateItems() {
    if (!isBatchMode) {
      clearDecorations();
      return;
    }

    for (const item of getItems()) {
      if (item.querySelector(`.${CHECKBOX_CLASS}`)) {
        updateItemState(item);
        continue;
      }

      item.classList.add("cgpt-bulk-item");
      item.prepend(createCheckbox(item));
      updateItemState(item);
    }
    updateToolbar();
  }

  function createToolbar() {
    let toolbar = document.getElementById(TOOLBAR_ID);
    const history = getHistoryRoot();
    if (!history?.parentElement) return;

    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = TOOLBAR_ID;
      toolbar.innerHTML = `
        <button type="button" data-cgpt-toggle>批量删除</button>
        <button type="button" data-cgpt-select-visible style="display:none">全选</button>
        <button type="button" data-cgpt-clear style="display:none" disabled>清空</button>
        <button type="button" class="cgpt-bulk-danger" data-cgpt-delete style="display:none" disabled>删除</button>
        <span class="cgpt-bulk-count" data-cgpt-count>已选 0</span>
      `;

      toolbar.querySelector("[data-cgpt-toggle]").addEventListener("click", toggleBatchMode);
      toolbar.querySelector("[data-cgpt-select-visible]").addEventListener("click", () => {
        if (isDeleting) return;
        getItems().forEach((item) => selectedIds.add(getConversationId(item)));
        syncSelectionToDom();
      });
      toolbar.querySelector("[data-cgpt-clear]").addEventListener("click", () => {
        if (isDeleting) return;
        selectedIds.clear();
        syncSelectionToDom();
      });
      toolbar.querySelector("[data-cgpt-delete]").addEventListener("click", deleteSelected);

      history.parentElement.insertBefore(toolbar, history);
    }

    const batchButtons = toolbar.querySelectorAll(
      '[data-cgpt-select-visible], [data-cgpt-clear], [data-cgpt-delete]'
    );
    const toggleButton = toolbar.querySelector("[data-cgpt-toggle]");

    toggleButton.textContent = isBatchMode ? "退出" : "管理";
    batchButtons.forEach((btn) => {
      btn.style.display = isBatchMode ? "" : "none";
    });

    updateToolbar();
  }

  function toggleBatchMode() {
    isBatchMode = !isBatchMode;
    if (!isBatchMode) {
      selectedIds.clear();
      clearDecorations();
    }
    createToolbar();
    if (isBatchMode) {
      decorateItems();
    }
  }

  function showToast(message, type = "") {
    let toast = document.getElementById("cgpt-bulk-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "cgpt-bulk-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.type = type;
    toast.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => {
      toast.classList.remove("show");
    }, 3000);
  }

  function setStatus(message, type = "") {
    // 状态信息统一走 toast，toolbar 里不再保留固定状态行
    if (message) showToast(message, type);
  }

  async function deleteConversation(id) {
    const deviceId = await getDeviceId();
    const url = `/backend-api/conversation/${encodeURIComponent(id)}`;

    const headers = {
      accept: "*/*",
      "content-type": "application/json",
      "x-openai-target-path": url,
      "x-openai-target-route": "/backend-api/conversation/{conversation_id}",
    };

    if (cachedAccessToken) {
      headers["authorization"] = `Bearer ${cachedAccessToken}`;
    }
    if (deviceId) {
      headers["oai-device-id"] = deviceId;
    }

    let response = await fetch(url, {
      method: "PATCH",
      credentials: "include",
      headers,
      body: JSON.stringify({ is_visible: false }),
    });

    // token 失效时尝试刷新一次并重试
    if (response.status === 401 || response.status === 403) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        headers["authorization"] = `Bearer ${newToken}`;
        response = await fetch(url, {
          method: "PATCH",
          credentials: "include",
          headers,
          body: JSON.stringify({ is_visible: false }),
        });
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 120)}` : ""}`);
    }
  }

  async function deleteSelected() {
    if (isDeleting || selectedIds.size === 0) return;

    // 预取 token，拿不到就直接提示
    const token = await refreshAccessToken();
    if (!token) {
      setStatus("无法获取访问令牌，请确认您已登录 ChatGPT", "error");
      return;
    }

    const ids = Array.from(selectedIds);
    const titles = ids
      .slice(0, 5)
      .map((id) => getConversationTitle(findItemById(id) || document.createElement("a")))
      .join("\n");
    const more = ids.length > 5 ? `\n...以及另外 ${ids.length - 5} 个会话` : "";
    const confirmed = window.confirm(`确定删除选中的 ${ids.length} 个 ChatGPT 会话吗？\n\n${titles}${more}`);
    if (!confirmed) return;

    isDeleting = true;
    updateToolbar();
    setStatus(`开始删除 ${ids.length} 个会话`, "");

    let successCount = 0;
    const failures = [];

    for (const [index, id] of ids.entries()) {
      setStatus(`正在删除 ${index + 1}/${ids.length}`, "");
      try {
        await deleteConversation(id);
        successCount += 1;
        selectedIds.delete(id);
        findItemById(id)?.closest("li")?.remove();
      } catch (error) {
        failures.push({ id, error: error.message });
      }
      await sleep(API_DELAY_MS);
    }

    isDeleting = false;

    if (selectedIds.size === 0) {
      isBatchMode = false;
      clearDecorations();
      createToolbar();
    } else {
      syncSelectionToDom();
    }

    if (failures.length > 0) {
      console.warn("[ChatGPT Bulk Manager] 删除失败：", failures);
      setStatus(`已删除 ${successCount} 个，失败 ${failures.length} 个。详情见 Console。`, "error");
      return;
    }

    setStatus(`已删除 ${successCount} 个会话`, "success");
  }

  function bootstrap() {
    refresh();
    observePage();
    watchdogTimer = window.setInterval(scheduleRefresh, WATCHDOG_DELAY_MS);
  }

  function observePage() {
    if (observer) return;

    observer = new MutationObserver((mutations) => {
      if (ignoreMutations || !isBatchMode) return;

      let shouldRefresh = false;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches?.(ITEM_SELECTOR) || node.querySelector?.(ITEM_SELECTOR)) {
              shouldRefresh = true;
              break;
            }
          }
        }
        if (shouldRefresh) break;
      }

      if (shouldRefresh) {
        scheduleRefresh();
      }
    });
    observeCurrentTarget();
  }

  function scheduleRefresh() {
    if (isRefreshing || refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      refresh();
    }, REFRESH_DELAY_MS);
  }

  function refresh() {
    if (isRefreshing) return;

    isRefreshing = true;
    ignoreMutations = true;
    observer?.disconnect();
    try {
      createToolbar();
      if (isBatchMode) {
        decorateItems();
      }
    } finally {
      isRefreshing = false;
      window.setTimeout(() => {
        ignoreMutations = false;
      }, 100);
      if (observer) {
        observeCurrentTarget();
      }
    }
  }

  function observeCurrentTarget() {
    const target = getObserveTarget();
    if (!target) return;

    observer.observe(target, {
      childList: true,
      subtree: true,
    });
  }

  bootstrap();
})();
