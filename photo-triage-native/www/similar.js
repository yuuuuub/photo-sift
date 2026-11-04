/* --------------------------------------------------------------------------
   挑片 — 相似照片模式
   1) 扫描相册范围内的照片
   2) 用感知哈希把连拍 / 同一场景的照片聚成组
   3) 每组自动推荐最清晰的一张保留，其余可批量标记删除
   依赖 window.PhotoSiftCore 与 window.PhotoSiftNative
   -------------------------------------------------------------------------- */

(() => {
  "use strict";

  const core = window.PhotoSiftCore;
  const native = window.PhotoSiftNative;
  if (!core || !native || !native.isNative) return;

  const SCREEN_SIZES = [8, 6];
  const SIMILAR_MAX_DISTANCE = { 8: 12, 6: 9 };
  const MIN_PAIR_SCORE = 0.72;
  const BUILTIN_MIN_AVG = 0.86;
  const LOAD_PAGE = 300;
  const RANGE_OPTIONS = [300, 1000, 2000, -1];

  const state = {
    total: 0,
    range: 0,
    items: [],
    groups: [],
    decided: new Set(),
    decidedId: "",
    rangeConfirmed: false,
    scanning: false,
    scanningStage: "",
    progress: 0,
    progressLabel: "",
    error: ""
  };

  let scanToken = 0;
  let builtTotal = -1;
  const hashCache = new Map();

  /* ---------------------------------------------------------------- helpers */

  const popcount = (value) => {
    let v = value - ((value >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    v = (v + (v >> 4)) & 0x0f0f0f0f;
    return (v * 0x01010101) >> 24;
  };

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  function canvasGray(image, size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const gray = new Float32Array(size * size);
    for (let i = 0; i < size * size; i += 1) {
      gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
    }
    return gray;
  }

  function signature(gray, size) {
    let mean = 0;
    for (let i = 0; i < gray.length; i += 1) mean += gray[i];
    mean /= gray.length;

    let bits = "";
    const cells = size * size;
    for (let i = 0; i < cells; i += 1) bits += gray[i] >= mean ? "1" : "0";

    let dHash = 0n;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        dHash = (dHash << 1n) | (gray[y * size + x] > gray[y * size + x + 1] ? 1n : 0n);
      }
    }

    return { mean, bits, dHash, size };
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    const cellCount = Math.min(a.bits.length, b.bits.length);
    let same = 0;
    for (let i = 0; i < cellCount; i += 1) {
      if (a.bits[i] === b.bits[i]) same += 1;
    }
    const bitsScore = same / cellCount;
    const dHashDiff = popcount(Number(a.dHash ^ b.dHash)) / (a.size * (a.size - 1));
    const meanDiff = Math.abs(a.mean - b.mean) / 255;
    return bitsScore * 0.55 + (1 - dHashDiff) * 0.3 + (1 - meanDiff) * 0.15;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("decode-failed"));
      image.src = url;
    });
  }

  async function fingerprintFor(url) {
    if (hashCache.has(url)) return hashCache.get(url);
    const image = await loadImage(url);
    const result = {};
    SCREEN_SIZES.forEach((size) => {
      result[size] = signature(canvasGray(image, size), size);
    });
    hashCache.set(url, result);
    return result;
  }

  async function thumbFor(asset) {
    if (asset.thumbnail && asset.thumbnail.webPath) return asset.thumbnail.webPath;
    const file = await native.PhotoLibrary.getThumbnailUrl({ id: asset.id, width: 260, height: 260, quality: 0.6 });
    return file.webPath;
  }

  async function prepare(item) {
    if (item.fingerprint !== undefined) return item;
    try {
      if (!item.thumbUrl) item.thumbUrl = await thumbFor(item.asset);
      item.fingerprint = await fingerprintFor(item.thumbUrl);
    } catch (_) {
      item.fingerprint = null;
    }
    return item;
  }

  function pairScore(a, b) {
    if (!a.fingerprint || !b.fingerprint) return 0;
    for (const size of SCREEN_SIZES) {
      const diff = popcount(Number(a.fingerprint[size].dHash ^ b.fingerprint[size].dHash));
      if (diff > SIMILAR_MAX_DISTANCE[size]) return 0;
    }
    const score = similarity(a.fingerprint[8], b.fingerprint[8]);
    return score >= MIN_PAIR_SCORE ? score : 0;
  }

  /* ------------------------------------------------------------- clustering */

  function dateValue(iso) {
    const parsed = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function labelDate(iso) {
    const value = dateValue(iso);
    if (!value) return "";
    const date = new Date(value);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}.${month}.${day}`;
  }

  function groupIntoClusters(items) {
    const parent = items.map((_, index) => index);
    const find = (index) => {
      let current = index;
      while (parent[current] !== current) {
        parent[current] = parent[parent[current]];
        current = parent[current];
      }
      return current;
    };
    const join = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const ordered = items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.time - b.item.time);

    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const gap = ordered[j].item.time - ordered[i].item.time;
        if (gap > 90 * 1000) break;
        if (pairScore(ordered[i].item, ordered[j].item) > 0) join(ordered[i].index, ordered[j].index);
      }
    }

    const buckets = new Map();
    items.forEach((item, index) => {
      const root = find(index);
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root).push(item);
    });

    const groups = [];
    buckets.forEach((members) => {
      if (members.length < 2) return;
      groups.push(makeGroup(members));
    });

    groups.sort((a, b) => b.items.length - a.items.length || b.time - a.time);
    groups.forEach((group, index) => {
      group.index = index;
    });
    return groups;
  }

  function makeGroup(members) {
    const sorted = members.slice().sort((a, b) => {
      if (b.pixels !== a.pixels) return b.pixels - a.pixels;
      return b.time - a.time;
    });
    sorted.forEach((item, index) => {
      item.rank = index;
    });

    let builtin = false;
    if (sorted.length >= 5) {
      let sum = 0;
      for (let i = 1; i < sorted.length; i += 1) sum += pairScore(sorted[0], sorted[i]);
      builtin = sum / (sorted.length - 1) >= BUILTIN_MIN_AVG;
    }

    return {
      index: 0,
      items: sorted,
      lead: sorted[0],
      time: sorted[0].time,
      date: sorted[0].date,
      builtin
    };
  }

  /* ------------------------------------------------------------------ scan */

  async function resolveRange(rangeValue) {
    if (rangeValue > 0) return Math.min(rangeValue, state.total);
    return state.total;
  }

  async function ensureIndex() {
    if (state.scanning) return;
    const range = await resolveRange(state.range);
    if (range <= 0) return;
    if (builtTotal === range && state.groups.length) return;

    const token = ++scanToken;
    state.scanning = true;
    state.error = "";
    state.progress = 0;
    state.progressLabel = "正在读取相册信息…";
    render();

    try {
      const collected = [];
      let offset = 0;

      while (offset < range) {
        if (token !== scanToken) return;
        const limit = Math.min(LOAD_PAGE, range - offset);
        const res = await native.PhotoLibrary.getLibrary({
          offset,
          limit,
          includeImages: true,
          includeVideos: false,
          includeCloudData: false
        });
        const assets = (res && res.assets) || [];
        assets.forEach((asset) => {
          if (!asset || !asset.id) return;
          collected.push({
            id: String(asset.id),
            name: asset.fileName || "照片",
            time: dateValue(asset.creationDate),
            date: labelDate(asset.creationDate),
            pixels: (asset.width || 0) * (asset.height || 0),
            thumbUrl: asset.thumbnail && asset.thumbnail.webPath ? asset.thumbnail.webPath : "",
            asset,
            fingerprint: undefined,
            rank: 0
          });
        });
        offset += assets.length || limit;
        state.progress = (offset / range) * 12;
        render();
        if (!assets.length) break;
        await nextFrame();
      }

      const total = collected.length;
      for (let i = 0; i < total; i += 1) {
        if (token !== scanToken) return;
        await prepare(collected[i]);
        if (i % 4 === 0) {
          state.progress = 12 + ((i + 1) / total) * 80;
          state.progressLabel = `正在比较相似度… ${i + 1} / ${total}`;
          render();
          await nextFrame();
        }
      }

      const usable = collected.filter((item) => item.fingerprint);
      state.progressLabel = "正在分组…";
      state.progress = 94;
      render();
      await nextFrame();

      state.items = usable;
      state.groups = groupIntoClusters(usable);
      state.decided = new Set(
        state.groups.map((group) => group.lead.id)
      );
      builtTotal = range;
      state.progress = 100;
      state.scanningStage = "done";
    } catch (error) {
      state.error = error && error.message ? error.message : "分析失败";
    } finally {
      state.scanning = false;
      render();
    }
  }

  /* ---------------------------------------------------------------- render */

  const similarBtn = document.getElementById("similarBtn");
  const screen = document.getElementById("similarScreen");
  const headline = document.getElementById("simHeadline");
  const rangeWrap = document.getElementById("simRange");
  const progressWrap = document.getElementById("simProgress");
  const progressBar = document.getElementById("simProgressBar");
  const progressLabel = document.getElementById("simProgressText");
  const summary = document.getElementById("simSummary");
  const groupsWrap = document.getElementById("simGroups");
  const emptyWrap = document.getElementById("simEmpty");
  const deleteBar = document.getElementById("simDeleteBar");
  const deleteCount = document.getElementById("simDeleteCount");
  const deleteBtn = document.getElementById("simDeleteBtn");
  const errorText = document.getElementById("simError");

  if (!similarBtn || !screen) return;

  function rangeLabel(value) {
    if (value < 0) return "全部";
    return `最近 ${value} 张`;
  }

  function formatSize(count) {
    return count > 0 ? String(count) : "0";
  }

  function renderRange() {
    rangeWrap.replaceChildren();
    const max = state.total;
    const seen = new Set();

    RANGE_OPTIONS.forEach((option) => {
      const value = option < 0 ? max : Math.min(option, max);
      if (value <= 0 || seen.has(value)) return;
      seen.add(value);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "sim-range__btn";
      button.dataset.range = String(option);
      button.textContent = option < 0 || value === max ? `全部 ${max} 张` : `最近 ${value} 张`;
      const active = state.range === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      rangeWrap.appendChild(button);
    });

    if (!state.rangeConfirmed) rangeWrap.classList.add("is-blocking");
    else rangeWrap.classList.remove("is-blocking");
  }

  function renderGroups() {
    groupsWrap.replaceChildren();
    const fragment = document.createDocumentFragment();

    state.groups.forEach((group) => {
      const card = document.createElement("article");
      card.className = "sim-group";
      card.dataset.group = String(group.index);

      const head = document.createElement("div");
      head.className = "sim-group__head";
      const title = document.createElement("b");
      title.textContent = `第 ${group.index + 1} 组 · ${group.items.length} 张`;
      const meta = document.createElement("span");
      meta.textContent = `${group.date}${group.builtin ? " · 连拍" : ""}`;
      head.append(title, meta);
      card.appendChild(head);

      const perPage = group.items.length >= 4 ? 4 : group.items.length;
      for (let page = 0; page < group.items.length; page += perPage) {
        const slice = group.items.slice(page, page + perPage);
        const row = document.createElement("div");
        row.className = "sim-grid";

        slice.forEach((item) => {
          const cell = document.createElement("button");
          cell.type = "button";
          cell.className = "sim-item";
          cell.dataset.id = item.id;
          cell.setAttribute("aria-pressed", String(state.decided.has(item.id)));
          if (state.decided.has(item.id)) cell.classList.add("is-keeper");

          const image = document.createElement("img");
          image.src = item.thumbUrl || item.asset.webPath;
          image.alt = item.name;
          image.loading = "lazy";
          cell.appendChild(image);

          const badge = document.createElement("span");
          badge.className = "sim-item__badge";
          badge.textContent = item.rank === 0 ? "建议保留" : "候选";
          cell.appendChild(badge);

          const label = document.createElement("span");
          label.className = "sim-item__name";
          label.textContent = item.name;
          cell.appendChild(label);
          row.appendChild(cell);
        });

        card.appendChild(row);
      }

      fragment.appendChild(card);
    });

    groupsWrap.appendChild(fragment);
  }

  function render() {
    similarBtn.hidden = false;

    if (state.total === 0) {
      headline.textContent = "正在读取相册总数…";
    } else {
      headline.textContent = `相册共 ${state.total} 张 · 选择要检查的范围`;
    }

    renderRange();

    const scanning = state.scanning;
    progressWrap.hidden = !scanning && state.progress < 100;
    progressBar.style.width = `${state.progress}%`;
    progressLabel.textContent = state.progressLabel || "";
    errorText.hidden = !state.error;
    errorText.textContent = state.error || "";

    const groupCount = state.groups.length;
    const grouped = state.groups.reduce((sum, group) => sum + group.items.length, 0);
    const burstGroups = state.groups.filter((group) => group.items.length >= 4).length;
    summary.textContent = groupCount
      ? `找到 ${groupCount} 组相似照片 · 共 ${grouped} 张 · 其中 ${burstGroups} 组像连拍`
      : "";

    renderGroups();
    emptyWrap.hidden = Boolean(groupCount) || scanning;

    const pending = Math.max(0, grouped - state.decided.size);
    deleteBar.hidden = !groupCount;
    deleteCount.textContent = formatSize(pending);
    deleteBtn.disabled = pending <= 0 || scanning;
  }

  /* --------------------------------------------------------------- actions */

  async function openScreen() {
    if (!screen.open) screen.showModal();
    if (!state.total) {
      try {
        const res = await native.PhotoLibrary.getLibrary({
          offset: 0,
          limit: 1,
          includeImages: true,
          includeVideos: false,
          includeCloudData: false
        });
        state.total = res && res.totalCount ? res.totalCount : 0;
      } catch (error) {
        state.error = error && error.message ? error.message : "读取相册失败";
      }
      if (state.total > 0) state.range = Math.min(300, state.total);
      render();
    } else {
      render();
    }
  }

  function closeScreen() {
    if (screen.open) screen.close();
    scanToken += 1;
  }

  function toggleKeeper(id) {
    const group = state.groups.find((entry) => entry.items.some((item) => item.id === id));
    if (!group) return;
    if (state.decided.has(id)) {
      // 每组至少留一张，点已经选中的那张不做取消，避免整组都被删掉。
      return;
    }
    state.decided.delete(group.lead.id);
    state.decided.add(id);
    render();
  }

  function pickGroupItem(event) {
    const cell = event.target.closest(".sim-item");
    if (!cell) return;
    toggleKeeper(cell.dataset.id);
  }

  async function runConfirmDelete() {
    if (state.scanning) return;
    const doomed = [];
    state.groups.forEach((group) => {
      group.items.forEach((item) => {
        if (!state.decided.has(item.id)) doomed.push(item);
      });
    });
    if (!doomed.length) return;

    deleteBtn.disabled = true;
    try {
      const fresh = doomed.map((item) => ({
        id: item.id,
        nativeId: item.id,
        fileName: item.name,
        creationDate: item.time ? new Date(item.time).toISOString() : "",
        width: item.asset.width,
        height: item.asset.height,
        size: item.asset.size,
        thumbnail: { webPath: item.thumbUrl }
      }));
      core.pickFromSimilar(fresh);
    } finally {
      deleteBtn.disabled = false;
    }
  }
  /* ------------------------------------------------------------------ wire */

  similarBtn.addEventListener("click", openScreen);
  screen.addEventListener("click", (event) => {
    if (event.target.closest("[data-sim-close]")) {
      closeScreen();
      return;
    }
    const rangeBtn = event.target.closest(".sim-range__btn");
    if (rangeBtn) {
      const value = Number(rangeBtn.dataset.range);
      state.range = value < 0 ? state.total : Math.min(value, state.total);
      state.rangeConfirmed = true;
      state.groups = [];
      state.decided = new Set();
      builtTotal = -1;
      render();
      ensureIndex();
      return;
    }
    if (event.target.closest("#simRescan")) {
      builtTotal = -1;
      ensureIndex();
      return;
    }
    if (event.target.closest("#simDeleteBtn")) {
      runConfirmDelete();
      return;
    }
    if (event.target.closest(".sim-item")) {
      pickGroupItem(event);
    }
  });

  document.addEventListener("photosift:render", () => {
    const active = screen.open && !state.rangeConfirmed;
    similarBtn.hidden = !core.state.native;
    if (active) render();
  });

  render();
  similarBtn.hidden = !core.state.native;
})();
