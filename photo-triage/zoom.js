/* --------------------------------------------------------------------------
   挑片 — pinch / double-tap zoom for the current card
   Depends on window.PhotoSiftCore exposed by app.js.
   -------------------------------------------------------------------------- */

(() => {
  "use strict";

  const core = window.PhotoSiftCore;
  if (!core) return;

  const { state, getCurrent } = core;
  const $ = (id) => document.getElementById(id);

  const viewer = $("zoomViewer");
  const stage = $("zoomStage");
  const image = $("zoomImage");
  const zoomOutBtn = $("zoomOutBtn");
  const counter = $("zoomCounter");
  if (!viewer || !stage || !image || !core.el.deck) return;

  const MAX_SCALE = 6;
  const DOUBLE_TAP_MS = 280;
  const DOUBLE_TAP_DIST = 28;

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let pinchStart = null;
  let panStart = null;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let activeItem = null;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function applyTransform(animate) {
    image.classList.toggle("is-animating", Boolean(animate));
    image.style.transform = `translate3d(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`;
    viewer.classList.toggle("is-zoomed", scale > 1.01);
    zoomOutBtn.disabled = scale <= 1.01;
    zoomOutBtn.textContent = `${scale.toFixed(1)}×`;
  }

  function limitOffset() {
    if (scale <= 1.01) {
      offsetX = 0;
      offsetY = 0;
      return;
    }
    const rect = image.getBoundingClientRect();
    const baseWidth = rect.width / scale;
    const baseHeight = rect.height / scale;
    const maxX = Math.max(0, (baseWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (baseHeight * scale - stage.clientHeight) / 2);
    offsetX = clamp(offsetX, -maxX, maxX);
    offsetY = clamp(offsetY, -maxY, maxY);
  }

  function setScale(nextScale, anchorX, anchorY, animate) {
    const previous = scale;
    const target = clamp(nextScale, 1, MAX_SCALE);
    if (Math.abs(target - previous) < 0.001) return;

    if (anchorX !== undefined && anchorY !== undefined && target > 1) {
      const rect = stage.getBoundingClientRect();
      const cx = anchorX - rect.left - rect.width / 2;
      const cy = anchorY - rect.top - rect.height / 2;
      const ratio = target / previous;
      offsetX = cx - (cx - offsetX) * ratio;
      offsetY = cy - (cy - offsetY) * ratio;
    }

    scale = target;
    limitOffset();
    applyTransform(animate);
  }

  function resetView(animate) {
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    limitOffset();
    applyTransform(animate);
  }

  function renderCounter() {
    if (!activeItem) {
      counter.textContent = "";
      return;
    }
    const absolute = state.items.indexOf(activeItem) + 1;
    counter.textContent = `${absolute} / ${state.items.length} · ${activeItem.name}`;
  }

  function open() {
    const current = getCurrent();
    if (!current || state.stage !== "review") return;
    if (current.url !== image.getAttribute("src")) {
      image.src = current.url;
    }
    activeItem = current;
    image.alt = `放大的照片：${current.name}`;
    resetView(false);
    renderCounter();
    if (!viewer.open) viewer.showModal();
  }

  function close() {
    if (viewer.open) viewer.close();
    activeItem = null;
    resetView(false);
  }

  stage.addEventListener("wheel", (event) => {
    if (!viewer.open) return;
    event.preventDefault();
    const step = event.deltaY < 0 ? 1.18 : 1 / 1.18;
    setScale(scale * step, event.clientX, event.clientY, false);
  }, { passive: false });

  stage.addEventListener("dblclick", (event) => {
    event.preventDefault();
    if (scale > 1.01) {
      resetView(true);
    } else {
      setScale(2.5, event.clientX, event.clientY, true);
    }
  });

  const touches = new Map();

  stage.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    try {
      stage.setPointerCapture(event.pointerId);
    } catch (_) {
      /* older Safari */
    }

    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        panStart = null;
        pinchStart = {
          distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          scale,
          centerX: (a.x + b.x) / 2,
          centerY: (a.y + b.y) / 2
        };
        return;
      }
    }

    if (!event.isPrimary) return;

    if (scale > 1.01) {
      panStart = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        offsetX,
        offsetY
      };
    } else {
      const now = performance.now();
      const nearLast = Math.abs(event.clientX - lastTapX) < DOUBLE_TAP_DIST &&
        Math.abs(event.clientY - lastTapY) < DOUBLE_TAP_DIST;
      if (now - lastTapAt < DOUBLE_TAP_MS && nearLast) {
        setScale(2.5, event.clientX, event.clientY, true);
        lastTapAt = 0;
        return;
      }
      lastTapAt = now;
      lastTapX = event.clientX;
      lastTapY = event.clientY;
    }
  });

  stage.addEventListener("pointermove", (event) => {
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (pinchStart && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      setScale(pinchStart.scale * (distance / pinchStart.distance), pinchStart.centerX, pinchStart.centerY, false);
      return;
    }

    if (panStart && event.pointerId === panStart.pointerId) {
      offsetX = panStart.offsetX + (event.clientX - panStart.x);
      offsetY = panStart.offsetY + (event.clientY - panStart.y);
      limitOffset();
      applyTransform(false);
    }
  });

  stage.addEventListener("pointerup", (event) => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinchStart = null;
    if (panStart && event.pointerId === panStart.pointerId) {
      panStart = null;
      if (scale <= 1.01) resetView(true);
    }
  });

  stage.addEventListener("pointercancel", () => {
    panStart = null;
    pinchStart = null;
  });

  zoomOutBtn.addEventListener("click", () => resetView(true));

  viewer.addEventListener("click", (event) => {
    if (event.target !== viewer) return;
    const rect = stage.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) close();
  });

  viewer.addEventListener("close", () => {
    activeItem = null;
    resetView(false);
  });

  document.addEventListener("photosift:open-zoom", open);
  document.addEventListener("photosift:render", () => {
    if (viewer.open) renderCounter();
  });
})();
