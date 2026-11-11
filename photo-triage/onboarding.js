/* --------------------------------------------------------------------------
   挑片 — 首次使用引导 / 新手提示
   只在该设备第一次打开时出现一次，之后可通过本地存储记住。
   -------------------------------------------------------------------------- */

(() => {
  "use strict";

  const core = window.PhotoSiftCore;
  if (!core) return;

  const seen = () => {
    try {
      return window.localStorage.getItem("photosift:onboarded") === "1";
    } catch (_) {
      return true;
    }
  };

  const markSeen = () => {
    try {
      window.localStorage.setItem("photosift:onboarded", "1");
    } catch (_) {
      /* 存储不可用时忽略 */
    }
  };

  const dialog = document.getElementById("onboarding");
  const startBtn = document.getElementById("onboardingStart");
  const similarBtn = document.getElementById("onboardingSimilar");
  if (!dialog) return;

  function close(openSimilar) {
    if (dialog.open) dialog.close();
    markSeen();
    const native = core.state.native;
    const target = native ? document.getElementById("similarBtn") : null;
    if (openSimilar && target) {
      target.click();
      return;
    }
    const primary = document.getElementById("pickBtn");
    if (primary && !primary.disabled) primary.click();
  }

  function syncSimilarVisibility() {
    if (!similarBtn) return;
    // 相似照片入口只在原生版出现：启动时原生标记可能还没就绪，所以每次显示时重新判断。
    const native = core.state.native || document.body.dataset.native === "true";
    similarBtn.hidden = !native;
  }

  syncSimilarVisibility();

  if (startBtn) startBtn.addEventListener("click", () => close(false));
  if (similarBtn) {
    similarBtn.addEventListener("click", () => close(true));
  }

  dialog.addEventListener("close", () => {
    if (!dialog.dataset.settled) markSeen();
    dialog.dataset.settled = "";
  });

  function maybeShow() {
    if (seen()) return;
    // 等首屏文案与按钮就绪后再弹出，避免与权限请求打架
    window.setTimeout(() => {
      if (dialog.open) return;
      dialog.dataset.settled = "";
      syncSimilarVisibility();
      try {
        dialog.showModal();
      } catch (_) {
        /* 其他 dialog 打开中，跳过本次 */
      }
    }, 600);
  }

  // 原生与网页都支持，但相似的入口只在原生出现
  if (document.readyState === "complete" || document.readyState === "interactive") {
    maybeShow();
  } else {
    document.addEventListener("DOMContentLoaded", maybeShow, { once: true });
  }
})();
