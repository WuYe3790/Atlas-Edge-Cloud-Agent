// 动态 DOM 代理，防止 Vue.js 挂载后原始元素被销毁导致的原生 JS 异常
const messagesEl = {
  get scrollTop() { return document.querySelector(".messages")?.scrollTop || 0; },
  set scrollTop(val) { const el = document.querySelector(".messages"); if (el) el.scrollTop = val; },
  get scrollHeight() { return document.querySelector(".messages")?.scrollHeight || 0; },
  appendChild(child) { document.querySelector(".messages")?.appendChild(child); },
  querySelectorAll(sel) { return document.querySelector(".messages")?.querySelectorAll(sel) || []; },
  querySelector(sel) { return document.querySelector(".messages")?.querySelector(sel) || null; },
  addEventListener(evt, handler, opts) { document.querySelector(".messages")?.addEventListener(evt, handler, opts); }
};
const formEl = { addEventListener(evt, handler) { document.querySelector(".composer")?.addEventListener(evt, handler); } };
const inputEl = {
  get disabled() { return document.querySelector("#messageInput")?.disabled || false; },
  set disabled(val) { const el = document.querySelector("#messageInput"); if (el) el.disabled = val; }
};
const sendBtn = {
  get disabled() { return document.querySelector("#sendBtn")?.disabled || false; },
  set disabled(val) { const el = document.querySelector("#sendBtn"); if (el) el.disabled = val; },
  get classList() {
    const el = document.querySelector("#sendBtn");
    return {
      toggle(cls, force) { el?.classList.toggle(cls, force); }
    };
  },
  querySelector(sel) { return document.querySelector("#sendBtn")?.querySelector(sel) || { set textContent(val) {} }; }
};
const clearBtn = {};
const offlineToggle = {};
const thinkingToggle = {};
const modelName = {};
const thinkingModelName = {};
const keyStatus = {};
const amapStatus = {};
const qweatherStatus = {};
const trainStatus = {};
const aviationStatus = {};
const hotelStatus = {};
const locationStatus = {};
const edgeDevicesListEl = {};
const edgeTasksListEl = {};
const edgeTasksListCompactEl = {};
const refreshEdgeTasksBtn = {};
const manualHeartbeatBtn = {};
const conversationListEl = {};
const skillsListEl = {};
const newChatBtn = {};
const locateBtn = {};
const inputSuggestToggle = {};
const inputTipsEl = {};
const CURRENT_CONVERSATION_KEY = "travel_agent_current_conversation_id";
const LOCATION_CONTEXT_KEY = "travel_agent_location_context";
const INPUT_SUGGEST_KEY = "travel_agent_input_suggest_enabled";
let currentConversationId = localStorage.getItem(CURRENT_CONVERSATION_KEY) || "";
let currentLocationContext = loadLocationContext();
let activeController = null;
let inputTipTimer = null;
let traceInteractionUntil = 0;
let amapLoaderPromise = null;
const liveMapQueue = [];
let liveMapQueueRunning = false;

if (inputSuggestToggle) {
  inputSuggestToggle.checked = localStorage.getItem(INPUT_SUGGEST_KEY) !== "false";
}

