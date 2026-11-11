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
    cleared: new Set(),
    decidedId: "",
    rangeConfirmed: false,
    scanning: false,
    scanningStage: "",
    progress: 0,
    progressLabel: "",
    error: "",
    scanCanceled: false
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

  const SCAN_CONCURRENCY = 4;

  async function pool(tasks, limit, onProgress) {
    let cursor = 0;
    let done = 0;
    const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
      while (cursor < tasks.length) {
        const index = cursor;
        cursor += 1;
        await tasks[index]();
        done += 1;
        if (onProgress) onProgress(done);
      }
    });
    await Promise.all(workers);
  }

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
    // 时间差超过 90 秒的照片不可能属于同一组连拍，直接跳过，避免无谓计算。
    const gap = Math.abs((a.time || 0) - (b.time || 0));
    if (gap > 90 * 1000) return 0;
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

    // 已按拍摄时间排序，只需和后面 90 秒内的照片比较，跨度过大的自然跳过。
    // 这让 1000 张相册的比较次数从「最多 1000×1000」降到接近线性。
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
      group.items.forEach((item) => {
        item.groupIndex = index;
      });
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
    state.scanCanceled = false;
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
            groupIndex: -1,
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
      let lastPaint = 0;
      const tasks = collected.map((item) => () => prepare(item));

      await pool(tasks, SCAN_CONCURRENCY, (done) => {
        const now = performance.now();
        if (now - lastPaint > 120 || done === total) {
          lastPaint = now;
          state.progress = 12 + (done / total) * 80;
          state.progressLabel = `正在比较相似度… ${done} / ${total}`;
          render();
        }
      });
      if (token !== scanToken) return;
      await nextFrame();

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
      state.cleared = new Set();
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
  const rangeHint = document.getElementById("simRangeHint");
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

    if (rangeHint) {
      const saved = readLastRange();
      if (!state.rangeConfirmed && saved !== null) {
        rangeHint.textContent = saved < 0 || saved >= state.total
          ? `上次检查的是「全部 ${state.total} 张」，点一下即可重新扫描。`
          : `上次检查的是「最近 ${saved} 张」，点一下即可重新扫描。`;
      } else {
        rangeHint.textContent = "只比较拍摄时间相差 90 秒以内的照片，所以只挑连拍和同一场景。";
      }
    }
  }

  function renderGroups() {
    groupsWrap.replaceChildren();
    const fragment = document.createDocumentFragment();

    state.groups.forEach((group) => {
      const cleared = state.cleared.has(group.index);
      const card = document.createElement("article");
      card.className = "sim-group";
      card.dataset.group = String(group.index);
      if (cleared) card.classList.add("is-cleared");
      if (group.collapsed) card.classList.add("is-collapsed");

      const head = document.createElement("div");
      head.className = "sim-group__head";
      const info = document.createElement("div");
      info.className = "sim-group__info";
      const title = document.createElement("b");
      title.textContent = `第 ${group.index + 1} 组 · ${group.items.length} 张`;
      const meta = document.createElement("span");
      meta.textContent = cleared
        ? `${group.date} · 本组全部删除`
        : `${group.date}${group.builtin ? " · 连拍" : ""}`;
      info.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "sim-group__actions";
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "sim-group__clear";
      clearBtn.dataset.simClear = String(group.index);
      clearBtn.setAttribute("aria-pressed", String(cleared));
      clearBtn.textContent = cleared ? "恢复保留" : "整组删除";
      actions.appendChild(clearBtn);
      if (group.collapsed) {
        const expandBtn = document.createElement("button");
        expandBtn.type = "button";
        expandBtn.className = "sim-group__expand";
        expandBtn.dataset.simExpand = String(group.index);
        expandBtn.textContent = "展开";
        actions.appendChild(expandBtn);
      }

      head.append(info, actions);
      card.appendChild(head);

      if (group.collapsed) {
        fragment.appendChild(card);
        return;
      }

      const perPage = group.items.length >= 4 ? 4 : group.items.length;
      for (let page = 0; page < group.items.length; page += perPage) {
        const slice = group.items.slice(page, page + perPage);
        const row = document.createElement("div");
        row.className = "sim-grid";

        slice.forEach((item) => {
          const keeper = state.decided.has(item.id);
          const doomed = cleared && !keeper;

          const cell = document.createElement("div");
          cell.className = "sim-item";
          cell.dataset.id = item.id;
          if (keeper) cell.classList.add("is-keeper");
          if (doomed) cell.classList.add("is-doomed");

          const pick = document.createElement("button");
          pick.type = "button";
          pick.className = "sim-item__pick";
          pick.dataset.simPick = item.id;
          pick.setAttribute("aria-pressed", String(keeper));
          pick.setAttribute("aria-label", `${item.name}${keeper ? "，已选为保留" : "，点按设为保留"}`);

          const image = document.createElement("img");
          image.src = item.thumbUrl || item.asset.webPath;
          image.alt = item.name;
          image.loading = "lazy";
          pick.appendChild(image);

          const badge = document.createElement("span");
          badge.className = "sim-item__badge";
          badge.textContent = keeper
            ? "保留"
            : cleared ? "将删除" : item.rank === 0 ? "建议保留" : "候选";
          pick.appendChild(badge);

          cell.appendChild(pick);

          const zoom = document.createElement("button");
          zoom.type = "button";
          zoom.className = "sim-item__zoom";
          zoom.dataset.simZoom = item.id;
          zoom.setAttribute("aria-label", `放大查看 ${item.name}`);
          zoom.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5a6 6 0 104.24 10.24L20 20M11 8v6M8 11h6"/></svg>';
          cell.appendChild(zoom);

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
    const clearedGroups = state.cleared.size;
    summary.textContent = groupCount
      ? `找到 ${groupCount} 组相似照片 · 共 ${grouped} 张 · 其中 ${burstGroups} 组像连拍${clearedGroups ? ` · ${clearedGroups} 组整组删除` : ""}`
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
      if (state.total > 0) applyDefaultRange();
      render();
    } else {
      render();
    }
  }

  const LAST_RANGE_KEY = "photosift:similarRange";

  function readLastRange() {
    try {
      const raw = window.localStorage.getItem(LAST_RANGE_KEY);
      const value = Number(raw);
      return Number.isFinite(value) && value !== 0 ? value : null;
    } catch (_) {
      return null;
    }
  }

  function rememberRange(option, resolved) {
    try {
      window.localStorage.setItem(LAST_RANGE_KEY, String(option < 0 ? -1 : resolved));
    } catch (_) {
      /* 隐私模式或存储被禁用时忽略 */
    }
  }

  function applyDefaultRange() {
    const saved = readLastRange();
    if (saved === null) {
      state.range = Math.min(300, state.total);
      return;
    }
    state.range = saved < 0 ? state.total : Math.min(saved, state.total);
  }
  function closeScreen() {
    if (screen.open) screen.close();
    scanToken += 1;
  }

  function toggleKeeper(id) {
    const group = state.groups.find((entry) => entry.items.some((item) => item.id === id));
    if (!group) return false;
    if (state.decided.has(id)) {
      // 每组至少留一张，点已经选中的那张不做取消，避免整组都被删掉。
      return false;
    }

    // 手动挑了别的照片，就取消「整组删除」。
    if (state.cleared.has(group.index)) {
      state.cleared.delete(group.index);
      group.collapsed = false;
    }

    // 每组同一时间只保留一张：先清掉本组所有保留项，再登记新的。
    group.items.forEach((item) => state.decided.delete(item.id));
    state.decided.add(id);
    render();
    announceSimilar(`第 ${group.index + 1} 组已改选保留：${id === group.lead.id ? "原建议" : "新选择"}`);
    return true;
  }

  function toggleClearGroup(groupIndex) {
    const group = state.groups[groupIndex];
    if (!group || state.scanning) return;

    if (state.cleared.has(groupIndex)) {
      state.cleared.delete(groupIndex);
      group.collapsed = false;
      state.decided.add(group.lead.id);
      render();
      announceSimilar(`第 ${groupIndex + 1} 组已恢复保留：${group.lead.name}`);
      return;
    }

    group.items.forEach((item) => state.decided.delete(item.id));
    state.cleared.add(groupIndex);
    // 组数多的时候，已确认整组删除的卡片折叠起来，避免列表太长。
    group.collapsed = state.groups.length > 12;
    render();
    announceSimilar(`第 ${groupIndex + 1} 组整组删除：${group.items.length} 张`);
  }

  function expandGroup(groupIndex) {
    const group = state.groups[groupIndex];
    if (!group) return;
    group.collapsed = false;
    render();
  }

  let zoomItem = null;
  let zoomGroup = [];
  let zoomIndex = 0;
  const zoomDialog = document.getElementById("similarZoom");
  const zoomImage = document.getElementById("simZoomImage");
  const zoomCaption = document.getElementById("simZoomCaption");
  const zoomPosition = document.getElementById("simZoomPosition");
  const zoomKeepBtn = document.getElementById("simZoomKeep");
  const zoomPrevBtn = document.getElementById("simZoomPrev");
  const zoomNextBtn = document.getElementById("simZoomNext");
  const zoomStage = document.getElementById("simZoomStage");
  let zoomScale = 1;
  let zoomX = 0;
  let zoomY = 0;
  let zoomDrag = null;
  let zoomPinch = null;
  const zoomTouches = new Map();
  const MAX_ZOOM = 6;

  function applyZoomTransform(animate) {
    zoomImage.classList.toggle("is-animating", Boolean(animate));
    zoomImage.style.transform = `translate3d(${zoomX.toFixed(1)}px, ${zoomY.toFixed(1)}px, 0) scale(${zoomScale.toFixed(3)})`;
    if (zoomStage) zoomStage.classList.toggle("is-zoomed", zoomScale > 1.01);
  }

  function resetZoom(animate) {
    zoomScale = 1;
    zoomX = 0;
    zoomY = 0;
    applyZoomTransform(animate);
  }

  function showZoomIndex(index) {
    if (!zoomGroup.length) return;
    zoomIndex = (index + zoomGroup.length) % zoomGroup.length;
    zoomItem = zoomGroup[zoomIndex];
    zoomImage.src = zoomItem.thumbUrl || zoomItem.asset.webPath;
    zoomImage.alt = zoomItem.name;
    zoomCaption.textContent = zoomItem.name;
    const keeper = state.decided.has(zoomItem.id);
    zoomPosition.textContent = `${zoomIndex + 1} / ${zoomGroup.length} · ${keeper ? "已选保留" : zoomItem.rank === 0 ? "建议保留" : "候选"}`;
    zoomKeepBtn.textContent = keeper ? "已选为保留" : "设为保留";
    zoomKeepBtn.disabled = keeper;
    zoomPrevBtn.disabled = zoomGroup.length < 2;
    zoomNextBtn.disabled = zoomGroup.length < 2;
    resetZoom(false);
  }

  function openSimilarZoom(item, neighbours) {
    if (!zoomDialog || !zoomImage) return;
    zoomGroup = (neighbours && neighbours.length ? neighbours : [item]).slice();
    const index = zoomGroup.findIndex((entry) => entry.id === item.id);
    if (!zoomDialog.open) zoomDialog.showModal();
    showZoomIndex(index < 0 ? 0 : index);
  }

  function stepZoom(direction) {
    showZoomIndex(zoomIndex + direction);
  }

  function chooseZoomKeeper() {
    if (!zoomItem) return;
    toggleKeeper(zoomItem.id);
    showZoomIndex(zoomIndex);
  }
  function announceSimilar(text) {
    const live = document.getElementById("similarLive");
    if (live) live.textContent = text;
  }

  function openZoomItem(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    const group = state.groups[item.groupIndex];
    openSimilarZoom(item, group ? group.items : [item]);
  }

  function pickGroupItem(event) {
    const pick = event.target.closest("[data-sim-pick]");
    if (!pick) return;
    toggleKeeper(pick.dataset.simPick);
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

  if (zoomDialog) {
    zoomDialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-sim-zoom-close]")) {
        zoomDialog.close();
        return;
      }
      if (event.target.closest("#simZoomPrev")) {
        stepZoom(-1);
        return;
      }
      if (event.target.closest("#simZoomNext")) {
        stepZoom(1);
        return;
      }
      if (event.target.closest("#simZoomKeep")) {
        chooseZoomKeeper();
        return;
      }
      if (event.target === zoomDialog) {
        zoomDialog.close();
        return;
      }
      const resetBtn = event.target.closest("#simZoomReset");
      if (resetBtn) resetZoom(true);
    });

    zoomDialog.addEventListener("close", () => {
      zoomItem = null;
      zoomGroup = [];
      resetZoom(false);
    });
  }

  if (zoomImage && zoomStage) {
    zoomImage.addEventListener("dblclick", () => {
      if (zoomScale > 1.01) {
        resetZoom(true);
      } else {
        zoomScale = 2.5;
        applyZoomTransform(true);
      }
    });

    zoomStage.addEventListener("pointerdown", (event) => {
      if (zoomStage.getPointerCapture) {
        try { zoomStage.setPointerCapture(event.pointerId); } catch (_) {}
      }

      if (event.pointerType === "touch") {
        zoomTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (zoomTouches.size === 2) {
          const [a, b] = [...zoomTouches.values()];
          zoomDrag = null;
          zoomPinch = {
            distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
            scale: zoomScale,
            centerX: (a.x + b.x) / 2,
            centerY: (a.y + b.y) / 2
          };
          return;
        }
      }

      if (!event.isPrimary) return;

      if (zoomScale > 1.01) {
        zoomDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: zoomX, startY: zoomY };
      } else {
        const now = performance.now();
        if (zoomStage.dataset.lastTap && now - Number(zoomStage.dataset.lastTap) < 280) {
          zoomScale = 2.5;
          applyZoomTransform(true);
          zoomStage.dataset.lastTap = "";
        } else {
          zoomStage.dataset.lastTap = String(now);
        }
      }
    });

    zoomStage.addEventListener("pointermove", (event) => {
      if (zoomTouches.has(event.pointerId)) {
        zoomTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      if (zoomPinch && zoomTouches.size >= 2) {
        const [a, b] = [...zoomTouches.values()];
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const target = Math.min(MAX_ZOOM, Math.max(1, zoomPinch.scale * (distance / zoomPinch.distance)));
        zoomScale = target;
        if (target <= 1.01) {
          zoomX = 0;
          zoomY = 0;
        }
        applyZoomTransform(false);
        return;
      }

      if (!zoomDrag || event.pointerId !== zoomDrag.id) return;
      zoomX = zoomDrag.startX + (event.clientX - zoomDrag.x);
      zoomY = zoomDrag.startY + (event.clientY - zoomDrag.y);
      applyZoomTransform(false);
    });

    zoomStage.addEventListener("pointerup", (event) => {
      zoomTouches.delete(event.pointerId);
      if (zoomTouches.size < 2) zoomPinch = null;
      if (zoomDrag && event.pointerId === zoomDrag.id) {
        zoomDrag = null;
        if (zoomScale <= 1.01) resetZoom(true);
      }
    });

    zoomStage.addEventListener("pointercancel", (event) => {
      zoomTouches.delete(event.pointerId);
      zoomPinch = null;
      zoomDrag = null;
    });

    zoomStage.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomScale = Math.min(MAX_ZOOM, Math.max(1, zoomScale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (zoomScale <= 1.01) {
        zoomX = 0;
        zoomY = 0;
      }
      applyZoomTransform(false);
    }, { passive: false });
  }

  document.addEventListener("keydown", (event) => {
    if (!zoomDialog || !zoomDialog.open) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepZoom(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepZoom(1);
    }
  });
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
      state.cleared = new Set();
      builtTotal = -1;
      rememberRange(value, state.range);
      render();
      ensureIndex();
      return;
    }
    if (event.target.closest("#simRescan")) {
      builtTotal = -1;
      ensureIndex();
      return;
    }
    if (event.target.closest("#simCancel")) {
      scanToken += 1;
      state.scanning = false;
      state.scanCanceled = true;
      state.progress = 0;
      state.progressLabel = "";
      render();
      return;
    }
    if (event.target.closest("#simDeleteBtn")) {
      runConfirmDelete();
      return;
    }
    const clearBtn = event.target.closest("[data-sim-clear]");
    if (clearBtn) {
      toggleClearGroup(Number(clearBtn.dataset.simClear));
      return;
    }
    const expandBtn = event.target.closest("[data-sim-expand]");
    if (expandBtn) {
      expandGroup(Number(expandBtn.dataset.simExpand));
      return;
    }
    const zoomBtn = event.target.closest("[data-sim-zoom]");
    if (zoomBtn) {
      openZoomItem(zoomBtn.dataset.simZoom);
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
