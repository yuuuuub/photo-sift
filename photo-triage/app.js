/* --------------------------------------------------------------------------
   挑片 / Photo Sift
   Pure client-side photo triage. No uploads, no network calls, no tracking.
   -------------------------------------------------------------------------- */

(() => {
  "use strict";

  const DEMO_ITEMS = [
    { name: "DUNE_001.JPG", src: "demo/01.jpg", date: "2026.10.18", size: "4.2 MB", note: "沙丘 / 黄昏" },
    { name: "PINE_002.JPG", src: "demo/02.jpg", date: "2026.10.21", size: "3.8 MB", note: "松林 / 雾" },
    { name: "TIDE_003.JPG", src: "demo/03.jpg", date: "2026.10.26", size: "4.7 MB", note: "海面 / 蓝调" },
    { name: "DUSK_004.JPG", src: "demo/04.jpg", date: "2026.11.01", size: "3.4 MB", note: "暮色 / 山脊" },
    { name: "BLOOM_005.JPG", src: "demo/05.jpg", date: "2026.11.02", size: "5.1 MB", note: "花 / 虚焦" },
    { name: "SALT_006.JPG", src: "demo/06.jpg", date: "2026.11.02", size: "2.9 MB", note: "盐地 / 正午" }
  ];

  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const state = {
    items: [],
    index: 0,
    history: [],
    stage: "",
    busy: false,
    resultTab: "keep",
    pinnedId: null
  };

  const el = {
    app: document.getElementById("app"),
    intro: document.getElementById("intro"),
    review: document.getElementById("review"),
    finish: document.getElementById("finish"),
    deck: document.getElementById("deck"),
    controls: document.getElementById("controls"),
    introFooter: document.getElementById("introFooter"),
    counts: document.getElementById("counts"),
    keepCount: document.getElementById("keepCount"),
    deleteCount: document.getElementById("deleteCount"),
    localBadge: document.getElementById("localBadge"),
    frameNow: document.getElementById("frameNow"),
    frameTotal: document.getElementById("frameTotal"),
    trackFill: document.getElementById("trackFill"),
    trackTicks: document.getElementById("trackTicks"),
    undoBtn: document.getElementById("undoBtn"),
    deleteBtn: document.getElementById("deleteBtn"),
    keepBtn: document.getElementById("keepBtn"),
    pickBtn: document.getElementById("pickBtn"),
    demoBtn: document.getElementById("demoBtn"),
    fileInput: document.getElementById("fileInput"),
    helpBtn: document.getElementById("helpBtn"),
    helpDialog: document.getElementById("helpDialog"),
    resultsDialog: document.getElementById("resultsDialog"),
    resultGrid: document.getElementById("resultGrid"),
    resultTabs: document.querySelectorAll(".result-tab"),
    tabKeep: document.getElementById("tabKeep"),
    tabDelete: document.getElementById("tabDelete"),
    tabKeepCount: document.getElementById("tabKeepCount"),
    tabDeleteCount: document.getElementById("tabDeleteCount"),
    resultNote: document.getElementById("resultNote"),
    exportDeleteBtn: document.getElementById("exportDeleteBtn"),
    finishSub: document.getElementById("finishSub"),
    finalKeep: document.getElementById("finalKeep"),
    finalDelete: document.getElementById("finalDelete"),
    finishStrip: document.getElementById("finishStrip"),
    viewKeepBtn: document.getElementById("viewKeepBtn"),
    viewDeleteBtn: document.getElementById("viewDeleteBtn"),
    finishUndoBtn: document.getElementById("finishUndoBtn"),
    addMoreBtn: document.getElementById("addMoreBtn"),
    restartBtn: document.getElementById("restartBtn"),
    toast: document.getElementById("toast"),
    toastText: document.getElementById("toastText"),
    toastUndo: document.getElementById("toastUndo"),
    toastTimer: document.getElementById("toastTimer"),
    live: document.getElementById("live")
  };

  let drag = null;
  let toastTimeout = null;
  let toastHideTimeout = null;
  let fileDragDepth = 0;

  /* ------------------------------------------------------------------ utils */

  const pad = (value) => String(value).padStart(2, "0");

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getPending() {
    return state.items.filter((item) => item.status === "pending");
  }

  function getCurrent() {
    const pending = getPending();
    return pending[state.index] || null;
  }

  function getDecisions(status) {
    return state.items.filter((item) => item.status === status);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "未 知";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(timestamp) {
    const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
    if (Number.isNaN(date.getTime())) return "未 知";
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  }

  function fileKey(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
  }

  function isImageFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith("image/")) return true;
    return /\.(jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff?)$/i.test(file.name || "");
  }

  function announce(message) {
    el.live.textContent = "";
    window.setTimeout(() => {
      el.live.textContent = message;
    }, 30);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) {
      try {
        navigator.vibrate(pattern);
      } catch (_) {
        /* unsupported */
      }
    }
  }

  /* --------------------------------------------------------------- rendering */

  function setStage(stage) {
    if (state.stage === stage) return;
    state.stage = stage;
    el.app.dataset.view = stage;
    el.intro.hidden = stage !== "intro";
    el.review.hidden = stage !== "review";
    el.finish.hidden = stage !== "finish";
    el.controls.hidden = stage !== "review";
    el.introFooter.hidden = stage !== "intro";
    el.counts.hidden = stage === "intro";
    el.localBadge.hidden = stage !== "intro";
  }

  function notifyUI() {
    document.dispatchEvent(new CustomEvent("photosift:render"));
  }

  function renderAll() {
    const pending = getPending();
    const kept = getDecisions("keep").length;
    const deleted = getDecisions("delete").length;

    if (state.pinnedId) {
      const pinned = state.items.find((item) => item.id === state.pinnedId);
      if (!pinned || pinned.status !== "pending") state.pinnedId = null;
    }

    el.keepCount.textContent = String(kept);
    el.deleteCount.textContent = String(deleted);
    el.undoBtn.disabled = state.history.length === 0;
    el.finishUndoBtn.hidden = state.history.length === 0;

    const decided = state.items.length ? (kept + deleted) / state.items.length : 0;
    el.trackFill.style.width = `${Math.min(100, decided * 100)}%`;
    el.trackTicks.style.backgroundImage = buildTicks(state.items.length);

    if (!state.items.length) {
      setStage("intro");
      notifyUI();
      return;
    }

    if (!pending.length) {
      hideToast();
      renderFinish();
      setStage("finish");
      notifyUI();
      announce(`整理完成，保留 ${kept} 张，待删除 ${deleted} 张。`);
      return;
    }

    if (state.index >= pending.length) state.index = pending.length - 1;
    if (state.index < 0) state.index = 0;

    setStage("review");
    renderDeck(pending);
    notifyUI();
  }

  function buildTicks(total) {
    if (total < 2) return "none";
    const step = 100 / total;
    const stops = [];
    for (let i = 1; i < total; i += 1) {
      const position = step * i;
      stops.push(`transparent ${position - 0.08}%, rgba(241,233,216,.14) ${position - 0.08}%, rgba(241,233,216,.14) ${position + 0.08}%, transparent ${position + 0.08}%`);
    }
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }

  function renderDeck(pending) {
    const batch = pending.slice(state.index, state.index + 3);
    const fragment = document.createDocumentFragment();

    for (let depth = batch.length - 1; depth >= 0; depth -= 1) {
      const item = batch[depth];
      const absoluteIndex = state.items.indexOf(item);
      fragment.appendChild(createCard(item, depth, absoluteIndex, state.items.length));
    }

    el.deck.replaceChildren(fragment);
    const frontPhoto = el.deck.querySelector('.card[data-depth="0"] .card__photo');
    if (frontPhoto && frontPhoto.complete && frontPhoto.naturalWidth > 0) {
      frontPhoto.classList.add("is-loaded");
      sampleTint(frontPhoto);
    }

    const current = getCurrent();
    if (current) {
      const absolute = state.items.indexOf(current) + 1;
      el.frameNow.textContent = pad(absolute);
      el.frameTotal.textContent = pad(state.items.length);
      announce(`第 ${absolute} 张，共 ${state.items.length} 张。${current.name}。上滑下一张，下滑上一张，左滑删除，右滑保留。`);
    }

    const front = el.deck.querySelector('.card[data-depth="0"]');
    if (front && !REDUCED_MOTION) {
      front.animate(
        [
          { opacity: 0.78, transform: "translateY(8px) scale(0.985)" },
          { opacity: 1, transform: "translateY(0) scale(1)" }
        ],
        { duration: 300, easing: "cubic-bezier(.22,1,.36,1)" }
      );
    }
  }

  function createCard(item, depth, absoluteIndex, total) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.depth = String(depth);
    card.dataset.id = item.id;
    card.setAttribute("role", "group");
    card.setAttribute("aria-roledescription", "照片卡片");
    card.setAttribute(
      "aria-label",
      depth === 0
        ? `第 ${absoluteIndex + 1} 张，共 ${total} 张，${item.name}`
        : "下一张照片"
    );
    if (depth > 0) card.setAttribute("aria-hidden", "true");

    const ambient = document.createElement("img");
    ambient.className = "card__ambient";
    ambient.src = item.url;
    ambient.alt = "";
    ambient.setAttribute("aria-hidden", "true");
    ambient.draggable = false;
    ambient.addEventListener("error", () => {
      ambient.style.display = "none";
    });

    const scrim = document.createElement("div");
    scrim.className = "card__scrim";
    scrim.setAttribute("aria-hidden", "true");

    const photo = document.createElement("img");
    photo.className = "card__photo";
    photo.src = item.url;
    photo.alt = `第 ${absoluteIndex + 1} 张照片：${item.name}`;
    photo.draggable = false;
    photo.decoding = "async";

    const frame = document.createElement("div");
    frame.className = "card__frame";
    frame.setAttribute("aria-hidden", "true");

    const top = document.createElement("div");
    top.className = "card__top";
    top.setAttribute("aria-hidden", "true");

    const idx = document.createElement("span");
    idx.className = "card__idx";
    idx.textContent = pad(absoluteIndex + 1);

    const of = document.createElement("span");
    of.className = "card__of";
    of.textContent = `/ ${pad(total)}`;

    const kind = document.createElement("span");
    kind.className = "card__kind";
    kind.textContent = item.demo ? "SAMPLE FRAME" : "LOCAL FRAME";

    const leftTop = document.createElement("span");
    leftTop.append(idx, document.createTextNode(" "), of);
    top.append(leftTop, kind);

    const info = document.createElement("div");
    info.className = "card__info";
    info.setAttribute("aria-hidden", "true");

    const name = document.createElement("p");
    name.className = "card__name";
    name.textContent = item.name;

    const meta = document.createElement("div");
    meta.className = "card__meta";
    const metaDate = document.createElement("span");
    metaDate.textContent = item.date;
    const metaSize = document.createElement("span");
    metaSize.textContent = item.note || item.size;
    meta.append(metaDate, metaSize);

    info.append(name, meta);

    const deleteStamp = document.createElement("div");
    deleteStamp.className = "card__stamp card__stamp--delete";
    deleteStamp.setAttribute("aria-hidden", "true");
    deleteStamp.innerHTML = "删<small>DISCARD</small>";

    const keepStamp = document.createElement("div");
    keepStamp.className = "card__stamp card__stamp--keep";
    keepStamp.setAttribute("aria-hidden", "true");
    keepStamp.innerHTML = "留<small>KEEP</small>";

    const broken = document.createElement("div");
    broken.className = "card__broken";
    broken.innerHTML = "<b>无法预览</b><span>浏览器暂不支持这个图片格式<br>仍然可以左滑标记删除，或右滑保留</span>";

    photo.addEventListener("load", () => {
      photo.classList.add("is-loaded");
      if (depth === 0 && photo.isConnected) sampleTint(photo);
    });
    photo.addEventListener("error", () => {
      card.classList.add("is-broken");
    });
    if (photo.complete && photo.naturalWidth > 0) {
      photo.classList.add("is-loaded");
      if (depth === 0 && photo.isConnected) sampleTint(photo);
    }

    card.append(ambient, scrim, photo, frame, top, info, deleteStamp, keepStamp, broken);
    return card;
  }

  function sampleTint(image) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 10;
      canvas.height = 10;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, 10, 10);
      const data = ctx.getImageData(0, 0, 10, 10).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 20) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count += 1;
      }
      if (!count) return;
      r = Math.min(255, Math.round((r / count) * 1.22));
      g = Math.min(255, Math.round((g / count) * 1.12));
      b = Math.min(255, Math.round((b / count) * 1.08));
      document.documentElement.style.setProperty("--tint", `${r} ${g} ${b}`);
    } catch (_) {
      /* Canvas can be unavailable in restricted browsers; purely decorative. */
    }
  }

  function renderFinish() {
    const kept = getDecisions("keep");
    const deleted = getDecisions("delete");

    el.finalKeep.textContent = String(kept.length);
    el.finalDelete.textContent = String(deleted.length);
    el.finishSub.textContent = !kept.length
      ? `共 ${state.items.length} 张，全部放进了删除清单。`
      : `共 ${state.items.length} 张，都过了一遍。`;

    el.viewKeepBtn.disabled = kept.length === 0;
    el.viewDeleteBtn.disabled = deleted.length === 0;

    const fragment = document.createDocumentFragment();
    state.items.slice(0, 7).forEach((item) => {
      const thumb = document.createElement("div");
      thumb.className = "finish__thumb";
      if (item.status === "delete") thumb.classList.add("is-deleted");
      thumb.title = item.status === "delete" ? `${item.name} · 待删除` : `${item.name} · 保留`;

      const image = document.createElement("img");
      image.src = item.url;
      image.alt = "";
      image.draggable = false;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => {
        thumb.classList.add("is-broken");
      });
      thumb.appendChild(image);
      fragment.appendChild(thumb);
    });

    if (state.items.length > 7) {
      const more = document.createElement("div");
      more.className = "finish__thumb finish__thumb--more";
      more.textContent = `+${state.items.length - 7}`;
      fragment.appendChild(more);
    }

    el.finishStrip.replaceChildren(fragment);
  }

  /* ------------------------------------------------------------------- toast */

  function showToast(message, options = {}) {
    const { undo = false, tone = "default", duration = 4000 } = options;

    window.clearTimeout(toastTimeout);
    window.clearTimeout(toastHideTimeout);
    el.toastText.textContent = message;
    el.toast.dataset.tone = tone;
    el.toast.classList.toggle("has-undo", Boolean(undo && state.history.length));
    el.toast.classList.remove("is-show");
    el.toastTimer.style.animation = "none";
    // Force a reflow so the timer can restart.
    void el.toast.offsetWidth;
    el.toast.classList.add("is-show");
    el.toastTimer.style.animation = "";

    toastTimeout = window.setTimeout(() => {
      hideToast();
    }, duration);
  }

  function hideToast() {
    el.toast.classList.remove("is-show");
    window.clearTimeout(toastTimeout);
    toastHideTimeout = window.setTimeout(() => {
      el.toast.classList.remove("has-undo");
    }, 350);
  }

  /* ---------------------------------------------------------------- decisions */

  function applyDecision(item, action, options = {}) {
    const current = getCurrent();
    const currentId = current ? current.id : null;
    item.status = action === "delete" ? "delete" : "keep";
    state.history.push({ id: item.id });
    if (state.pinnedId === item.id) state.pinnedId = null;
    if (options.preserveCurrent && currentId && currentId !== item.id) {
      const pending = getPending();
      const nextIndex = pending.findIndex((entry) => entry.id === currentId);
      if (nextIndex >= 0) state.index = nextIndex;
    }
  }

  function jumpToPending(item) {
    if (!item || item.status !== "pending") return;
    const pending = getPending();
    const index = pending.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    state.index = index;
    renderAll();
  }

  async function decide(action, gesture = {}) {
    if (state.busy || state.stage !== "review") return;
    const current = getCurrent();
    if (!current) return;

    const front = el.deck.querySelector('.card[data-depth="0"]');
    if (!front) return;

    state.busy = true;
    setDecisionButtons(false);

    const dx = Number(gesture.dx) || 0;
    const dy = Number(gesture.dy) || 0;
    const direction = action === "delete" ? -1 : 1;
    const distance = Math.max(window.innerWidth, 620) * 0.92;

    vibrate(action === "delete" ? [7, 22, 7] : 8);

    const animation = front.animate(
      [
        {
          transform: `translate3d(${dx}px, ${dy}px, 0) rotate(${dx * 0.045}deg) scale(1)`,
          opacity: 1
        },
        {
          transform: `translate3d(${direction * distance}px, ${dy * 0.32 - 24}px, 0) rotate(${direction * 17}deg) scale(0.93)`,
          opacity: 0.28
        }
      ],
      {
        duration: REDUCED_MOTION ? 1 : 285,
        easing: "cubic-bezier(.3,.02,.25,1)",
        fill: "forwards"
      }
    );

    await animation.finished.catch(() => {});

    applyDecision(current, action);
    state.busy = false;
    setDecisionButtons(true);

    renderAll();

    const total = state.items.length;
    const decidedCount = state.items.filter((item) => item.status !== "pending").length;
    announce(
      action === "delete"
        ? `已标记删除。已整理 ${decidedCount} 张，共 ${total} 张。`
        : `已保留。已整理 ${decidedCount} 张，共 ${total} 张。`
    );
  }

  function setDecisionButtons(enabled) {
    el.deleteBtn.disabled = !enabled;
    el.keepBtn.disabled = !enabled;
  }

  function undoDecision() {
    if (!state.history.length || state.busy) return;
    const last = state.history.pop();
    const item = state.items.find((entry) => entry.id === last.id);
    if (!item) return;

    item.status = "pending";
    const pending = getPending();
    state.index = pending.findIndex((entry) => entry.id === item.id);
    if (state.index < 0) state.index = 0;

    hideToast();
    renderAll();
    showToast("已撤销上一次决定", { duration: 2400 });
    announce(`已撤销。回到 ${item.name}。`);
  }

  /* --------------------------------------------------------------- navigation */

  async function navigate(direction, gesture = {}) {
    if (state.busy || state.stage !== "review") return;
    const pending = getPending();
    const nextIndex = state.index + (direction === "next" ? 1 : -1);
    const frontCard = el.deck.querySelector('.card[data-depth="0"]');

    if (nextIndex < 0) {
      if (frontCard) springBack(frontCard);
      showToast("已经是第一张", { duration: 1800 });
      return;
    }

    if (nextIndex >= pending.length) {
      if (frontCard) springBack(frontCard);
      showToast("已经是最后一张，做决定吧", { duration: 2000 });
      return;
    }

    const front = frontCard;
    if (!front) return;

    state.busy = true;
    const dy = Number(gesture.dy) || 0;
    const travel = front.offsetHeight + 70;
    const toY = direction === "next" ? -travel : travel;

    const animation = front.animate(
      [
        { transform: `translate3d(0, ${dy}px, 0) scale(1)`, opacity: 1 },
        {
          transform: `translate3d(0, ${toY}px, 0) scale(0.96)`,
          opacity: direction === "next" ? 0.15 : 0.35
        }
      ],
      {
        duration: REDUCED_MOTION ? 1 : 255,
        easing: "cubic-bezier(.4,0,.22,1)",
        fill: "forwards"
      }
    );

    await animation.finished.catch(() => {});

    state.index = nextIndex;
    state.busy = false;
    renderAll();

    const newFront = el.deck.querySelector('.card[data-depth="0"]');
    if (newFront && !REDUCED_MOTION) {
      newFront.animate(
        [
          {
            transform: `translateY(${direction === "next" ? 10 : -10}px) scale(0.982)`,
            opacity: 0.78
          },
          { transform: "translateY(0) scale(1)", opacity: 1 }
        ],
        { duration: 260, easing: "cubic-bezier(.22,1,.36,1)" }
      );
    }

    const current = getCurrent();
    if (current) {
      const absolute = state.items.indexOf(current) + 1;
      announce(`第 ${absolute} 张，共 ${state.items.length} 张。${current.name}。`);
    }
  }

  /* ------------------------------------------------------------------- drag */

  function onPointerDown(event) {
    if (state.busy || state.stage !== "review") return;
    if (event.button !== undefined && event.button !== 0) return;
    if (!event.isPrimary) return;

    const front = el.deck.querySelector('.card[data-depth="0"]');
    if (!front || !el.deck.contains(event.target)) return;

    const now = performance.now();
    drag = {
      card: front,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: now,
      dx: 0,
      dy: 0,
      vx: 0,
      vy: 0,
      axis: null,
      moved: false
    };

    front.classList.remove("is-springing");
    front.classList.add("is-dragging");
    el.deck.classList.add("is-dragging");

    try {
      el.deck.setPointerCapture(event.pointerId);
    } catch (_) {
      /* pointer capture can fail on older Safari */
    }

    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;

    const now = performance.now();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const dt = Math.max(1, now - drag.lastTime);

    drag.vx = (event.clientX - drag.lastX) / dt;
    drag.vy = (event.clientY - drag.lastY) / dt;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.lastTime = now;
    drag.dx = dx;
    drag.dy = dy;

    if (!drag.axis && Math.hypot(dx, dy) > 7) {
      drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      drag.moved = true;
      if (drag.axis === "x") el.deck.classList.add("is-horizontal");
    }

    const card = drag.card;
    if (drag.axis === "x") {
      const rotation = Math.max(-14, Math.min(14, dx * 0.045));
      const lift = Math.max(-18, Math.min(18, dy * 0.22));
      card.style.transform = `translate3d(${dx}px, ${lift}px, 0) rotate(${rotation}deg) scale(${1 - Math.min(0.035, Math.abs(dx) / 4200)})`;
      updateStamps(card, dx, dy);
    } else if (drag.axis === "y") {
      const resistance = dy > 0 && state.index === 0 ? 0.32 : dy < 0 && state.index >= getPending().length - 1 ? 0.32 : 1;
      card.style.transform = `translate3d(${dx * 0.08}px, ${dy * resistance}px, 0) scale(${1 - Math.min(0.025, Math.abs(dy) / 7000)})`;
      updateStamps(card, 0, dy);
    }
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;

    const currentDrag = drag;
    drag = null;
    const { card, dx, dy, vx, vy, axis } = currentDrag;

    card.classList.remove("is-dragging");
    el.deck.classList.remove("is-dragging", "is-horizontal");

    try {
      el.deck.releasePointerCapture(event.pointerId);
    } catch (_) {
      /* noop */
    }

    const width = card.offsetWidth || 320;
    const horizontalThreshold = Math.min(122, width * 0.28);
    const verticalThreshold = Math.min(96, (card.offsetHeight || 440) * 0.16);

    const horizontalFlick = Math.abs(vx) > 0.55 && Math.abs(dx) > 34;
    const verticalFlick = Math.abs(vy) > 0.5 && Math.abs(dy) > 34;

    if (axis === "x" && (Math.abs(dx) > horizontalThreshold || horizontalFlick)) {
      decide(dx < 0 ? "delete" : "keep", { dx, dy });
      return;
    }

    if (axis === "y" && (Math.abs(dy) > verticalThreshold || verticalFlick)) {
      navigate(dy < 0 ? "next" : "prev", { dy });
      return;
    }

    springBack(card);
  }

  function onPointerCancel(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const card = drag.card;
    drag = null;
    card.classList.remove("is-dragging");
    el.deck.classList.remove("is-dragging", "is-horizontal");
    springBack(card);
  }

  function updateStamps(card, dx, dy) {
    const deleteStamp = card.querySelector(".card__stamp--delete");
    const keepStamp = card.querySelector(".card__stamp--keep");
    if (!deleteStamp || !keepStamp) return;

    if (dx < -8) {
      const progress = Math.min(1, (Math.abs(dx) - 8) / 94);
      deleteStamp.style.opacity = String(progress * 0.97);
      deleteStamp.style.transform = `rotate(9deg) scale(${0.92 + progress * 0.08})`;
      keepStamp.style.opacity = "0";
    } else if (dx > 8) {
      const progress = Math.min(1, (dx - 8) / 94);
      keepStamp.style.opacity = String(progress * 0.97);
      keepStamp.style.transform = `rotate(-9deg) scale(${0.92 + progress * 0.08})`;
      deleteStamp.style.opacity = "0";
    } else {
      deleteStamp.style.opacity = "0";
      keepStamp.style.opacity = "0";
    }
  }

  function springBack(card) {
    const deleteStamp = card.querySelector(".card__stamp--delete");
    const keepStamp = card.querySelector(".card__stamp--keep");
    if (deleteStamp) {
      deleteStamp.style.opacity = "0";
      deleteStamp.style.transform = "";
    }
    if (keepStamp) {
      keepStamp.style.opacity = "0";
      keepStamp.style.transform = "";
    }
    card.classList.add("is-springing");
    card.style.transform = "";
    window.setTimeout(() => {
      card.classList.remove("is-springing");
    }, 540);
  }

  /* --------------------------------------------------------------- files/demo */

  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(isImageFile);
    if (!files.length) {
      showToast("没有找到可读取的图片", { duration: 2600 });
      return;
    }

    const existing = new Set(state.items.filter((item) => item.key).map((item) => item.key));
    const unique = [];
    let skipped = 0;

    files.forEach((file) => {
      const key = fileKey(file);
      if (existing.has(key)) {
        skipped += 1;
        return;
      }
      existing.add(key);
      unique.push(file);
    });

    if (!unique.length) {
      showToast("这些照片已经在本次整理里了", { duration: 2800 });
      return;
    }

    const room = Math.max(0, 300 - state.items.length);
    if (!room) {
      showToast("一次最多整理 300 张照片", { duration: 3000 });
      return;
    }
    const accepted = unique.slice(0, room);
    const overflow = unique.length - accepted.length;

    accepted.forEach((file) => {
      state.items.push({
        id: makeId(),
        key: fileKey(file),
        name: file.name || "未命名照片",
        url: URL.createObjectURL(file),
        timestamp: file.lastModified,
        date: formatDate(file.lastModified),
        size: formatBytes(file.size),
        status: "pending",
        demo: false,
        file
      });
    });

    const firstNew = state.items.find((item) => item.status === "pending" && !item.seen);
    // Mark every item as seen so the next load can find the true first new one.
    state.items.forEach((item) => {
      item.seen = true;
    });
    const pending = getPending();
    state.index = Math.max(0, pending.findIndex((item) => item === firstNew));

    renderAll();

    const parts = [`载入 ${accepted.length} 张照片`];
    if (skipped) parts.push(`跳过 ${skipped} 张重复`);
    if (overflow) parts.push(`超出上限 ${overflow} 张`);
    showToast(parts.join(" · "), { duration: 3200 });
    announce(`已载入 ${accepted.length} 张照片，共 ${state.items.length} 张。`);
  }

  function loadDemo({ silent = false } = {}) {
    if (state.items.some((item) => item.demo)) {
      if (!silent) showToast("示例照片已经在里面了", { duration: 2200 });
      return;
    }

    DEMO_ITEMS.forEach((demo) => {
      state.items.push({
        id: makeId(),
        key: `demo|${demo.src}`,
        name: demo.name,
        url: demo.src,
        timestamp: (Date.parse(demo.date.replace(/\./g, "-")) || 0) + DEMO_ITEMS.indexOf(demo) * 3600000,
        date: demo.date,
        size: demo.size,
        note: demo.note,
        status: "pending",
        demo: true,
        seen: true
      });
    });

    const pending = getPending();
    state.index = Math.max(0, pending.findIndex((item) => item.demo));
    renderAll();

    if (!silent) {
      showToast("示例照片已载入 · 这些不是你的相册", { duration: 3400 });
    }
    announce(`示例照片已载入，共 ${DEMO_ITEMS.length} 张。`);
  }

  /* ------------------------------------------------------------------- finish */

  function resetItems() {
    state.items.forEach((item) => {
      item.status = "pending";
    });
    state.history = [];
    state.pinnedId = null;
    state.index = 0;
    hideToast();
    renderAll();
    showToast("已重新开始，照片都还在", { duration: 2600 });
    announce("已重新开始整理。");
  }

  function openResults(tab) {
    state.resultTab = tab;
    renderResults();
    if (!el.resultsDialog.open) el.resultsDialog.showModal();
  }

  function renderResults() {
    const kept = getDecisions("keep");
    const deleted = getDecisions("delete");
    const active = state.resultTab === "delete" ? "delete" : "keep";

    el.tabKeepCount.textContent = String(kept.length);
    el.tabDeleteCount.textContent = String(deleted.length);

    el.resultTabs.forEach((tab) => {
      const selected = tab.dataset.tab === active;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });

    el.resultGrid.setAttribute("aria-labelledby", active === "delete" ? "tabDelete" : "tabKeep");
    const items = active === "delete" ? deleted : kept;
    const fragment = document.createDocumentFragment();

    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "result-empty";
      empty.textContent = active === "delete" ? "删除清单是空的。" : "还没有保留的照片。";
      fragment.appendChild(empty);
    } else {
      items.forEach((item) => {
        const figure = document.createElement("figure");
        figure.className = "result-item";
        figure.title = item.name;

        const image = document.createElement("img");
        image.src = item.url;
        image.alt = item.name;
        image.draggable = false;
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener("error", () => {
          figure.style.opacity = "0.35";
        });

        const caption = document.createElement("figcaption");
        caption.textContent = item.name;

        figure.append(image, caption);
        fragment.appendChild(figure);
      });
    }

    el.resultGrid.replaceChildren(fragment);
    el.resultNote.textContent =
      active === "delete"
        ? "网页不能直接删除系统相册中的照片，请按这份清单手动清理。"
        : "这些照片仍保存在本页里，刷新后清空。";
    el.exportDeleteBtn.disabled = deleted.length === 0;
  }

  function exportDeleteList() {
    const deleted = getDecisions("delete");
    if (!deleted.length) {
      showToast("删除清单是空的", { duration: 2200 });
      return;
    }

    const now = new Date();
    const dateLabel = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const lines = [
      "挑片 · 待删除清单",
      `导出时间：${now.toLocaleString("zh-CN", { hour12: false })}`,
      `共 ${deleted.length} 张`,
      "",
      ...deleted.map((item, index) => `${pad(index + 1)}. ${item.name}${item.date ? `    (${item.date})` : ""}`),
      "",
      "提示：网页没有权限直接删除系统相册里的照片。",
      "请打开手机相册，按以上文件名逐张手动删除。"
    ];

    const blob = new Blob([`\ufeff${lines.join("\r\n")}`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `挑片-删除清单-${dateLabel}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);

    if (el.resultsDialog.open) {
      el.exportDeleteBtn.textContent = "已导出 ✓";
      window.setTimeout(() => {
        el.exportDeleteBtn.textContent = "导出删除清单";
      }, 1800);
    } else {
      showToast("删除清单已导出", { duration: 2600 });
    }
  }

  /* ----------------------------------------------------------------- dialogs */

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
  }

  function handleDialogBackdrop(event) {
    const dialog = event.currentTarget;
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) dialog.close();
  }

  function setupDialogs() {
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => closeDialog(button.closest("dialog")));
    });

    [el.helpDialog, el.resultsDialog].forEach((dialog) => {
      dialog.addEventListener("click", handleDialogBackdrop);
    });

    el.helpBtn.addEventListener("click", () => {
      if (!el.helpDialog.open) el.helpDialog.showModal();
    });

    el.viewKeepBtn.addEventListener("click", () => openResults("keep"));
    el.viewDeleteBtn.addEventListener("click", () => openResults("delete"));

    el.resultTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        state.resultTab = tab.dataset.tab;
        renderResults();
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = event.key === "ArrowRight" ? "delete" : "keep";
        state.resultTab = next;
        renderResults();
        document.getElementById(next === "delete" ? "tabDelete" : "tabKeep").focus();
      });
    });

    el.exportDeleteBtn.addEventListener("click", exportDeleteList);
  }

  /* ------------------------------------------------------------------- input */

  function setupInput() {
    el.pickBtn.addEventListener("click", () => el.fileInput.click());
    el.demoBtn.addEventListener("click", () => loadDemo());
    el.addMoreBtn.addEventListener("click", () => el.fileInput.click());

    el.fileInput.addEventListener("change", () => {
      if (el.fileInput.files && el.fileInput.files.length) {
        addFiles(el.fileInput.files);
      }
      el.fileInput.value = "";
      // Keep keyboard shortcuts live after the native picker closes.
      el.fileInput.blur();
    });

    el.deleteBtn.addEventListener("click", () => decide("delete"));
    el.keepBtn.addEventListener("click", () => decide("keep"));
    el.undoBtn.addEventListener("click", undoDecision);
    el.finishUndoBtn.addEventListener("click", undoDecision);
    el.toastUndo.addEventListener("click", undoDecision);
    el.restartBtn.addEventListener("click", resetItems);

    el.deck.addEventListener("pointerdown", onPointerDown);
    el.deck.addEventListener("pointermove", onPointerMove);
    el.deck.addEventListener("pointerup", onPointerUp);
    el.deck.addEventListener("pointercancel", onPointerCancel);
    el.deck.addEventListener("contextmenu", (event) => event.preventDefault());
    el.deck.addEventListener("dragstart", (event) => event.preventDefault());

    document.addEventListener("keydown", onKeyDown);

    setupDropZone();
  }

  function onKeyDown(event) {
    if (document.querySelector("dialog[open]")) return;
    const target = event.target;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (target && target.isContentEditable) return;

    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && key === "z") {
      event.preventDefault();
      undoDecision();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        navigate("next");
        break;
      case "ArrowDown":
        event.preventDefault();
        navigate("prev");
        break;
      case "ArrowLeft":
        event.preventDefault();
        decide("delete");
        break;
      case "ArrowRight":
        event.preventDefault();
        decide("keep");
        break;
      case "z":
      case "Z":
        event.preventDefault();
        undoDecision();
        break;
      case "o":
      case "O":
        event.preventDefault();
        el.fileInput.click();
        break;
      default:
        break;
    }
  }

  function setupDropZone() {
    const hasFiles = (event) => {
      const types = event.dataTransfer && event.dataTransfer.types;
      return types && Array.from(types).includes("Files");
    };

    window.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      fileDragDepth += 1;
      document.body.classList.add("is-file-drag");
    });

    window.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });

    window.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      fileDragDepth = Math.max(0, fileDragDepth - 1);
      if (fileDragDepth === 0) document.body.classList.remove("is-file-drag");
    });

    window.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      fileDragDepth = 0;
      document.body.classList.remove("is-file-drag");
      addFiles(event.dataTransfer.files);
    });
  }

  /* -------------------------------------------------------------------- init */

  function openZoom(item) {
    if (!item || state.stage !== "review") return;
    document.dispatchEvent(new CustomEvent("photosift:open-zoom", { detail: { id: item.id } }));
  }
  window.PhotoSiftCore = {
    state,
    el,
    getCurrent,
    getPending,
    applyDecision,
    jumpToPending,
    openZoom,
    renderAll,
    showToast,
    announce
  };

  function init() {
    setupDialogs();
    setupInput();
    setDecisionButtons(true);
    renderAll();

    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") {
      loadDemo({ silent: true });
    }
  }

  window.addEventListener("beforeunload", () => {
    state.items.forEach((item) => {
      if (!item.demo && item.url && item.url.startsWith("blob:")) {
        URL.revokeObjectURL(item.url);
      }
    });
  });

  init();
})();