function loadLocationContext() {
  try {
    return JSON.parse(localStorage.getItem(LOCATION_CONTEXT_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLocationContext(context) {
  currentLocationContext = context || {};
  localStorage.setItem(LOCATION_CONTEXT_KEY, JSON.stringify(currentLocationContext));
  updateLocationStatus();
}

function locationLabel(context = currentLocationContext) {
  return context.city || context.district || context.province || "";
}

function updateLocationStatus(text = "") {
  if (!locationStatus) return;
  const label = text || locationLabel();
  locationStatus.textContent = label || "未定位";
}

function getConversationHistory() {
  return [...messagesEl.querySelectorAll(".message:not(.loading)")].slice(0, -1).slice(-8).map((message) => {
    const role = message.classList.contains("user") ? "user" : "assistant";
    const bubble = message.querySelector(".bubble");
    return { role, text: bubble?.dataset.rawText || bubble?.textContent || "" };
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

const POI_MARKER_LABELS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function markerLabel(index) {
  return POI_MARKER_LABELS[index] || String(index + 1);
}

function parseLngLat(location) {
  const [lng, lat] = String(location || "").split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

function mapViewport(locations) {
  const points = locations.map(parseLngLat).filter(Boolean);
  if (!points.length) return { center: locations[0] || "", zoom: "12" };
  const lngs = points.map((point) => point.lng);
  const lats = points.map((point) => point.lat);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;
  const span = Math.max(lngSpan, latSpan * 1.8);
  const center = `${((minLng + maxLng) / 2).toFixed(6)},${((minLat + maxLat) / 2).toFixed(6)}`;
  let zoom = 12;
  if (span > 2.2) zoom = 7;
  else if (span > 1.1) zoom = 8;
  else if (span > 0.55) zoom = 9;
  else if (span > 0.28) zoom = 10;
  else if (span > 0.14) zoom = 11;
  else if (span <= 0.035) zoom = 13;
  return { center, zoom: String(zoom) };
}

function buildMapImageUrl(locations, options = {}) {
  const cleanLocations = (locations || [])
    .map((location) => String(location || "").trim())
    .filter((location) => /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(location))
    .slice(0, POI_MARKER_LABELS.length);
  if (!cleanLocations.length) return "";
  const viewport = mapViewport(cleanLocations);
  const params = new URLSearchParams({
    location: options.center || viewport.center,
    zoom: options.zoom || viewport.zoom,
    size: options.size || "1024*520",
    markers: cleanLocations
      .map((loc, index) => `mid,0x1677ff,${markerLabel(index)}:${loc}`)
      .join("|"),
  });
  return `/api/amap/static-map?${params.toString()}`;
}

function htmlAttrJson(value) {
  return JSON.stringify(value || [])
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

function buildMapPoints(items) {
  return (items || [])
    .map((item, index) => {
      const point = parseLngLat(item.location);
      if (!point) return null;
      return {
        label: markerLabel(index),
        name: item.name || `地点${index + 1}`,
        type: item.type || item.category || "",
        address: item.address || "",
        location: item.location,
        lng: point.lng,
        lat: point.lat,
      };
    })
    .filter(Boolean);
}

async function loadAmapApi() {
  if (window.AMap) return window.AMap;
  if (amapLoaderPromise) return amapLoaderPromise;
  amapLoaderPromise = (async () => {
    const response = await fetch("/api/amap/js-config");
    const config = await response.json();
    if (!config.enabled || !config.key || !config.security_code) {
      throw new Error(config.error || "高德 JS API 未配置");
    }
    window._AMapSecurityConfig = { securityJsCode: config.security_code };
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.key)}&plugin=AMap.Scale,AMap.ToolBar`;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("高德 JS API 加载失败"));
      document.head.appendChild(script);
    });
    return window.AMap;
  })();
  return amapLoaderPromise;
}

function markTraceInteraction() {
  traceInteractionUntil = Date.now() + 700;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateDraggableMap(viewport) {
  const image = viewport.querySelector(".poi-map-preview");
  if (!image) return;
  const x = Number(viewport.dataset.offsetX || 0);
  const y = Number(viewport.dataset.offsetY || 0);
  image.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

function clampMapOffset(viewport) {
  const image = viewport.querySelector(".poi-map-preview");
  if (!image || !image.complete) return;
  const maxX = Math.max(0, (image.clientWidth - viewport.clientWidth) / 2);
  const maxY = Math.max(0, (image.clientHeight - viewport.clientHeight) / 2);
  viewport.dataset.offsetX = String(clamp(Number(viewport.dataset.offsetX || 0), -maxX, maxX));
  viewport.dataset.offsetY = String(clamp(Number(viewport.dataset.offsetY || 0), -maxY, maxY));
  updateDraggableMap(viewport);
}

function resetDraggableMap(viewport) {
  viewport.dataset.offsetX = "0";
  viewport.dataset.offsetY = "0";
  updateDraggableMap(viewport);
}

function setMapLoadState(image, state) {
  const viewport = image?.closest(".poi-map-viewport");
  if (!viewport) return;
  const liveMap = viewport.querySelector(".amap-live-map");
  const liveReady = liveMap?.classList.contains("amap-ready");
  const liveUnavailable = liveMap?.classList.contains("amap-unavailable");
  viewport.classList.toggle("map-error", state === "error" && (!liveMap || liveUnavailable));
  viewport.classList.toggle("map-loaded", state === "loaded");
  if (state === "loaded" && liveReady) {
    viewport.classList.remove("map-error");
  }
}

function initDraggableMaps(root = document) {
  root.querySelectorAll("[data-draggable-map]").forEach((viewport) => {
    if (viewport.dataset.dragReady === "true") return;
    viewport.dataset.dragReady = "true";
    viewport.dataset.offsetX = viewport.dataset.offsetX || "0";
    viewport.dataset.offsetY = viewport.dataset.offsetY || "0";
    const image = viewport.querySelector(".poi-map-preview");
    if (image) {
      image.addEventListener("load", () => clampMapOffset(viewport), { once: true });
    }

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;
    viewport.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".poi-map-toolbar")) return;
      if (event.target.closest(".amap-live-map.amap-ready")) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      baseX = Number(viewport.dataset.offsetX || 0);
      baseY = Number(viewport.dataset.offsetY || 0);
      viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      viewport.dataset.offsetX = String(baseX + event.clientX - startX);
      viewport.dataset.offsetY = String(baseY + event.clientY - startY);
      clampMapOffset(viewport);
    });
    const stopDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      if (viewport.hasPointerCapture(event.pointerId)) {
        viewport.releasePointerCapture(event.pointerId);
      }
      clampMapOffset(viewport);
    };
    viewport.addEventListener("pointerup", stopDrag);
    viewport.addEventListener("pointercancel", stopDrag);
  });
}

function markerContent(point, active = false) {
  return `<div class="amap-marker-badge${active ? " active" : ""}">${escapeHtml(point.label)}</div>`;
}

function mapInfoContent(point) {
  return `
    <div class="amap-info-window">
      <strong>${escapeHtml(point.label)}. ${escapeHtml(point.name)}</strong>
      ${point.type ? `<span>${escapeHtml(point.type)}</span>` : ""}
      ${point.address ? `<p>${escapeHtml(point.address)}</p>` : ""}
    </div>
  `;
}

function highlightPoiCard(scope, label) {
  scope.querySelectorAll("[data-map-label]").forEach((card) => {
    card.classList.toggle("map-highlight", card.dataset.mapLabel === label);
  });
}

function highlightLiveMarker(scope, label) {
  const liveMap = scope.querySelector(".amap-live-map");
  if (!liveMap?._amapMarkers?.length) return;
  liveMap._amapMarkers.forEach((marker) => {
    const point = marker.getExtData();
    marker.setContent(markerContent(point, point?.label === label));
  });
}

function focusLiveMapPoint(scope, label, options = {}) {
  const liveMap = scope?.querySelector?.(".amap-live-map");
  if (!liveMap?._amapInstance || !liveMap?._amapMarkers?.length || !label) return;
  const marker = liveMap._amapMarkers.find((item) => item.getExtData()?.label === label);
  if (!marker) return;
  const point = marker.getExtData();
  highlightLiveMarker(scope, label);
  highlightPoiCard(scope, label);
  if (options.pan !== false) {
    liveMap._amapInstance.setZoomAndCenter(Math.max(liveMap._amapInstance.getZoom(), 14), marker.getPosition(), false, 300);
  }
  if (options.openInfo !== false && liveMap._amapInfoWindow) {
    liveMap._amapInfoWindow.setContent(mapInfoContent(point));
    liveMap._amapInfoWindow.open(liveMap._amapInstance, marker.getPosition());
  }
}

function liveMapScope(container) {
  return container.closest("[data-poi-category]") || container.closest(".timeline-content") || document;
}

function parseLiveMapPoints(container) {
  try {
    return JSON.parse(container.dataset.points || "[]");
  } catch {
    return [];
  }
}

function markLiveMapUnavailable(container) {
  container.classList.remove("amap-ready");
  container.classList.add("amap-unavailable");
  const viewport = container.closest(".poi-map-viewport");
  const image = viewport?.querySelector(".poi-map-preview");
  if (!image || !image.complete || image.naturalWidth === 0) {
    viewport?.classList.add("map-error");
  }
}

function destroyLiveMap(container) {
  if (!container) return;
  if (container._amapInstance) {
    container._amapInstance.destroy();
  }
  container._amapInstance = null;
  container._amapMarkers = [];
  container._amapInfoWindow = null;
  container.innerHTML = "";
  container.classList.remove("amap-ready", "amap-unavailable", "amap-container");
  container.dataset.mapReady = "";
  container.dataset.mapQueued = "";
}

function renderLiveMap(container, points, options = {}) {
  if (!container) return;
  if (!points.length) {
    destroyLiveMap(container);
    return;
  }
  if (container._amapInstance) {
    destroyLiveMap(container);
  }
  loadAmapApi()
    .then((AMap) => {
      container.classList.remove("amap-unavailable");
      container.innerHTML = "";
      const centerPoint = points[0];
      const map = new AMap.Map(container, {
        zoom: points.length > 1 ? 11 : 14,
        center: [centerPoint.lng, centerPoint.lat],
        resizeEnable: true,
        viewMode: "2D",
      });
      map.addControl(new AMap.Scale());
      map.addControl(new AMap.ToolBar({ liteStyle: true }));

      const infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -28) });
      const markers = points.map((point) => {
        const marker = new AMap.Marker({
          position: [point.lng, point.lat],
          content: markerContent(point),
          offset: new AMap.Pixel(-13, -13),
          extData: point,
          zIndex: 120,
        });
        marker.on("click", () => {
          const scope = liveMapScope(container);
          focusLiveMapPoint(scope, point.label, { pan: false, openInfo: true });
        });
        marker.on("mouseover", () => {
          const scope = liveMapScope(container);
          focusLiveMapPoint(scope, point.label, { pan: false, openInfo: false });
        });
        marker.on("mouseout", () => marker.setContent(markerContent(point, false)));
        return marker;
      });
      map.add(markers);
      if (markers.length > 1) {
        map.setFitView(markers, false, [58, 36, 36, 36]);
      }
      container._amapInstance = map;
      container._amapMarkers = markers;
      container._amapInfoWindow = infoWindow;
      container.classList.add("amap-ready");
      container.closest(".poi-map-viewport")?.classList.remove("map-error");
    })
    .catch(() => {
      markLiveMapUnavailable(container);
    });
}

function ensureLiveMap(container, options = {}) {
  if (!container || container.dataset.mapReady === "true") return;
  const points = parseLiveMapPoints(container);
  if (!points.length) return;
  container.dataset.mapReady = "true";
  renderLiveMap(container, points, { ...options });
}

function scheduleLiveMap(container) {
  if (!container || container.dataset.mapReady === "true" || container.dataset.mapQueued === "true") return;
  container.dataset.mapQueued = "true";
  liveMapQueue.push(container);
  if (!liveMapQueueRunning) {
    processLiveMapQueue();
  }
}

function processLiveMapQueue() {
  liveMapQueueRunning = true;
  const container = liveMapQueue.shift();
  if (!container) {
    liveMapQueueRunning = false;
    return;
  }
  container.dataset.mapQueued = "";
  ensureLiveMap(container);
  window.setTimeout(processLiveMapQueue, 260);
}

function initLiveMaps(root = document) {
  root.querySelectorAll("[data-live-map]").forEach((container) => {
    if (container.dataset.mapReady === "true") return;
    scheduleLiveMap(container);
  });
}

function parsePoiRating(item) {
  const rating = Number.parseFloat(String(item?.rating || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(rating) ? rating : 0;
}

function parsePoiCost(item) {
  const cost = Number.parseFloat(String(item?.cost || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(cost) ? cost : 999999;
}

function normalizedPoiType(item) {
  return String(item?.type || "").trim() || "其他";
}

function flattenPoiItems(categories = []) {
  return (categories || []).flatMap((category) =>
    (category.items || []).map((item) => ({
      ...item,
      category: category.category || "",
    })),
  );
}

function mapItemKey(item) {
  return compactPlaceText(`${item?.name || ""}|${item?.location || ""}`);
}

function itineraryMapItems(poiCategories = [], hotels = []) {
  const items = [
    ...flattenPoiItems(poiCategories),
    ...(hotels || []).map((hotel) => ({
      ...hotel,
      category: "酒店",
      type: hotel.stars ? `${hotel.stars}星酒店` : "酒店",
      address: hotel.area || "",
      cost: hotel.price_total || hotel.price || "",
    })),
  ];
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.location || !item?.name) return false;
    const key = mapItemKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const GENERIC_PLACE_ALIASES = new Set([
  "景点", "酒店", "餐厅", "餐饮", "本地菜", "湖北菜", "湘菜", "川菜", "粤菜", "中餐厅",
  "购物", "商圈", "商场", "公园", "博物馆", "步行街", "风景名胜", "国家级景点",
].map(compactPlaceText));

function compactPlaceText(text) {
  return String(text || "")
    .replace(/[\s\u3000()（）\[\]{}<>《》【】,，、;；:：|·\-—–→]+/g, "")
    .toLowerCase();
}

function isGenericPlaceAlias(alias) {
  return GENERIC_PLACE_ALIASES.has(alias) || [
    "\u666f\u70b9", "\u9152\u5e97", "\u9910\u5385", "\u9910\u996e", "\u672c\u5730\u83dc",
    "\u6e56\u5317\u83dc", "\u6e58\u83dc", "\u5ddd\u83dc", "\u7ca4\u83dc", "\u4e2d\u9910\u5385",
    "\u8d2d\u7269", "\u5546\u5708", "\u5546\u573a", "\u516c\u56ed", "\u535a\u7269\u9986",
    "\u6b65\u884c\u8857", "\u98ce\u666f\u540d\u80dc", "\u56fd\u5bb6\u7ea7\u666f\u70b9",
  ].map(compactPlaceText).includes(alias);
}

function placeAliases(name) {
  const raw = String(name || "");
  const full = compactPlaceText(raw);
  const parts = raw
    .split(/[\u0028\u0029\uff08\uff09\u00b7\u002d\u2014\u2013\u007c\u002c\uff0c\u3001\u003b\uff1b\u003a\uff1a\s]+/)
    .map(compactPlaceText)
    .filter(Boolean);
  return [...new Set([full, ...parts])]
    .filter((alias) => alias.length >= 2 && !isGenericPlaceAlias(alias));
}

function poiKeywordMatch(text, item) {
  if (!item?.location) return null;
  const aliases = placeAliases(item.name);
  let best = null;

  // Forward match: POI aliases appear in text (high precision, weighted x10)
  aliases.forEach((alias) => {
    const index = text.indexOf(alias);
    if (index < 0) return;
    const score = alias.length * 10;
    if (!best || index < best.index || (index === best.index && score > best.score)) {
      best = { index, score };
    }
  });

  // Reverse match: text n-grams appear in POI compact name (fallback for
  // cases like text="西湖" vs POI="杭州西湖风景名胜区")
  if (!best) {
    const poiCompact = compactPlaceText(item.name);
    for (let n = Math.min(4, text.length); n >= 2; n--) {
      for (let i = 0; i <= text.length - n; i++) {
        const ngram = text.slice(i, i + n);
        if (isGenericPlaceAlias(ngram)) continue;
        if (poiCompact.indexOf(ngram) >= 0) {
          if (!best || n > best.score || (n === best.score && i < best.index)) {
            best = { index: i, score: n };
          }
        }
      }
      if (best) break; // prefer longer n-gram matches
    }
  }

  return best;
}

function matchItineraryPois(day, poiItems) {
  const activitySegments = Array.isArray(day.activities) ? day.activities : [];
  const mealSegments = Array.isArray(day.meals) ? day.meals : [];
  const accSegment = day.accommodation || "";
  const segments = [
    ...activitySegments,
    ...mealSegments,
    accSegment,
  ].filter(Boolean);
  const selected = [];
  const selectedKeys = new Set();
  segments.forEach((segment, segmentIndex) => {
    const text = compactPlaceText(segment);
    if (!text) return;
    const matches = poiItems
      .map((item) => ({ item, match: poiKeywordMatch(text, item) }))
      .filter(({ item, match }) => match && !selectedKeys.has(mapItemKey(item)))
      .sort((a, b) => a.match.index - b.match.index || b.match.score - a.match.score);
    // Track which text positions already have a POI assigned, so n-gram
    // reverse matches don't fan out one place name into many unrelated POIs.
    const covered = new Set();
    matches.forEach(({ item, match }) => {
      const key = mapItemKey(item);
      if (selectedKeys.has(key)) return;
      // For reverse (n-gram) matches, skip if this text position is already
      // covered by another POI from the same segment.  Forward matches
      // (score >= 10) are explicit and always kept.
      if (match.score < 10) {
        const pos = match.index;
        if (covered.has(pos)) return;
        for (let d = -2; d <= match.score; d++) covered.add(pos + d);
      }
      selectedKeys.add(key);
      selected.push({ item, order: segmentIndex * 1000 + match.index, score: match.score });
    });
  });
  return selected
    .sort((a, b) => a.order - b.order || b.score - a.score)
    .map(({ item }) => item)
    .slice(0, POI_MARKER_LABELS.length);
}

function renderMiniMap(matched, label = "地图") {
  // Accept both plain array (current) and legacy { items, routeItems } object.
  const items = Array.isArray(matched) ? matched : (matched.items || []);
  const locations = items.map((item) => item.location).filter(Boolean);
  const mapUrl = buildMapImageUrl(locations, { size: "900*420" });
  const points = buildMapPoints(items);
  if (!mapUrl) {
    return `
      <div class="mini-map-block mini-map-empty">
        <div class="mini-map-empty-title">${escapeHtml(label)}</div>
        <div class="mini-map-note">当前行程缺少可用坐标，暂不能生成地图；补充 POI 坐标后会自动展示。</div>
      </div>
    `;
  }
  const legend = items.map((item, index) => `
    <span><b>${markerLabel(index)}</b>${escapeHtml(item.name || `${label}${index + 1}`)}</span>
  `).join("");
  return `
    <div class="mini-map-block">
      <div class="poi-map-viewport mini-map" data-draggable-map>
        <div class="poi-map-toolbar">
          <span>${escapeHtml(label)}</span>
          <button type="button" class="poi-map-retry">重试</button>
          <button type="button" class="poi-map-reset">重置视角</button>
          <a class="poi-map-open-link" href="${escapeHtml(mapUrl)}" target="_blank" rel="noreferrer">打开图像</a>
        </div>
        <div class="amap-live-map" data-live-map data-points="${htmlAttrJson(points)}"></div>
        <img class="poi-map-preview" src="${escapeHtml(mapUrl)}" alt="${escapeHtml(label)}" loading="eager" referrerpolicy="no-referrer" draggable="false" onload="setMapLoadState(this, 'loaded')" onerror="setMapLoadState(this, 'error')">
        <div class="poi-map-fallback">地图暂时加载失败，可点击重试或打开图像查看。</div>
      </div>
      <div class="poi-map-legend">${legend}</div>
      <div class="mini-map-note">地图展示当前日行程中匹配到的所有地点标签，具体路线请根据文字描述自行规划。</div>
    </div>
  `;
}

function renderMarkdown(text) {
  if (window.marked) {
    marked.setOptions({
      gfm: true,
      breaks: true,
    });
    return marked.parse(text);
  }
  return renderSimpleMarkdown(text);
}

function renderSimpleMarkdown(text) {
  const lines = text.split("\n");
  const html = [];
  let inList = false;
  let inTable = false;

  function closeList() {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  }

  function closeTable() {
    if (inTable) {
      html.push("</tbody></table>");
      inTable = false;
    }
  }

  function inline(value) {
    return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const next = lines[i + 1]?.trim() || "";
    if (!line) {
      closeList();
      closeTable();
      continue;
    }

    const tableCells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    const nextIsDivider = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next);
    const isDivider = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
    if (tableCells.length > 1 && nextIsDivider) {
      closeList();
      closeTable();
      html.push("<table><thead><tr>");
      tableCells.forEach((cell) => html.push(`<th>${inline(cell)}</th>`));
      html.push("</tr></thead><tbody>");
      inTable = true;
      i += 1;
      continue;
    }
    if (inTable && tableCells.length > 1 && !isDivider) {
      html.push("<tr>");
      tableCells.forEach((cell) => html.push(`<td>${inline(cell)}</td>`));
      html.push("</tr>");
      continue;
    }

    closeTable();
    if (line.startsWith("### ")) {
      closeList();
      html.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      closeList();
      html.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      closeList();
      html.push(`<h2>${inline(line.slice(2))}</h2>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else {
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  closeTable();
  return html.join("");
}

function appendMessage(role, text, extraClass = "") {
  const article = document.createElement("article");
  article.className = `message ${role} ${extraClass}`.trim();
  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "AI";
    article.appendChild(avatar);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }
  bubble.dataset.rawText = text;
  article.appendChild(bubble);
  messagesEl.appendChild(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return article;
}

function normalizeMarkdownHeading(line) {
  return String(line || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[\s\d.、:：-]+/, "")
    .trim();
}

function stripDuplicateItineraryMarkdown(text, data) {
  if (!data?.daily_itinerary?.length || !text) return text;
  const lines = String(text).split(/\r?\n/);
  const itineraryHeading = /^(每日行程|行程安排|每日路线|详细行程|推荐路线|旅行路线|游玩路线|日程规划|行程规划)/;
  const dayBlockStart = /^(?:#{1,6}\s*)?(?:Day\s*\d+|D\s*\d+|第\s*[一二三四五六七八九十\d]+\s*天)\b/i;
  const obviousNextPlainSection = /^(天气|交通|酒店|住宿|预算|费用|提醒|提示|注意|景点|地点|餐饮|数据|总结|Weather|Transport|Hotel|Budget|Tips)\b/i;
  const nextSection = /^#{1,6}\s+\S/;
  const output = [];
  let removed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (dayBlockStart.test(trimmed)) {
      removed = true;
      i += 1;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (dayBlockStart.test(next) || nextSection.test(next) || obviousNextPlainSection.test(normalizeMarkdownHeading(next))) {
          i -= 1;
          break;
        }
        if (!next || /^[-*]\s+/.test(next) || /^\d+[.)、]\s+/.test(next) || /^>\s*/.test(next)) {
          i += 1;
          continue;
        }
        i -= 1;
        break;
      }
      continue;
    }
    const normalized = normalizeMarkdownHeading(lines[i]);
    if (itineraryHeading.test(normalized)) {
      removed = true;
      i += 1;
      while (i < lines.length && !nextSection.test(lines[i].trim())) {
        i += 1;
      }
      if (i < lines.length) i -= 1;
      continue;
    }
    output.push(lines[i]);
  }

  return removed ? output.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
}

function removeDuplicateItineraryFromBubble(bubble, data) {
  if (!bubble?.dataset?.rawText) return;
  const original = bubble.dataset.rawText;
  let stripped = stripDuplicateItineraryMarkdown(original, data);
  if (stripped === original) return;
  if (!stripped) {
    stripped = data.summary || "每日行程已整理到下方卡片。";
  }
  bubble.dataset.rawText = stripped;
  bubble.innerHTML = renderMarkdown(stripped);
}

function hotelPhotoFallback(label = "酒店") {
  const fallback = document.createElement("div");
  fallback.className = "hotel-photo hotel-photo-empty";
  fallback.textContent = "酒店";
  fallback.setAttribute("aria-label", label || "酒店");
  return fallback;
}

function replaceBrokenHotelPhoto(image) {
  if (!image) return;
  const skeleton = image.parentElement?.querySelector(".hotel-photo-skeleton");
  if (skeleton) skeleton.remove();
  image.replaceWith(hotelPhotoFallback(image.alt || "酒店"));
}

function retryOrReplaceHotelPhoto(image) {
  if (!image) return;
  const retries = Number(image.dataset.retries || 0);
  if (retries < 2) {
    image.dataset.retries = String(retries + 1);
    const delay = 800 * (retries + 1);
    setTimeout(() => {
      const src = image.dataset.src || "";
      if (!src) {
        replaceBrokenHotelPhoto(image);
        return;
      }
      image.addEventListener("load", () => {
        image.classList.add("hotel-photo-loaded");
        const skeleton = image.parentElement?.querySelector(".hotel-photo-skeleton");
        if (skeleton) skeleton.remove();
      }, { once: true });
      image.src = "";
      void image.offsetHeight;
      image.src = src;
    }, delay);
    return;
  }
  replaceBrokenHotelPhoto(image);
}

function loadHotelImagesBatched(root = document) {
  const images = [...root.querySelectorAll(".hotel-photo[data-src]")];
  if (!images.length) return;
  const pending = images.filter((img) => !img.dataset.loading && !img.classList.contains("hotel-photo-loaded"));
  if (!pending.length) return;

  const BATCH_SIZE = 2;
  const BATCH_DELAY = 300;

  const observer = new IntersectionObserver((entries) => {
    const visible = pending.filter((img) => {
      const rect = img.getBoundingClientRect();
      return rect.top < window.innerHeight + 300 && rect.bottom > -300;
    });
    if (!visible.length) return;

    visible.forEach((img, index) => {
      if (img.dataset.loading === "true" || img.classList.contains("hotel-photo-loaded")) return;
      img.dataset.loading = "true";
      const batch = Math.floor(index / BATCH_SIZE);
      setTimeout(() => {
        const src = img.dataset.src;
        if (!src || img.classList.contains("hotel-photo-loaded")) return;
        img.addEventListener("load", () => {
          img.classList.add("hotel-photo-loaded");
          const skeleton = img.parentElement?.querySelector(".hotel-photo-skeleton");
          if (skeleton) skeleton.remove();
        }, { once: true });
        img.src = src;
      }, batch * BATCH_DELAY);
    });

    const allDone = pending.every((img) => img.classList.contains("hotel-photo-loaded") || img.dataset.loading === "true");
    if (allDone) observer.disconnect();
  }, { rootMargin: "300px" });

  pending.forEach((img) => observer.observe(img));
  setTimeout(() => {
    const stillPending = pending.filter((img) => !img.dataset.loading && !img.classList.contains("hotel-photo-loaded"));
    if (stillPending.length) {
      stillPending.forEach((img, index) => {
        if (img.dataset.loading === "true") return;
        img.dataset.loading = "true";
        const batch = Math.floor(index / BATCH_SIZE);
        setTimeout(() => {
          const src = img.dataset.src;
          if (!src || img.classList.contains("hotel-photo-loaded")) return;
          img.addEventListener("load", () => {
            img.classList.add("hotel-photo-loaded");
            const skeleton = img.parentElement?.querySelector(".hotel-photo-skeleton");
            if (skeleton) skeleton.remove();
          }, { once: true });
          img.src = src;
        }, batch * BATCH_DELAY);
      });
    }
  }, 1200);
}

function proxiedImageUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    return `/api/image_proxy?url=${encodeURIComponent(value)}`;
  }
  return value;
}

function renderWelcome() {
  messagesEl.innerHTML = "";
  appendMessage(
    "assistant",
    "你好，我可以帮你规划旅行。试试输入：“我明天从郑州去杭州，玩3天，2个人，酒店300，餐饮120，门票300”。",
  );
}

function setMessageText(article, text) {
  const bubble = article.querySelector(".bubble");
  if (!bubble) return;
  bubble.textContent = text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return "";
  const total = usage.total_tokens ?? usage.total ?? "";
  return total ? `tokens ${total}` : "";
}

function compactResult(text) {
  if (!text) return "";
  const compact = String(text).replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 140)}...` : compact;
}

function renderLoadingStatus(article, text, trace = [], stats = {}) {
  const bubble = article.querySelector(".bubble");
  if (!bubble) return;
  const existingTrace = bubble.querySelector(".trace-panel");
  const existingTraceList = bubble.querySelector(".trace-list");
  const isTraceInteracting = Date.now() < traceInteractionUntil;
  const traceWasOpen = existingTrace ? existingTrace.open : true;
  const traceWasAtBottom = existingTraceList
    ? existingTraceList.scrollHeight - existingTraceList.scrollTop - existingTraceList.clientHeight < 12
    : true;
  const traceScrollTop = existingTraceList ? existingTraceList.scrollTop : 0;
  const messagesWereAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 32;

  if (isTraceInteracting && existingTrace) {
    const status = bubble.querySelector(".loading-status");
    if (status) status.textContent = text;
    const streamStats = bubble.querySelector(".stream-stats");
    if (streamStats) {
      const parts = [];
      if (stats.eventCount > 0) parts.push(`已收到 ${stats.eventCount} 个阶段事件`);
      if (typeof stats.silentSeconds === "number") parts.push(`距离上次更新 ${stats.silentSeconds}s`);
      if (stats.model) parts.push(stats.model);
      streamStats.textContent = parts.length ? parts.join(" · ") : "正在建立流式连接";
    }
    bubble.dataset.rawText = text;
    return;
  }

  bubble.innerHTML = "";
  const status = document.createElement("div");
  status.className = "loading-status";
  status.textContent = text;
  bubble.appendChild(status);

  const streamStats = document.createElement("div");
  streamStats.className = "stream-stats";
  const parts = [];
  if (stats.eventCount > 0) parts.push(`已收到 ${stats.eventCount} 个阶段事件`);
  if (typeof stats.silentSeconds === "number") parts.push(`距离上次更新 ${stats.silentSeconds}s`);
  if (stats.model) parts.push(stats.model);
  streamStats.textContent = parts.length ? parts.join(" · ") : "正在建立流式连接";
  bubble.appendChild(streamStats);

  if (trace.length) {
    const traceEl = renderTrace(trace, traceWasOpen);
    bubble.appendChild(traceEl);
    const traceList = traceEl.querySelector(".trace-list");
    if (traceList && traceEl.open) {
      if (traceWasAtBottom) {
        traceList.scrollTop = traceList.scrollHeight;
      } else {
        traceList.scrollTop = traceScrollTop;
      }
    }
  }
  bubble.dataset.rawText = text;
  if (messagesWereAtBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function parseSseBuffer(buffer) {
  const events = [];
  const frames = buffer.split("\n\n");
  const rest = frames.pop() || "";
  frames.forEach((frame) => {
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) return;
    try {
      events.push(JSON.parse(dataLines.join("\n")));
    } catch {
      // Ignore malformed stream frames and keep reading the next event.
    }
  });
  return { events, rest };
}

async function loadConversations() {
  try {
    const response = await fetch("/api/conversations");
    const data = await response.json();
    const conversations = data.conversations || [];
    conversationListEl.innerHTML = "";
    conversations.forEach((conversation) => {
      const item = document.createElement("div");
      item.className = `conversation-item ${conversation.id === currentConversationId ? "active" : ""}`;
      item.dataset.id = conversation.id;
      item.innerHTML = `
        <div>
          <div class="conversation-title"></div>
          <div class="conversation-meta">${conversation.message_count || 0} 条消息</div>
        </div>
        <button class="delete-chat-btn" type="button" title="删除">×</button>
      `;
      item.querySelector(".conversation-title").textContent = conversation.title || "新会话";
      item.addEventListener("click", () => loadConversation(conversation.id));
      item.querySelector(".delete-chat-btn").addEventListener("click", async (event) => {
        event.stopPropagation();
        await deleteConversation(conversation.id);
      });
      conversationListEl.appendChild(item);
    });
  } catch {
    conversationListEl.innerHTML = '<div class="conversation-meta">历史会话加载失败</div>';
  }
}

async function loadConversation(conversationId) {
  if (!conversationId) {
    currentConversationId = "";
    localStorage.removeItem(CURRENT_CONVERSATION_KEY);
    renderWelcome();
    await loadConversations();
    return;
  }

  const response = await fetch(`/api/conversations/${conversationId}/messages`);
  const data = await response.json();
  currentConversationId = conversationId;
  localStorage.setItem(CURRENT_CONVERSATION_KEY, conversationId);
  messagesEl.innerHTML = "";
  const messages = data.messages || [];
  if (!messages.length) {
    renderWelcome();
  } else {
    messages.forEach((message) => {
      const article = appendMessage(message.role, message.text || "");
      if (message.meta?.structured_data) {
        renderStructuredCardsInto(article, message.meta.structured_data, message.meta.trace);
      }
      if (message.meta && Object.keys(message.meta).length) {
        appendMeta(article, message.meta);
      }
    });
  }
  await loadConversations();
}

async function deleteConversation(conversationId) {
  await fetch(`/api/conversations/${conversationId}`, { method: "DELETE" });
  if (conversationId === currentConversationId) {
    currentConversationId = "";
    localStorage.removeItem(CURRENT_CONVERSATION_KEY);
    renderWelcome();
  }
  await loadConversations();
}

function traceStatusLabel(status) {
  if (status === "running") return "运行中";
  if (status === "error") return "异常";
  if (status === "success") return "成功";
  return "待处理";
}

function traceStatusClass(status) {
  if (status === "running") return "running";
  if (status === "error") return "error";
  if (status === "success") return "success";
  return "pending";
}

function formatTraceTime(item) {
  if (typeof item.duration_ms === "number") {
    return `耗时 ${(item.duration_ms / 1000).toFixed(2)}s`;
  }
  if (typeof item.started_ms === "number") {
    return `开始 +${(item.started_ms / 1000).toFixed(2)}s`;
  }
  return "";
}

const TRACE_TOOL_INFO = {
  get_weather_info: { label: "天气", title: "查询天气", desc: "获取实时天气和未来预报，判断出行舒适度。" },
  get_air_quality_info: { label: "空气", title: "查询空气质量", desc: "判断户外活动、骑行和老人儿童出行风险。" },
  get_weather_alerts: { label: "预警", title: "查询天气预警", desc: "检查暴雨、大风、高温等灾害预警。" },
  calculate_trip_budget: { label: "预算", title: "计算预算", desc: "按人数、天数、住宿、餐饮和门票估算费用。" },
  search_hotel_prices: { label: "酒店", title: "查询酒店/住宿参考", desc: "优先查询 Booking.com/RapidAPI 实时价格，失败时回退高德酒店 POI。" },
  city_transit_skill: { label: "Skill", title: "市内交通查询 Skill", desc: "综合公交/地铁、步行、骑行和可选路况，给出同城移动建议。" },
  intercity_transport_skill: { label: "Skill", title: "城市间交通查询 Skill", desc: "综合驾车、高铁/火车、航班和可选中转，比较跨城交通方式。" },
  get_transport_advice: { label: "驾车", title: "规划驾车路线", desc: "查询驾车距离、耗时和过路费参考。" },
  search_flight_options: { label: "航班", title: "查询航班", desc: "查询航班时刻、机场、航站楼和状态。" },
  get_public_transit_plan: { label: "公交", title: "规划公交/地铁", desc: "查询市内公共交通换乘方案。" },
  get_walking_route: { label: "步行", title: "规划步行路线", desc: "判断短距离步行可达性。" },
  get_bicycling_route: { label: "骑行", title: "规划骑行路线", desc: "判断共享单车或骑行路线是否合适。" },
  get_route_distance_matrix: { label: "距离", title: "比较距离耗时", desc: "比较多个地点到同一目的地的距离和耗时。" },
  get_traffic_status: { label: "路况", title: "查询实时路况", desc: "检查指定地点周边道路拥堵情况和通行风险。" },
  search_travel_pois: { label: "POI", title: "搜索目的地地点", desc: "查询景点、餐饮、商圈、酒店等 POI。" },
  search_nearby_pois: { label: "周边", title: "搜索周边地点", desc: "围绕指定地点按半径查询餐饮、住宿或地铁站。" },
  search_local_knowledge: { label: "RAG", title: "检索本地知识库", desc: "从本地攻略、实验资料和 Agent 架构文档中检索静态知识。" },
  get_place_location: { label: "定位", title: "解析地点位置", desc: "核验地点地址和经纬度。" },
  get_map_marker_link: { label: "地图", title: "生成地图链接", desc: "生成可打开的高德地图标记链接。" },
  search_train_tickets: { label: "火车", title: "查询火车余票", desc: "查询真实车次、时刻、余票和票价。" },
  search_interline_train_tickets: { label: "中转", title: "查询中转火车", desc: "查询需要换乘的火车/高铁中转方案。" },
  get_train_route: { label: "经停", title: "查询列车经停", desc: "查询指定车次的经停站和时刻表。" },
};

function traceToolInfo(tool) {
  return TRACE_TOOL_INFO[tool] || { label: "工具", title: `调用工具：${tool || "unknown"}`, desc: "调用外部工具补充真实数据。" };
}

function traceArgsSummary(args) {
  if (!args || typeof args !== "object") return "";
  const preferred = [
    "city", "date", "origin", "destination", "origin_city", "destination_city",
    "departure", "arrival", "from_city", "to_city", "place", "keyword",
    "origins", "query", "top_k", "train_code", "train_filter_flags", "adults", "limit",
  ];
  const chips = preferred
    .filter(key => args[key] !== undefined && args[key] !== "" && args[key] !== null)
    .slice(0, 5)
    .map(key => `${key}: ${args[key]}`);
  return chips.map(chip => `<span>${escapeHtml(String(chip))}</span>`).join("");
}

function summarizeTrace(trace) {
  const toolCount = trace.filter((item) => item.type === "tool_call").length;
  const llmCount = trace.filter((item) => item.type === "llm_response").length;
  const runningCount = trace.filter((item) => item.status === "running").length;
  const errorCount = trace.filter((item) => item.status === "error").length;
  const status = [
    `${toolCount} 次工具`,
    `${llmCount} 次模型`,
    runningCount ? `${runningCount} 进行中` : "",
    errorCount ? `${errorCount} 异常` : "",
  ].filter(Boolean).join("，");
  const toolNames = trace
    .filter((item) => item.type === "tool_call")
    .map((item) => traceToolInfo(item.tool).title)
    .filter(Boolean);
  const mainFlow = [...new Set(toolNames)].slice(0, 3).join(" → ");
  return trace.length
    ? `执行过程：${status}${mainFlow ? `｜${mainFlow}` : ""}`
    : "执行过程：等待智能体行动";
}

function renderTrace(trace, expanded = false) {
  const details = document.createElement("details");
  details.className = "trace-panel";
  if (expanded) {
    details.open = true;
  }
  const summary = document.createElement("summary");
  summary.textContent = summarizeTrace(trace);
  details.appendChild(summary);

  const list = document.createElement("div");
  list.className = "trace-list";
  trace.forEach((item) => {
    const row = document.createElement("div");
    const status = item.status || (item.result ? "success" : "pending");
    row.className = `trace-item ${item.type} ${traceStatusClass(status)}`;
    const timeText = formatTraceTime(item);
    const info = traceToolInfo(item.tool);
    const titleText = item.type === "llm_response"
      ? `模型整合结果：${item.model || "unknown"}`
      : item.type === "tool_result"
        ? `${info.title}完成`
        : info.title;

    const args = JSON.stringify(item.args || {}, null, 2);
    const usage = summarizeUsage(item.usage);
    row.innerHTML = `
      <div class="trace-title">
        <span>${item.type === "llm_response" ? "模型" : escapeHtml(info.label)}</span>
        <strong>${escapeHtml(titleText)}</strong>
        <em class="trace-status">${traceStatusLabel(status)}</em>
        ${timeText ? `<em class="trace-time">${escapeHtml(timeText)}</em>` : ""}
      </div>
      ${item.type === "tool_call" ? `<p class="trace-desc">${escapeHtml(info.desc)}</p>` : ""}
      ${item.type === "tool_call" && traceArgsSummary(item.args) ? `<div class="trace-arg-chips">${traceArgsSummary(item.args)}</div>` : ""}
      ${item.type === "tool_call" ? `<details class="trace-raw"><summary>查看原始参数</summary><pre>${escapeHtml(args)}</pre></details>` : ""}
      ${item.type === "llm_response" && usage ? `<p>${escapeHtml(usage)}</p>` : ""}
      ${item.result ? `<p><strong>返回：</strong>${escapeHtml(compactResult(item.result))}</p>` : ""}
      ${item.type === "tool_call" && !item.result ? '<p class="trace-pending">工具运行中，等待返回结果</p>' : ""}
    `;
    list.appendChild(row);
  });
  details.appendChild(list);
  return details;
}

function downloadTraceReport(data) {
  const report = {
    exported_at: new Date().toISOString(),
    mode: data.mode || "",
    model: data.model || "",
    elapsed_seconds: data.elapsed_seconds ?? null,
    trace: data.trace || [],
    structured_data: data.structured_data || null,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `agent-trace-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderTraceActions(data) {
  const actions = document.createElement("div");
  actions.className = "trace-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "trace-export-btn";
  button.textContent = "导出执行报告";
  button.addEventListener("click", () => downloadTraceReport(data));
  actions.appendChild(button);
  return actions;
}

function appendMeta(article, data) {
  const bubble = article.querySelector(".bubble");
  if (!bubble || !data) return;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const parts = [];
  if (data.mode) parts.push(data.mode);
  if (data.model) parts.push(data.model);
  if (typeof data.elapsed_seconds === "number") parts.push(`耗时 ${data.elapsed_seconds}s`);
  meta.textContent = parts.join(" · ");
  if (meta.textContent) {
    bubble.dataset.meta = meta.textContent;
    bubble.appendChild(meta);
  }
  if (Array.isArray(data.trace) && data.trace.length) {
    bubble.dataset.trace = JSON.stringify(data.trace);
    bubble.appendChild(renderTrace(data.trace));
    bubble.appendChild(renderTraceActions(data));
  }
}

async function requestChatStream(payload, onEvent) {
  activeController = new AbortController();
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: activeController.signal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("当前浏览器不支持流式读取。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.rest;
    parsed.events.forEach(onEvent);
  }

  buffer += decoder.decode();
  const parsed = parseSseBuffer(buffer + "\n\n");
  parsed.events.forEach(onEvent);
}

function setBusy(isBusy) {
  inputEl.disabled = isBusy;
  sendBtn.disabled = false;
  sendBtn.classList.toggle("is-stopping", isBusy);
  sendBtn.querySelector("span").textContent = isBusy ? "停止" : "发送";
}


