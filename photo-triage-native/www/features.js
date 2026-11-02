/* --------------------------------------------------------------------------
   挑片 — comparison pin + burst-aware filmstrip
   Depends on window.PhotoSiftCore exposed by app.js.
   -------------------------------------------------------------------------- */

(() => {
  "use strict";

  const core = window.PhotoSiftCore;
  if (!core) return;

  const { state, getCurrent, getPending, applyDecision, jumpToPending, renderAll, showToast, announce } = core;
  const BURST_GAP_MS = 2500;
  const FILM_WINDOW = 15;

  const $ = (id) => document.getElementById(id);
  const ui = {
    pinBtn: $("pinBtn"),
    pinLabel: $("pinBtn") ? $("pinBtn").querySelector("span") : null,
    pinSlot: $("pinSlot"),
    pinCardBtn: $("pinCardBtn"),
    pinThumb: $("pinThumb"),
    pinClearBtn: $("pinClearBtn"),
    filmstripWrap: $("filmstripWrap"),
    filmstrip: $("filmstrip"),
    burstInfo: $("burstInfo"),
    filmstripCounter: $("filmstripCounter"),
    compareDialog: $("compareDialog"),
    compareBody: $("compareBody"),
    comparePinnedImg: $("comparePinnedImg"),
    compareCurrentImg: $("compareCurrentImg"),
    comparePinnedName: $("comparePinnedName"),
    compareCurrentName: $("compareCurrentName"),
    compareKeepBtn: $("compareKeepBtn"),
    compareDeleteBtn: $("compareDeleteBtn")
  };

  if (!ui.pinBtn || !ui.filmstripWrap || !ui.compareDialog) return;

  function getPinned() {
    if (!state.pinnedId) return null;
    const item = state.items.find((entry) => entry.id === state.pinnedId);
    return item && item.status === "pending" ? item : null;
  }

  function burstGroups(items) {
    const groups = [];
    let group = [];
    let previousTimestamp = 0;

    items.forEach((item) => {
      const timestamp = Number(item.timestamp) || 0;
      if (!group.length) {
        group = [item];
      } else if (timestamp && previousTimestamp && Math.abs(timestamp - previousTimestamp) <= BURST_GAP_MS) {
        group.push(item);
      } else {
        groups.push(group);
        group = [item];
      }
      previousTimestamp = timestamp;
    });

    if (group.length) groups.push(group);
    return groups;
  }

  function statusLabel(item) {
    if (item.status === "keep") return "已保留";
    if (item.status === "delete") return "待删除";
    if (item.status === "deleted") return "已删除";
    return "待整理";
  }

  function groupForItem(item, groups) {
    return groups.find((group) => group.some((entry) => entry.id === item.id)) || [item];
  }

  function setPinButton(pinned, current) {
    if (!ui.pinBtn) return;
    const active = Boolean(pinned && current && pinned.id === current.id);
    const hasPinned = Boolean(pinned);
    ui.pinBtn.classList.toggle("is-active", active);
    ui.pinBtn.setAttribute("aria-pressed", String(active));
    ui.pinBtn.disabled = !current || state.stage !== "review";
    ui.pinBtn.setAttribute(
      "aria-label",
      active ? "取消挂起当前照片" : hasPinned ? "用当前照片替换挂起的照片" : "挂起当前照片用于对比"
    );
    if (ui.pinLabel) ui.pinLabel.textContent = active ? "取消" : hasPinned ? "替换" : "挂起";
  }

  function renderPinSlot(pinned) {
    const visible = Boolean(pinned) && state.stage === "review";
    ui.pinSlot.hidden = !visible;
    if (!visible) return;

    if (ui.pinThumb.getAttribute("src") !== pinned.url) {
      ui.pinThumb.src = pinned.url;
    }
    ui.pinThumb.alt = "";
    ui.pinCardBtn.setAttribute("aria-label", `对比挂起的照片：${pinned.name}`);
  }

  function centerCurrentThumb(current) {
    const target = ui.filmstrip.querySelector(".filmstrip__item.is-current");
    if (!target) return;
    const key = `${current.id}:${state.index}:${state.items.length}`;
    if (ui.filmstrip.dataset.centeredKey === key) return;
    ui.filmstrip.dataset.centeredKey = key;
    requestAnimationFrame(() => {
      const targetRect = target.getBoundingClientRect();
      const stripRect = ui.filmstrip.getBoundingClientRect();
      const targetCenter = targetRect.left - stripRect.left + ui.filmstrip.scrollLeft + targetRect.width / 2;
      const left = Math.max(0, targetCenter - ui.filmstrip.clientWidth / 2);
      try {
        ui.filmstrip.scrollTo({
          left,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
        });
      } catch (_) {
        ui.filmstrip.scrollLeft = left;
      }
    });
  }

  function renderFilmstrip(current, pinned) {
    if (state.stage !== "review" || !current) {
      ui.filmstripWrap.hidden = true;
      return;
    }

    ui.filmstripWrap.hidden = false;
    const groups = burstGroups(state.items);
    const flat = [];
    groups.forEach((group) => {
      group.forEach((item, groupIndex) => {
        flat.push({ item, group, groupIndex });
      });
    });

    const currentFlatIndex = flat.findIndex((entry) => entry.item.id === current.id);
    if (currentFlatIndex < 0) {
      ui.filmstripWrap.hidden = true;
      return;
    }

    const start = Math.max(0, currentFlatIndex - FILM_WINDOW);
    const end = Math.min(flat.length, currentFlatIndex + FILM_WINDOW + 1);
    const fragment = document.createDocumentFragment();

    for (let i = start; i < end; i += 1) {
      const { item, group, groupIndex } = flat[i];
      const cell = document.createElement("div");
      cell.className = "filmstrip__cell";
      if (groupIndex === 0 && group.length > 1) cell.classList.add("is-burst-start");
      cell.setAttribute("role", "listitem");

      const button = document.createElement("button");
      button.className = "filmstrip__item";
      button.type = "button";
      button.dataset.id = item.id;
      button.setAttribute(
        "aria-label",
        `${item.name}，${statusLabel(item)}${item.id === current.id ? "，当前" : ""}`
      );

      if (item.id === current.id) button.classList.add("is-current");
      if (item.status === "keep") button.classList.add("is-keep");
      if (item.status === "delete") button.classList.add("is-delete");
      if (item.status === "deleted") button.classList.add("is-deleted");
      if (item.id === state.pinnedId) button.classList.add("is-pinned");
      if (groupIndex === 0 && group.length > 1) {
        button.classList.add("is-burst-start");
        const badge = document.createElement("span");
        badge.className = "filmstrip__burst";
        badge.textContent = `×${group.length}`;
        button.appendChild(badge);
      }

      if (item.id === state.pinnedId) {
        const pin = document.createElement("span");
        pin.className = "filmstrip__pin";
        pin.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6M10 4l1 6-3 3h8l-3-3 1-6M12 13v7"/></svg>';
        button.appendChild(pin);
      }

      const image = document.createElement("img");
      image.src = item.url;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.draggable = false;
      image.addEventListener("error", () => button.classList.add("is-broken"));
      button.appendChild(image);

      button.addEventListener("click", () => {
        if (state.busy) return;
        if (item.status === "pending") {
          jumpToPending(item);
        } else {
          showToast(`这张${statusLabel(item)}`, { duration: 1800 });
        }
      });

      cell.appendChild(button);
      fragment.appendChild(cell);
    }

    ui.filmstrip.replaceChildren(fragment);
    ui.filmstrip.classList.toggle("is-sparse", ui.filmstrip.scrollWidth <= ui.filmstrip.clientWidth + 4);

    const currentGroup = groupForItem(current, groups);
    const positionInGroup = currentGroup.findIndex((item) => item.id === current.id) + 1;
    const remainingInGroup = currentGroup.filter((item) => item.status === "pending").length;
    const absolutePosition = state.items.indexOf(current) + 1;

    if (currentGroup.length >= 2) {
      ui.burstInfo.textContent = `连拍 ${currentGroup.length} 张 · 第 ${positionInGroup} 张 · 本组还剩 ${remainingInGroup} 张`;
    } else {
      ui.burstInfo.textContent = `单张 · 第 ${absolutePosition} / ${state.items.length}`;
    }
    ui.filmstripCounter.textContent = `余 ${getPending().length} / ${state.items.length}`;

    centerCurrentThumb(current);
  }

  function render() {
    const current = getCurrent();
    const pinned = getPinned();

    if (state.pinnedId && !pinned) state.pinnedId = null;

    setPinButton(pinned, current);
    renderPinSlot(pinned);
    renderFilmstrip(current, pinned);
  }

  function togglePin() {
    if (state.busy || state.stage !== "review") return;
    const current = getCurrent();
    if (!current) return;

    const pinned = getPinned();
    if (pinned && pinned.id === current.id) {
      state.pinnedId = null;
      announce("已取消挂起。");
    } else {
      state.pinnedId = current.id;
      announce(pinned ? "已替换挂起照片。" : "已挂起当前照片。");
      if (navigator.vibrate) {
        try { navigator.vibrate(8); } catch (_) {}
      }
    }
    renderAll();
  }

  function openCompare() {
    const pinned = getPinned();
    if (!pinned) {
      showToast("还没有挂起的照片", { duration: 2000 });
      return;
    }

    const current = getCurrent();
    const same = !current || current.id === pinned.id;
    ui.compareBody.classList.toggle("is-single", same);
    ui.comparePinnedImg.src = pinned.url;
    ui.comparePinnedImg.alt = `挂起的照片：${pinned.name}`;
    ui.comparePinnedName.textContent = pinned.name;
    ui.compareCurrentImg.src = current ? current.url : pinned.url;
    ui.compareCurrentImg.alt = current ? `当前照片：${current.name}` : "";
    ui.compareCurrentName.textContent = current ? current.name : "—";
    ui.compareKeepBtn.disabled = false;
    ui.compareDeleteBtn.disabled = false;

    if (!ui.compareDialog.open) ui.compareDialog.showModal();
  }

  function decidePinned(action) {
    const pinned = getPinned();
    if (!pinned) {
      if (ui.compareDialog.open) ui.compareDialog.close();
      return;
    }

    if (ui.compareDialog.open) ui.compareDialog.close();
    applyDecision(pinned, action, { preserveCurrent: true });
    renderAll();
    announce(action === "delete" ? "已标记删除挂起的照片。" : "已保留挂起的照片。");
  }

  function closeCompareFromBackdrop(event) {
    const dialog = event.currentTarget;
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      dialog.close();
    }
  }

  ui.pinBtn.addEventListener("click", togglePin);
  ui.pinCardBtn.addEventListener("click", openCompare);
  ui.pinClearBtn.addEventListener("click", () => {
    state.pinnedId = null;
    renderAll();
    announce("已取消挂起。");
  });
  ui.compareKeepBtn.addEventListener("click", () => decidePinned("keep"));
  ui.compareDeleteBtn.addEventListener("click", () => decidePinned("delete"));
  ui.compareDialog.addEventListener("click", closeCompareFromBackdrop);

  document.addEventListener("photosift:render", render);
  render();
})();
