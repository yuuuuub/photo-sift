/* --------------------------------------------------------------------------
   挑片 — 版本信息 / 检查更新
   - 显示当前版本
   - 手动或自动访问 GitHub Releases 检查是否有新版本（只读公开 API，不上传任何照片信息）
   -------------------------------------------------------------------------- */

(() => {
  "use strict";

  const core = window.PhotoSiftCore;
  const native = window.PhotoSiftNative;
  if (!core || !native || !native.isNative) return;

  const REPO = "yuuuuub/photo-sift";
  const API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;
  const PKG = "com.tiaopian.app";

  const row = document.getElementById("versionRow");
  const value = document.getElementById("versionValue");
  const checkBtn = document.getElementById("versionCheck");
  const hint = document.getElementById("versionHint");
  if (!row || !value || !checkBtn) return;

  let currentVersion = "";

  const api = () => (native.Capacitor && native.Capacitor.Plugins ? native.Capacitor.Plugins : null);

  function installAppPlugin() {
    const plugins = api();
    if (plugins && plugins.App && typeof plugins.App.getInfo === "function") return plugins.App;
    // CAP-AC 的 web 实现没有 getInfo，这里补一个读取 __version 的兜底
    const cap = native.Capacitor;
    if (cap && typeof cap.registerPlugin === "function") {
      return cap.registerPlugin("App");
    }
    return null;
  }

  async function readVersion() {
    const app = installAppPlugin();
    if (app) {
      try {
        const info = await app.getInfo();
        if (info && info.version) return `${info.version}${info.build ? ` (${info.build})` : ""}`;
      } catch (_) {
        /* 回退到静态值 */
      }
    }
    return "1.1";
  }

  function parseVersion(text) {
    return String(text)
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((part) => Number.parseInt(part, 10) || 0);
  }

  function compare(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
      const x = left[i] || 0;
      const y = right[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  function openUrl(url) {
    const app = installAppPlugin();
    if (app && typeof app.openUrl === "function") {
      app.openUrl({ url }).catch(() => {
        window.open(url, "_blank");
      });
      return;
    }
    window.open(url, "_blank");
  }

  function setHint(text, state) {
    if (!hint) return;
    hint.textContent = text || "";
    hint.hidden = !text;
    hint.classList.toggle("is-new", state === "new");
    hint.classList.toggle("is-error", state === "error");
  }

  function showUpdate(latest, url) {
    setHint(`有新版本 ${latest} 可安装`, "new");
    checkBtn.textContent = "去更新";
    checkBtn.dataset.url = url || RELEASE_PAGE;
  }

  async function check({ silent = false } = {}) {
    if (!silent) {
      checkBtn.disabled = true;
      checkBtn.textContent = "检查中…";
      setHint("");
    }

    try {
      const response = await fetch(`${API}?t=${Date.now()}`, {
        headers: { Accept: "application/vnd.github+json" }
      });
      if (response.status === 404) {
        if (!silent) setHint("还没有发布版本，当前就是最新的", "ok");
        return null;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const latest = (data.tag_name || data.name || "").trim();
      if (!latest) {
        if (!silent) setHint("没有读到版本号", "error");
        return null;
      }

      if (compare(latest, currentVersion) > 0) {
        showUpdate(latest, data.html_url);
        return latest;
      }

      setHint(`已是最新版本 ${latest}`, "ok");
      checkBtn.textContent = "检查更新";
      return null;
    } catch (error) {
      if (!silent) setHint("网络不可用，稍后再试", "error");
      checkBtn.textContent = "检查更新";
      return null;
    } finally {
      checkBtn.disabled = false;
    }
  }

  checkBtn.addEventListener("click", () => {
    if (checkBtn.dataset.url) {
      openUrl(checkBtn.dataset.url);
      delete checkBtn.dataset.url;
      return;
    }
    check();
  });

  (async () => {
    currentVersion = await readVersion();
    value.textContent = currentVersion;
    row.hidden = false;
    // 打开 App 后静默检查一次，不打扰用户
    window.setTimeout(() => check({ silent: true }), 2500);
  })();

  // 供帮助弹窗打开时触发显示
  document.addEventListener("photosift:render", () => {
    row.hidden = false;
  });
})();
