const messagesEl = document.querySelector("#messages");
const formEl = document.querySelector("#chatForm");
const inputEl = document.querySelector("#messageInput");
const sendBtn = document.querySelector("#sendBtn");
const clearBtn = document.querySelector("#clearBtn");
const offlineToggle = document.querySelector("#offlineToggle");
const thinkingToggle = document.querySelector("#thinkingToggle");
const modelName = document.querySelector("#modelName");
const thinkingModelName = document.querySelector("#thinkingModelName");
const keyStatus = document.querySelector("#keyStatus");
const amapStatus = document.querySelector("#amapStatus");
const qweatherStatus = document.querySelector("#qweatherStatus");
const trainStatus = document.querySelector("#trainStatus");
const aviationStatus = document.querySelector("#aviationStatus");
const hotelStatus = document.querySelector("#hotelStatus");
const locationStatus = document.querySelector("#locationStatus");
const edgeDevicesListEl = document.querySelector("#edgeDevicesDashboardGrid");
const edgeTasksListEl = document.querySelector("#edgeTasksDashboardGrid");
const edgeTasksListCompactEl = document.querySelector("#edgeTasksListCompact");
const refreshEdgeTasksBtn = document.querySelector("#refreshEdgeTasksBtn");
const manualHeartbeatBtn = document.querySelector("#manualHeartbeatBtn");
const conversationListEl = document.querySelector("#conversationList");
const skillsListEl = document.querySelector("#skillsList");
const newChatBtn = document.querySelector("#newChatBtn");
const locateBtn = document.querySelector("#locateBtn");
const inputSuggestToggle = document.querySelector("#inputSuggestToggle");
const inputTipsEl = document.querySelector("#inputTips");
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

formEl.addEventListener("submit", (event) => {
  if (!activeController) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  activeController.abort();
  activeController = null;
  setBusy(false);
}, true);

function insertSkillCall(skill) {
  if (!inputEl || !skill) return;
  const call = skill.explicit_call || `@${skill.display_name || skill.name}`;
  const current = inputEl.value.trim();
  inputEl.value = current ? `${call} ${current}` : `${call} `;
  inputEl.focus();
  inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
}

function renderSkills(skills) {
  if (!skillsListEl) return;
  if (!Array.isArray(skills) || !skills.length) {
    skillsListEl.innerHTML = '<div class="skill-empty">暂无已安装 Skill</div>';
    return;
  }
  skillsListEl.innerHTML = "";
  skills.forEach((skill) => {
    const card = document.createElement("div");
    card.className = "skill-card";
    const tools = (skill.tools || []).slice(0, 4)
      .map((tool) => `<span>${escapeHtml(tool)}</span>`)
      .join("");
    card.innerHTML = `
      <div class="skill-card-head">
        <h3>${escapeHtml(skill.display_name || skill.name || "Skill")}</h3>
        <button class="skill-use-btn" type="button">使用</button>
      </div>
      <p>${escapeHtml(skill.description || "")}</p>
      <span class="skill-call">${escapeHtml(skill.explicit_call || `@${skill.display_name || skill.name || "Skill"}`)}</span>
      ${tools ? `<div class="skill-tools">${tools}</div>` : ""}
    `;
    card.querySelector(".skill-use-btn")?.addEventListener("click", () => insertSkillCall(skill));
    skillsListEl.appendChild(card);
  });
}

async function loadSkills() {
  if (!skillsListEl) return;
  try {
    const response = await fetch("/api/skills");
    const data = await response.json();
    renderSkills(data.skills || []);
  } catch {
    skillsListEl.innerHTML = '<div class="skill-empty">读取失败</div>';
  }
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    modelName.textContent = data.model || "未知";
    thinkingModelName.textContent = data.thinking_model || "未知";
    keyStatus.textContent = data.api_key_loaded ? "已配置" : "未配置";
    if (amapStatus) amapStatus.textContent = data.amap_key_loaded ? "已配置" : "未配置";
    if (qweatherStatus) {
      qweatherStatus.textContent = data.qweather_key_loaded
        ? (data.qweather_host_loaded ? "已配置" : "缺少 Host")
        : "未配置";
    }
    if (trainStatus) trainStatus.textContent = data.train_tools_available ? "可用" : "未检测到";
    if (aviationStatus) aviationStatus.textContent = data.aviationstack_key_loaded ? "已配置" : "未配置";
    if (hotelStatus) hotelStatus.textContent = data.rapidapi_key_loaded ? "已配置" : "未配置";
  } catch {
    modelName.textContent = "读取失败";
    thinkingModelName.textContent = "读取失败";
    keyStatus.textContent = "未知";
    if (amapStatus) amapStatus.textContent = "未知";
    if (qweatherStatus) qweatherStatus.textContent = "未知";
    if (trainStatus) trainStatus.textContent = "未知";
    if (aviationStatus) aviationStatus.textContent = "未知";
    if (hotelStatus) hotelStatus.textContent = "未知";
  }
}

function cleanMarkdownForPreview(text) {
  if (!text) return "";
  return String(text)
    .replace(/#{1,6}\s+/g, "") // Remove headers
    .replace(/[\-\*\+]\s+/g, "") // Remove lists
    .replace(/\|/g, " ") // Remove table dividers
    .replace(/\*\*/g, "") // Remove bold
    .replace(/`/g, "") // Remove inline code
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}

function parseAgentAnalysis(answer) {
  if (!answer) return null;
  const sections = {
    semantics: "",
    risk: "",
    riskLevel: "低风险",
    advice: []
  };

  // Extract Semantics
  const semMatch = answer.match(/(?:##\s*💡\s*场景语义分析[^\n]*)\n([\s\S]*?)(?=\n##|$)/);
  if (semMatch) sections.semantics = semMatch[1].trim();

  // Extract Risk
  const riskMatch = answer.match(/(?:##\s*⚠️\s*风险等级评估[^\n]*)\n([\s\S]*?)(?=\n##|$)/);
  if (riskMatch) {
    const text = riskMatch[1].trim();
    sections.risk = text;
    if (text.includes("高风险")) sections.riskLevel = "高风险";
    else if (text.includes("中风险")) sections.riskLevel = "中风险";
    else sections.riskLevel = "低风险";
  }

  // Extract Advice
  const advMatch = answer.match(/(?:##\s*🛠️\s*智能处置建议[^\n]*)\n([\s\S]*?)$/);
  if (advMatch) {
    const text = advMatch[1].trim();
    const lines = text.split("\n").map(l => l.trim()).filter(l => l);
    sections.advice = lines.map(line => line.replace(/^\d+[\.\s]+|^\-\s+/, "").trim());
  }

  return sections;
}

function getRelativeTimeStr(date) {
  const diffMs = new Date() - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHr < 24) return `${diffHr} 小时前`;
  return `${diffDay} 天前`;
}

function renderEdgeTasks(tasks, container) {
  if (!container) return;
  if (!tasks || !tasks.length) {
    container.innerHTML = '<div class="edge-empty">暂无协同推理任务</div>';
    return;
  }
  container.innerHTML = tasks.slice(0, 6).map((task) => {
    const event = task.event || {};
    const summary = event.summary || {};
    const inference = event.inference || {};
    const counts = summary.class_counts || {};
    const countText = Object.keys(counts).length
      ? Object.entries(counts).map(([name, count]) => `${name}:${count}`).join(" / ")
      : `total:${summary.total_count || 0}`;
    const perfText = inference.fps ? `${inference.fps} FPS` : (inference.latency_ms ? `${inference.latency_ms} ms` : "无性能数据");
    
    // Parse Agent analysis report
    const parsed = parseAgentAnalysis(task.analysis?.answer);
    let analysisHtml = "";
    if (parsed) {
      const riskClass = parsed.riskLevel === "高风险" ? "high" : (parsed.riskLevel === "中风险" ? "medium" : "low");
      analysisHtml = `
        <div class="agent-analysis-card-box">
          <div class="agent-box-header">
            <span class="agent-avatar-mini">🤖</span>
            <strong>云端 Agent 智能研判结果</strong>
            <span class="risk-badge-mini ${riskClass}">${escapeHtml(parsed.riskLevel)}</span>
          </div>
          <div class="agent-box-body">
            <p class="analysis-semantics"><strong>💡 场景理解：</strong>${escapeHtml(parsed.semantics || "解析中...")}</p>
            ${parsed.advice.length ? `
              <div class="analysis-advice-list">
                <strong>🛠️ 处置建议：</strong>
                <ul>
                  ${parsed.advice.slice(0, 2).map(adv => `<li>${escapeHtml(adv)}</li>`).join("")}
                </ul>
              </div>
            ` : ""}
          </div>
        </div>
      `;
    } else if (event.edge_decision?.need_cloud_analysis) {
      analysisHtml = `
        <div class="agent-analysis-card-box" style="border-style: dashed; text-align: center; color: var(--muted);">
          <div class="agent-box-body" style="padding: 10px 0;">
            <p>🤖 等待云端 Agent 智能决策分析...</p>
          </div>
        </div>
      `;
    }
      
    const imageUrl = event.annotated_image_url || "";
    const decision = event.edge_decision || {};
    const dispatchReason = decision.reason || "";
    const needCloud = decision.need_cloud_analysis;
    const factors = [];
    const personCount = summary.person_count;
    const vehicleCount = summary.vehicle_count;
    if (personCount !== undefined && personCount > 0) factors.push(`人:${personCount}`);
    if (vehicleCount !== undefined && vehicleCount > 0) factors.push(`车:${vehicleCount}`);
    if (inference.conf_thres !== undefined) factors.push(`阈值:${inference.conf_thres}`);
    if (summary.total_count !== undefined) factors.push(`目标数:${summary.total_count}`);
    const factorsHtml = factors.length
      ? `<div class="edge-decision-factors">${factors.map((f) => `<span>${escapeHtml(f)}</span>`).join("")}</div>`
      : "";
      
    const modeBadge = needCloud
      ? '<span class="edge-cloud-chip on" title="触发协同调度机制，数据上云运行智能体深度决策">☁️ 边云协同模式 (数据上云)</span>'
      : '<span class="edge-cloud-chip off" title="目标置信度充足，由边端本地闭环处理，节省网络带宽">💻 边端自闭环模式 (本地处理)</span>';
      
    const yoloCompletedClass = "completed";
    const dispatchCompletedClass = "completed";
    const agentClass = task.analysis ? "completed" : (needCloud ? "pending" : "skipped");
    
    // Created time relative and absolute
    const createdTime = task.created_at ? new Date(task.created_at.replace("Z", "+00:00")) : null;
    const timeDisplay = createdTime 
      ? `<span class="edge-task-time" title="绝对时间: ${escapeHtml(task.created_at)}" style="font-size: 11px; color: var(--muted); margin-top: 4px; display: inline-block;">⏰ ${getRelativeTimeStr(createdTime)}</span>`
      : "";
    
    return `
      <div class="edge-task-card" data-edge-task-id="${escapeHtml(task.id || "")}">
        <div class="edge-task-image-container">
          <img class="edge-task-image" src="${escapeHtml(imageUrl)}" alt="Atlas YOLO annotated result" loading="lazy" style="${imageUrl ? '' : 'display:none;'}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
          <div class="edge-task-image-fallback" style="${imageUrl ? 'display:none;' : 'display:flex;'}">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
            <span>无有效标注图</span>
          </div>
        </div>
        
        <div class="edge-task-main">
          <strong>${escapeHtml(task.image_id || event.image_id || "未命名图片")}</strong>
          <span>设备: ${escapeHtml(task.device_id || event.device_id || "unknown-device")}</span>
          ${timeDisplay}
        </div>
        
        <div class="edge-task-meta">
          ${modeBadge}
          <span>${escapeHtml(task.status === 'completed' ? '已分析' : (task.status || '已接收'))}</span>
        </div>
        
        <div class="edge-pipeline">
          <div class="pipeline-step ${yoloCompletedClass}">
            <div class="step-indicator">
              <span class="step-dot">1</span>
              <span class="step-line"></span>
            </div>
            <div class="step-content">
              <div class="step-title">边端本地 YOLO 推理</div>
              <div class="step-desc">
                检测结果: <strong>${escapeHtml(countText)}</strong> (${escapeHtml(perfText)})
              </div>
            </div>
          </div>
          
          <div class="pipeline-step ${dispatchCompletedClass}">
            <div class="step-indicator">
              <span class="step-dot">2</span>
              <span class="step-line"></span>
            </div>
            <div class="step-content">
              <div class="step-title">协同调度判定</div>
              <div class="step-desc">
                决策: <strong class="${needCloud ? 'text-cloud' : 'text-local'}">${needCloud ? '数据上云分析' : '本地闭环处理'}</strong>
                ${dispatchReason ? `<div class="step-reason">${escapeHtml(dispatchReason)}</div>` : ''}
                ${factorsHtml}
              </div>
            </div>
          </div>
          
          <div class="pipeline-step ${agentClass}">
            <div class="step-indicator">
              <span class="step-dot">3</span>
            </div>
            <div class="step-content">
              <div class="step-title">云端智能体决策</div>
              <div class="step-desc">
                ${task.analysis 
                  ? '场景深度理解与推荐策略已生成' 
                  : (needCloud ? '正在等待云端 Agent 运行决策分析...' : '本地推理置信度充足，无需触发云端 Agent')}
              </div>
            </div>
          </div>
        </div>
        
        ${analysisHtml}
        
        <div class="edge-task-actions">
          <a class="edge-report-link" href="/api/edge/tasks/${encodeURIComponent(task.id || "")}/report" target="_blank" rel="noreferrer">导出报告</a>
          <button type="button" class="edge-analyze-btn" data-task-id="${escapeHtml(task.id || "")}">
            ${task.analysis ? '重新研判' : '云端分析'}
          </button>
        </div>
      </div>
    `;
  }).join("");
  
  container.querySelectorAll(".edge-analyze-btn").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      analyzeEdgeTask(button.dataset.taskId, button);
    });
  });
  container.querySelectorAll(".edge-task-card[data-edge-task-id]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) return;
      const taskId = card.dataset.edgeTaskId;
      if (taskId) openEdgeTaskModal(taskId);
    });
  });
}

function renderEdgeTasksCompact(tasks, container) {
  if (!container) return;
  if (!tasks || !tasks.length) {
    container.innerHTML = '<div class="edge-empty">暂无协同日志</div>';
    return;
  }
  container.innerHTML = tasks.map((task) => {
    const event = task.event || {};
    const needCloud = event.edge_decision?.need_cloud_analysis;
    const imageUrl = event.annotated_image_url || "";
    const statusClass = task.status === 'completed' ? "completed" : "received";
    const statusText = task.status === 'completed' ? "已分析" : "已接收";
    const modeBadgeCompact = needCloud
      ? '<span class="compact-badge cloud" title="边云协同 (数据上云)">☁️ 协同</span>'
      : '<span class="compact-badge local" title="边端自闭环 (本地处理)">💻 本地</span>';
    const timeStr = task.created_at ? task.created_at.slice(11, 16) : '';
    
    return `
      <div class="edge-task-row-compact" data-edge-task-id="${escapeHtml(task.id || "")}">
        <div class="task-row-thumb-container">
          ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" class="task-row-thumb" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ''}
          <div class="task-row-thumb-fallback" style="${imageUrl ? 'display:none;' : 'display:flex;'}">📷</div>
        </div>
        <div class="task-row-body">
          <div class="task-row-header">
            <span class="task-row-title" title="${escapeHtml(task.image_id || event.image_id || '')}">${escapeHtml(task.image_id || event.image_id || "未命名")}</span>
            <span class="task-row-time">${escapeHtml(timeStr)}</span>
          </div>
          <div class="task-row-meta">
            ${modeBadgeCompact}
            <span class="task-row-status-chip ${statusClass}">${statusText}</span>
            <span class="task-row-device" title="设备 ID: ${escapeHtml(task.device_id || '')}">${escapeHtml(task.device_id || "unknown").slice(-8)}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
  
  container.querySelectorAll(".edge-task-row-compact[data-edge-task-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const taskId = row.dataset.edgeTaskId;
      if (taskId) openEdgeTaskModal(taskId);
    });
  });
}

function renderEdgeDevicesDashboard(devices, container) {
  if (!container) return;
  if (!devices || !devices.length) {
    container.innerHTML = '<div class="edge-empty">暂无边端设备状态</div>';
    return;
  }
  container.innerHTML = devices.map((device) => {
    let metrics = device.system_metrics || {};
    
    const statusClass = device.online ? "online" : "offline";
    const statusText = device.online ? "在线 (活动中)" : "离线 (休眠)";
    
    // Clear metrics if offline to avoid confusion
    if (!device.online) {
      metrics = {};
      device.latest_fps = null;
      device.latest_latency_ms = null;
    }
    
    const memory = metrics.memory || {};
    const loadavg = metrics.loadavg || {};
    const npu = metrics.npu || {};
    
    const fpsText = device.latest_fps ? `${device.latest_fps} FPS` : "无数据";
    const latencyText = device.latest_latency_ms ? `${device.latest_latency_ms} ms` : "无数据";
    
    const memPct = memory.used_percent !== undefined ? memory.used_percent : 0;
    
    let loadVal = 0;
    if (typeof loadavg === "string") {
      loadVal = parseFloat(loadavg.split(" ")[0]) || 0;
    } else if (loadavg && typeof loadavg === "object") {
      loadVal = parseFloat(loadavg["1m"]) || 0;
    }
    const loadPercent = Math.min(100, Math.round(loadVal * 33));
    
    const npuPct = npu.utilization_percent !== undefined ? npu.utilization_percent : 0;
    const npuTemp = npu.temperature_c !== undefined ? `${npu.temperature_c} ℃` : "无数据";
    const npuMemPct = npu.memory_used_percent !== undefined ? npu.memory_used_percent : 0;
    
    const npuFallbackHtml = npu.utilization_percent === undefined && npu.memory_used_percent === undefined && (npu.raw_available !== undefined || npu.error)
      ? `
            <div class="device-metric-row" data-tooltip="${escapeHtml(npu.raw_preview || npu.error || "NPU 指标暂未解析")}">
              <div class="metric-row-label">
                <span>🧠 昇腾 NPU 状态 ⓘ</span>
                <strong>${npu.raw_available ? "已读取，格式待适配" : "无可用数据"}</strong>
              </div>
              <div class="metric-progress-bg">
                <div class="metric-progress-fill npu" style="width: ${npu.raw_available ? 12 : 0}%"></div>
              </div>
            </div>
        `
      : "";
    
    const pendingCount = device.pending_events || 0;
    const pendingHtml = pendingCount > 0
      ? `<div class="device-metric-row warning-row" data-tooltip="待发重传缓存：当边缘端与云端网络中断时，检测事件包会被安全缓存到本地待发队列中，重连后自动重传。">
           <span class="metric-label">📦 待发重传缓存</span>
           <span class="metric-val text-cloud">${pendingCount} 个待挂起事件</span>
         </div>`
      : "";
      
    return `
      <div class="dashboard-device-card ${statusClass}">
        <div class="device-card-header">
          <div class="device-name-area">
            <h4>${escapeHtml(device.device_id || "unknown-device")}</h4>
            <span>主机: ${escapeHtml(device.hostname || "unknown-host")}</span>
          </div>
          <span class="device-status-badge ${statusClass}">${statusText}</span>
        </div>
        
        <div class="device-card-metrics">
          <div class="device-metric-group">
            <h5>⚡ 边端 YOLO 推理性能</h5>
            <div class="device-perf-grid">
              <div><span>推理帧率 (FPS)</span><strong>${fpsText}</strong></div>
              <div><span>单帧延迟 (Latency)</span><strong>${latencyText}</strong></div>
            </div>
          </div>
          
          <div class="device-metric-group">
            <h5>📊 硬件指标实时状态</h5>
            
            <div class="device-metric-row" data-tooltip="系统平均负载 (Loadavg 1m)：过去1分钟内处于可运行或等待状态的平均任务数。当负载高于CPU核心数时，表示系统出现算力拥堵。">
              <div class="metric-row-label">
                <span>📈 系统平均负载 (CPU Load 1m) ⓘ</span>
                <strong>${loadPercent}% <small style="color:var(--muted); font-weight:400;">(负载: ${loadVal})</small></strong>
              </div>
              <div class="metric-progress-bg">
                <div class="metric-progress-fill cpu" style="width: ${loadPercent}%"></div>
              </div>
            </div>
            
            <div class="device-metric-row" data-tooltip="系统内存使用率：边端设备当前使用的物理内存（RAM）比例。可用空间不足可能会导致推理进程被系统强制终止。">
              <div class="metric-row-label">
                <span>💾 系统内存使用率 (RAM Memory) ⓘ</span>
                <strong>${memPct}% <small style="color:var(--muted); font-weight:400;">(${memory.available_mb || 0} MB 可用 / 共 ${memory.total_mb || 0} MB)</small></strong>
              </div>
              <div class="metric-progress-bg">
                <div class="metric-progress-fill memory" style="width: ${memPct}%"></div>
              </div>
            </div>
            
            ${npu.utilization_percent !== undefined ? `
            <div class="device-metric-row" data-tooltip="昇腾 NPU 核心利用率：达芬奇架构 AI 核心（AI Core）的计算负载比例。反映了 YOLO 神经网络推理的芯片资源占用。">
              <div class="metric-row-label">
                <span>🧠 昇腾 NPU 核心利用率 ⓘ</span>
                <strong>${npuPct}% <small style="color:var(--muted); font-weight:400;">(温度: ${npuTemp})</small></strong>
              </div>
              <div class="metric-progress-bg">
                <div class="metric-progress-fill npu" style="width: ${npuPct}%"></div>
              </div>
            </div>
            ` : ''}
            
            ${npu.memory_used_percent !== undefined ? `
            <div class="device-metric-row" data-tooltip="昇腾 NPU 显存使用率：用于存放 YOLO 神经网络模型参数和特征图的专用高速显存空间占用量。">
              <div class="metric-row-label">
                <span>📼 昇腾 NPU 显存使用率 ⓘ</span>
                <strong>${npuMemPct}% <small style="color:var(--muted); font-weight:400;">(${npu.memory_used_mb || 0}/${npu.memory_total_mb || 0} MB)</small></strong>
              </div>
              <div class="metric-progress-bg">
                <div class="metric-progress-fill npu" style="width: ${npuMemPct}%"></div>
              </div>
            </div>
            ` : ''}
            ${npuFallbackHtml}
          </div>
          
          ${pendingHtml}
        </div>
        
        <div class="device-card-footer">
          <span>最近活跃: ${escapeHtml(device.latest_image_id || "无任务")} · ${device.age_seconds != null ? `${device.age_seconds} 秒前` : "无记录"}</span>
        </div>
      </div>
    `;
  }).join("");
}

async function loadEdgeTasks() {
  const edgeTasksListCompactEl = document.querySelector("#edgeTasksListCompact");
  const edgeDevicesDashboardGridEl = document.querySelector("#edgeDevicesDashboardGrid");
  const edgeTasksDashboardGridEl = document.querySelector("#edgeTasksDashboardGrid");

  try {
    const [tasksResponse, statusResponse] = await Promise.all([
      fetch("/api/edge/tasks?limit=24"),
      fetch("/api/edge/status"),
    ]);
    const tasksData = await tasksResponse.json();
    const statusData = await statusResponse.json();
    
    if (edgeDevicesDashboardGridEl) {
      renderEdgeDevicesDashboard(statusData.devices || [], edgeDevicesDashboardGridEl);
    }
    if (edgeTasksDashboardGridEl) {
      renderEdgeTasks(tasksData.tasks || [], edgeTasksDashboardGridEl);
    }
    if (edgeTasksListCompactEl) {
      renderEdgeTasksCompact(tasksData.tasks || [], edgeTasksListCompactEl);
    }
  } catch (err) {
    console.error("Error loading edge logs:", err);
    if (edgeDevicesDashboardGridEl) {
      edgeDevicesDashboardGridEl.innerHTML = '<div class="edge-empty">设备状态监控数据读取失败</div>';
    }
    if (edgeTasksDashboardGridEl) {
      edgeTasksDashboardGridEl.innerHTML = '<div class="edge-empty">边端协同任务流读取失败</div>';
    }
    if (edgeTasksListCompactEl) {
      edgeTasksListCompactEl.innerHTML = '<div class="edge-empty">任务日志读取失败</div>';
    }
  }
}

async function sendManualHeartbeat(button) {
  if (!button) return;
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "发送中...";
  try {
    const statusResponse = await fetch("/api/edge/status");
    const statusData = await statusResponse.json();
    const firstDevice = Array.isArray(statusData.devices) && statusData.devices.length
      ? statusData.devices[0]
      : {};
    const payload = {
      device_id: firstDevice.device_id || "atlas-200i-dk-a2-01",
      hostname: firstDevice.hostname || "dashboard-manual",
      source: "dashboard_manual",
      note: "Manual heartbeat sent from dashboard button.",
      system_metrics: firstDevice.system_metrics || {},
      pending_events: firstDevice.pending_events || 0,
    };
    const response = await fetch("/api/edge/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "心跳发送失败");
    }
    button.textContent = "已发送";
    await loadEdgeTasks();
    setTimeout(() => {
      button.textContent = oldText || "发送心跳";
      button.disabled = false;
    }, 1200);
  } catch (err) {
    console.error("Manual heartbeat failed:", err);
    button.textContent = "发送失败";
    setTimeout(() => {
      button.textContent = oldText || "发送心跳";
      button.disabled = false;
    }, 1600);
  }
}

async function analyzeEdgeTask(taskId, button) {
  if (!taskId || !button) return;
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "分析中...";
  try {
    const response = await fetch("/api/edge/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, thinking_mode: true }),
    });
    if (!response.ok) throw new Error("analysis failed");
    await loadEdgeTasks();
  } catch {
    button.disabled = false;
    button.textContent = oldText || "云端分析";
  }
}

// ---- Edge Task Detail Modal ----

const edgeTaskModal = document.querySelector("#edgeTaskModal");
const modalBody = document.querySelector("#modalBody");
const modalCloseBtn = document.querySelector("#modalCloseBtn");
const modalTaskTitle = document.querySelector("#modalTaskTitle");
const modalReportLink = document.querySelector("#modalReportLink");
const modalReportLinkHtml = document.querySelector("#modalReportLinkHtml");
const modalAnalyzeBtn = document.querySelector("#modalAnalyzeBtn");

let modalCurrentTaskId = "";

function openEdgeTaskModal(taskId) {
  if (!edgeTaskModal || !modalBody) return;
  modalCurrentTaskId = taskId;
  modalBody.innerHTML = '<div class="modal-loading">加载任务详情...</div>';
  edgeTaskModal.hidden = false;
  document.body.style.overflow = "hidden";

  fetch(`/api/edge/tasks/${encodeURIComponent(taskId)}`)
    .then((response) => response.json())
    .then((data) => {
      if (!data.ok) throw new Error(data.error || "请求失败");
      renderEdgeTaskDetail(data.task);
    })
    .catch((err) => {
      modalBody.innerHTML = `<div class="modal-error">加载失败: ${escapeHtml(err.message)}</div>`;
    });
}

function closeEdgeTaskModal() {
  if (edgeTaskModal) edgeTaskModal.hidden = true;
  document.body.style.overflow = "";
  modalCurrentTaskId = "";
}

function renderEdgeTaskDetail(task) {
  if (!modalTaskTitle || !modalBody) return;
  const event = task.event || {};
  const inference = event.inference || {};
  const summary = event.summary || {};
  const systemMetrics = event.system_metrics || {};
  const analysis = task.analysis || {};
  const detections = event.detections || [];
  const edgeDecision = event.edge_decision || {};

  modalTaskTitle.textContent = `任务: ${task.image_id || event.image_id || "未命名"}`;
  if (modalReportLink) modalReportLink.href = `/api/edge/tasks/${encodeURIComponent(task.id || "")}/report`;
  if (modalReportLinkHtml) modalReportLinkHtml.href = `/api/edge/tasks/${encodeURIComponent(task.id || "")}/report/html`;
  if (modalAnalyzeBtn) {
    modalAnalyzeBtn.hidden = !!analysis.answer;
    modalAnalyzeBtn.disabled = false;
    modalAnalyzeBtn.textContent = "触发云端分析";
  }

  let html = "";

  // 1. Basic info
  html += `
    <section class="modal-section">
      <h4 class="modal-section-title">基本信息</h4>
      <div class="modal-info-grid">
        <div><span>任务 ID</span><code>${escapeHtml(task.id || "")}</code></div>
        <div><span>设备</span>${escapeHtml(task.device_id || event.device_id || "")}</div>
        <div><span>主机名</span>${escapeHtml(event.hostname || "")}</div>
        <div><span>图片</span>${escapeHtml(task.image_id || event.image_id || "")}</div>
        <div><span>来源</span>${escapeHtml(task.source_type || event.source_type || "")}</div>
        <div><span>状态</span><strong>${escapeHtml(task.status || "")}</strong></div>
        <div><span>创建时间</span>${escapeHtml(task.created_at || "")}</div>
        <div><span>更新时间</span>${escapeHtml(task.updated_at || "")}</div>
      </div>
    </section>
  `;

  // 2. Inference metrics
  html += `
    <section class="modal-section">
      <h4 class="modal-section-title">推理性能</h4>
      <div class="modal-metrics-grid">
        <div class="modal-metric"><div>模型</div><strong>${escapeHtml(inference.model || "N/A")}</strong></div>
        <div class="modal-metric"><div>延迟</div><strong>${inference.latency_ms != null ? `${inference.latency_ms} ms` : "N/A"}</strong></div>
        <div class="modal-metric"><div>FPS</div><strong>${inference.fps != null ? inference.fps : "N/A"}</strong></div>
        <div class="modal-metric"><div>置信阈值</div><strong>${inference.conf_thres != null ? inference.conf_thres : "N/A"}</strong></div>
        <div class="modal-metric"><div>IoU 阈值</div><strong>${inference.iou_thres != null ? inference.iou_thres : "N/A"}</strong></div>
      </div>
    </section>
  `;

  // 3. Annotated image
  const annotatedUrl = event.annotated_image_url || "";
  if (annotatedUrl) {
    html += `
      <section class="modal-section">
        <h4 class="modal-section-title">标注图像</h4>
        <img class="modal-annotated-image" src="${escapeHtml(annotatedUrl)}" alt="YOLO annotated result" loading="lazy">
      </section>
    `;
  }

  // 4. Detection table
  if (detections.length) {
    html += `
      <section class="modal-section">
        <h4 class="modal-section-title">检测明细 (${detections.length} 个目标)</h4>
        <div class="modal-table-wrap">
          <table class="modal-detection-table">
            <thead><tr><th>#</th><th>类别</th><th>类别 ID</th><th>置信度</th><th>边界框</th></tr></thead>
            <tbody>
              ${detections.map((d, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td><strong>${escapeHtml(String(d.class_name || d.class_id || ""))}</strong></td>
                  <td>${d.class_id != null ? d.class_id : ""}</td>
                  <td>${typeof d.confidence === "number" ? (d.confidence * 100).toFixed(1) + "%" : "N/A"}</td>
                  <td>${d.bbox ? escapeHtml(d.bbox.map((v) => v.toFixed(1)).join(", ")) : "N/A"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  // 5. Summary
  const countEntries = Object.entries(summary.class_counts || {});
  const countText = countEntries.length
    ? countEntries.map(([k, v]) => `${k}:${v}`).join(", ")
    : `total:${summary.total_count || 0}`;
  html += `
    <section class="modal-section">
      <h4 class="modal-section-title">检测摘要</h4>
      <div class="modal-metrics-grid">
        <div class="modal-metric"><div>总目标数</div><strong>${summary.total_count || 0}</strong></div>
        <div class="modal-metric"><div>人数</div><strong>${summary.person_count || 0}</strong></div>
        <div class="modal-metric"><div>车辆数</div><strong>${summary.vehicle_count || 0}</strong></div>
      </div>
      <div style="font-size:13px;margin-top:8px;color:var(--muted)">${escapeHtml(countText)}</div>
    </section>
  `;

  // 6. Scheduling decision
  html += `
    <section class="modal-section">
      <h4 class="modal-section-title">调度决策</h4>
      <div class="modal-decision">${escapeHtml(edgeDecision.reason || "无决策原因")}</div>
      <div class="modal-info-grid">
        <div><span>本地处理</span>${edgeDecision.handled_locally ? "是" : "否"}</div>
        <div><span>云端分析</span><strong>${edgeDecision.need_cloud_analysis ? "需要" : "不需要"}</strong></div>
      </div>
    </section>
  `;

  // 7. System metrics
  if (Object.keys(systemMetrics).length) {
    const memory = systemMetrics.memory || {};
    const loadavg = systemMetrics.loadavg || {};
    const npu = systemMetrics.npu || {};

    let loadVal = 0;
    if (typeof loadavg === "string") {
      loadVal = parseFloat(loadavg.split(" ")[0]) || 0;
    } else if (loadavg && typeof loadavg === "object") {
      loadVal = parseFloat(loadavg["1m"]) || 0;
    }
    const loadPercent = Math.min(100, Math.round(loadVal * 33));

    let metricsHtml = "";

    // CPU load bar
    metricsHtml += `
      <div class="modal-metric-visual-row">
        <span class="metric-visual-label">系统负载 (1m)</span>
        <div class="metric-visual-progress-bg">
          <div class="metric-visual-progress-fill cpu" style="width: ${loadPercent}%"></div>
        </div>
        <span class="metric-visual-value">负载: ${loadVal}</span>
      </div>
    `;

    // Memory bar
    if (memory.used_percent !== undefined) {
      metricsHtml += `
        <div class="modal-metric-visual-row">
          <span class="metric-visual-label">内存使用率</span>
          <div class="metric-visual-progress-bg">
            <div class="metric-visual-progress-fill memory" style="width: ${memory.used_percent}%"></div>
          </div>
          <span class="metric-visual-value">${memory.used_percent}% (${memory.available_mb || 0} MB 可用)</span>
        </div>
      `;
    }

    // NPU metrics if Ascend NPU data is present
    if (npu.utilization_percent !== undefined) {
      metricsHtml += `
        <div class="modal-metric-visual-row">
          <span class="metric-visual-label">NPU 使用率</span>
          <div class="metric-visual-progress-bg">
            <div class="metric-visual-progress-fill npu" style="width: ${npu.utilization_percent}%"></div>
          </div>
          <span class="metric-visual-value">${npu.utilization_percent}% (${npu.temperature_c}℃)</span>
        </div>
      `;
    }
    if (npu.memory_used_percent !== undefined) {
      metricsHtml += `
        <div class="modal-metric-visual-row">
          <span class="metric-visual-label">NPU 显存占用</span>
          <div class="metric-visual-progress-bg">
            <div class="metric-visual-progress-fill npu" style="width: ${npu.memory_used_percent}%"></div>
          </div>
          <span class="metric-visual-value">${npu.memory_used_percent}% (${npu.memory_used_mb}/${npu.memory_total_mb} MB)</span>
        </div>
      `;
    }

    html += `
      <section class="modal-section">
        <h4 class="modal-section-title">系统指标监控</h4>
        <div class="modal-metrics-dashboard">
          ${metricsHtml}
        </div>
        <details class="modal-metrics-raw">
          <summary>查看原始 JSON 数据</summary>
          <pre class="modal-metrics-json">${escapeHtml(JSON.stringify(systemMetrics, null, 2))}</pre>
        </details>
      </section>
    `;
  }

  // 8. Agent analysis
  if (analysis.answer) {
    html += `
      <section class="modal-section">
        <h4 class="modal-section-title">云端 Agent 分析</h4>
        <div class="modal-analysis-full">${renderMarkdown(analysis.answer)}</div>
      </section>
    `;
  } else {
    html += `
      <section class="modal-section">
        <h4 class="modal-section-title">云端 Agent 分析</h4>
        <p style="color:var(--muted);font-size:13px">尚未生成云端分析。可点击下方按钮触发分析。</p>
      </section>
    `;
  }

  // 9. Agent trace
  const traceData = analysis.trace;
  if (Array.isArray(traceData) && traceData.length) {
    html += `
      <section class="modal-section">
        <h4 class="modal-section-title">Agent 执行追踪</h4>
    `;
    modalBody.innerHTML = html;
    const section = modalBody.lastElementChild;
    section.appendChild(renderTrace(traceData, true));
    return;
  }

  modalBody.innerHTML = html;
}

// Bind modal events
if (modalCloseBtn) {
  modalCloseBtn.addEventListener("click", closeEdgeTaskModal);
}
if (edgeTaskModal) {
  edgeTaskModal.addEventListener("click", (e) => {
    if (e.target === edgeTaskModal) closeEdgeTaskModal();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && edgeTaskModal && !edgeTaskModal.hidden) {
    closeEdgeTaskModal();
  }
});
if (modalAnalyzeBtn) {
  modalAnalyzeBtn.addEventListener("click", async () => {
    if (!modalCurrentTaskId) return;
    const btn = modalAnalyzeBtn;
    btn.disabled = true;
    btn.textContent = "分析中...";
    try {
      const response = await fetch("/api/edge/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: modalCurrentTaskId, thinking_mode: true }),
      });
      if (!response.ok) throw new Error("analysis failed");
      const data = await response.json();
      if (data.ok) {
        renderEdgeTaskDetail(data.task);
        loadEdgeTasks();
      }
    } catch {
      btn.disabled = false;
      btn.textContent = "触发云端分析";
    }
  });
}

async function detectIpLocation() {
  if (locationLabel()) {
    updateLocationStatus();
    return;
  }
  updateLocationStatus("定位中...");
  try {
    const response = await fetch("/api/amap/ip-location");
    const data = await response.json();
    if (response.ok && (data.city || data.province)) {
      saveLocationContext({
        source: "高德IP定位",
        province: data.province || "",
        city: data.city || data.province || "",
        district: "",
        adcode: data.adcode || "",
        address: data.city || data.province || "",
        location: "",
      });
    } else {
      updateLocationStatus("未定位");
    }
  } catch {
    updateLocationStatus("未定位");
  }
}

function requestBrowserLocation() {
  if (!navigator.geolocation) {
    updateLocationStatus("浏览器不支持定位");
    return;
  }
  updateLocationStatus("等待授权...");
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { longitude, latitude } = position.coords;
      const location = `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
      try {
        const response = await fetch(`/api/amap/reverse-geocode?location=${encodeURIComponent(location)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "逆地理编码失败");
        saveLocationContext({
          source: "浏览器定位+高德逆地理编码",
          province: data.province || "",
          city: data.city || data.province || "",
          district: data.district || "",
          adcode: data.adcode || "",
          address: data.address || "",
          location,
        });
      } catch {
        saveLocationContext({ source: "浏览器定位", location });
      }
    },
    () => updateLocationStatus(locationLabel() || "定位被拒绝"),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 10 * 60 * 1000 },
  );
}

function extractTipKeyword(text) {
  const beforeCursor = text.slice(0, inputEl.selectionStart || text.length);
  const token = beforeCursor.split(/[\s，。,.、；;！？!?：:\n]/).pop() || "";
  return token.replace(/^(从|到|去|前往|查|查询|附近|明天|今天|后天)/, "").trim();
}

const tipSeparatorPattern = /[\s,.;:!?，。；：！？、（）()【】[\]{}<>《》"'“”‘’\n\r\t]/;
const tipTriggerChars = "从到去往在";
const tipTriggerWords = ["出发地", "目的地", "起点", "终点", "附近", "前往", "出发", "查询", "搜索", "查", "搜"];
const tipIgnorePrefixPattern = /^(帮我|我想|我打算|想要|计划|明天|今天|后天|查|查询|搜索|看看|一下)$/;

function getTipQuery(text) {
  const cursor = inputEl.selectionStart ?? text.length;
  const beforeCursor = text.slice(0, cursor);
  let start = cursor;
  while (start > 0 && !tipSeparatorPattern.test(text[start - 1])) {
    start -= 1;
  }

  let triggerStart = -1;
  for (const char of tipTriggerChars) {
    const index = beforeCursor.lastIndexOf(char);
    if (index > triggerStart) triggerStart = index;
  }
  for (const word of tipTriggerWords) {
    const index = beforeCursor.lastIndexOf(word);
    if (index >= 0 && index + word.length > triggerStart) {
      triggerStart = index + word.length - 1;
    }
  }
  if (triggerStart >= start) {
    start = triggerStart + 1;
  }

  let raw = text.slice(start, cursor);
  const leadingSpaces = raw.match(/^\s*/)?.[0].length || 0;
  start += leadingSpaces;
  raw = raw.trimStart();

  let keyword = raw.trim();
  if (keyword.startsWith("一下")) {
    start += 2;
    keyword = keyword.slice(2).trim();
  }
  if (!keyword || tipIgnorePrefixPattern.test(keyword)) {
    return { keyword: "", start, end: cursor };
  }

  return { keyword, start, end: cursor };
}

function hideInputTips() {
  if (!inputTipsEl) return;
  inputTipsEl.hidden = true;
  inputTipsEl.innerHTML = "";
}

async function loadInputTips() {
  if (!inputTipsEl || activeController || (inputSuggestToggle && !inputSuggestToggle.checked)) {
    hideInputTips();
    return;
  }
  const keyword = getTipQuery(inputEl.value).keyword;
  if (keyword.length < 2 || keyword.length > 16) {
    hideInputTips();
    return;
  }
  try {
    const params = new URLSearchParams({ keywords: keyword });
    const city = locationLabel();
    if (city) params.set("city", city);
    const response = await fetch(`/api/amap/input-tips?${params.toString()}`);
    const data = await response.json();
    const tips = Array.isArray(data.tips) ? data.tips.filter((tip) => tip.name) : [];
    if (!tips.length) {
      hideInputTips();
      return;
    }
    inputTipsEl.innerHTML = tips.map((tip) => `
      <button type="button" class="input-tip" data-name="${escapeHtml(tip.name)}">
        <strong>${escapeHtml(tip.name)}</strong>
        <span>${escapeHtml(tip.district || tip.address || "")}</span>
      </button>
    `).join("");
    inputTipsEl.hidden = false;
  } catch {
    hideInputTips();
  }
}

function applyInputTip(name) {
  const { keyword, start, end } = getTipQuery(inputEl.value);
  const prefix = inputEl.value.slice(0, start);
  const suffix = inputEl.value.slice(end);
  inputEl.value = keyword ? `${prefix}${name}${suffix}` : `${inputEl.value}${name}`;
  const nextCursor = (keyword ? prefix.length : inputEl.value.length - name.length) + name.length;
  hideInputTips();
  inputEl.focus();
  inputEl.setSelectionRange(nextCursor, nextCursor);
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = inputEl.value.trim();
  if (!message) return;

  appendMessage("user", message);
  inputEl.value = "";
  const loadingEl = appendMessage("assistant", "请求已发送，等待模型响应 0s", "loading");
  const startedAt = Date.now();
  let latestStatus = "请求已发送，等待智能体响应";
  let liveTrace = [];
  let finalData = null;
  let eventCount = 0;
  let lastEventAt = Date.now();
  let activeModel = "";
  const streamStats = () => ({
    eventCount,
    model: activeModel,
    silentSeconds: Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000)),
  });
  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const mode = offlineToggle.checked ? "离线演示" : (thinkingToggle.checked ? "深度思考" : "普通模式");
    renderLoadingStatus(loadingEl, `${mode} · ${latestStatus}，已等待 ${elapsed}s`, liveTrace, streamStats());
  }, 1000);
  renderLoadingStatus(loadingEl, latestStatus, liveTrace, streamStats());
  setBusy(true);

  try {
    await requestChatStream(
      {
        message,
        conversation_id: currentConversationId,
        history: getConversationHistory(),
        offline_demo: offlineToggle.checked,
        thinking_mode: thinkingToggle.checked,
        client_context: currentLocationContext,
      },
      (data) => {
        eventCount += 1;
        lastEventAt = Date.now();
        if (data.conversation_id) {
          currentConversationId = data.conversation_id;
          localStorage.setItem(CURRENT_CONVERSATION_KEY, currentConversationId);
        }
        if (data.model) {
          activeModel = data.model;
        }

        if (data.event === "status") {
          latestStatus = data.message || latestStatus;
          renderLoadingStatus(loadingEl, latestStatus, liveTrace, streamStats());
        } else if (data.event === "trace") {
          liveTrace = Array.isArray(data.trace) ? data.trace : liveTrace;
          const item = data.item || {};
          if (data.phase === "tool_call" || item.type === "tool_call") {
            latestStatus = `正在${traceToolInfo(item.tool).title}`;
          } else if (data.phase === "tool_result" || item.type === "tool_result") {
            latestStatus = `${traceToolInfo(item.tool).title}已完成`;
          } else if (data.phase === "llm_response" || item.type === "llm_response") {
            latestStatus = `模型阶段完成：${item.model || "unknown"}`;
          } else if (data.message) {
            latestStatus = data.message;
          } else {
            latestStatus = "智能体继续整合信息";
          }
          renderLoadingStatus(loadingEl, latestStatus, liveTrace, streamStats());
        } else if (data.event === "done") {
          finalData = data;
        } else if (data.event === "error") {
          finalData = data;
        }
      },
    );
    clearInterval(timer);
    loadingEl.remove();

    if (finalData?.conversation_id) {
      currentConversationId = finalData.conversation_id;
      localStorage.setItem(CURRENT_CONVERSATION_KEY, currentConversationId);
    }
    const responseEl = appendMessage("assistant", finalData?.answer || finalData?.error || "没有返回内容。");
    if (finalData?.structured_data) {
      renderStructuredCardsInto(responseEl, finalData.structured_data, finalData.trace);
    }
    appendMeta(responseEl, finalData || {});
    await loadConversations();
  } catch (error) {
    clearInterval(timer);
    loadingEl.remove();
    if (error.name === "AbortError") {
      appendMessage("assistant", "已停止本次生成。");
      return;
    }
    appendMessage("assistant", `请求失败：${error.message}`);
  } finally {
    activeController = null;
    setBusy(false);
    inputEl.focus();
  }
});

if (locateBtn) {
  locateBtn.addEventListener("click", requestBrowserLocation);
}

if (inputSuggestToggle) {
  inputSuggestToggle.addEventListener("change", () => {
    localStorage.setItem(INPUT_SUGGEST_KEY, inputSuggestToggle.checked ? "true" : "false");
    if (!inputSuggestToggle.checked) {
      hideInputTips();
      return;
    }
    clearTimeout(inputTipTimer);
    inputTipTimer = setTimeout(loadInputTips, 120);
  });
}

inputEl.addEventListener("input", () => {
  clearTimeout(inputTipTimer);
  inputTipTimer = setTimeout(loadInputTips, 260);
});

inputEl.addEventListener("blur", () => {
  setTimeout(hideInputTips, 160);
});

if (inputTipsEl) {
  inputTipsEl.addEventListener("mousedown", (event) => {
    const button = event.target.closest(".input-tip");
    if (!button) return;
    event.preventDefault();
    applyInputTip(button.dataset.name || "");
  });
}

messagesEl.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".trace-panel")) markTraceInteraction();
});

messagesEl.addEventListener("wheel", (event) => {
  if (event.target.closest(".trace-panel")) markTraceInteraction();
}, { passive: true });

messagesEl.addEventListener("scroll", () => {
  if (messagesEl.querySelector(".message.loading .trace-panel:hover")) markTraceInteraction();
}, { passive: true });

messagesEl.addEventListener("mouseover", (event) => {
  const card = event.target.closest(".poi-card[data-map-label]");
  if (!card?.dataset.mapLabel) return;
  const category = card.closest("[data-poi-category]");
  if (!category) return;
  focusLiveMapPoint(category, card.dataset.mapLabel, { pan: false, openInfo: false });
});

messagesEl.addEventListener("mouseout", (event) => {
  const card = event.target.closest(".poi-card[data-map-label]");
  if (!card?.dataset.mapLabel) return;
  const category = card.closest("[data-poi-category]");
  if (!category || card.contains(event.relatedTarget)) return;
  category.querySelectorAll(".poi-card.map-highlight").forEach((item) => item.classList.remove("map-highlight"));
  highlightLiveMarker(category, "");
});

messagesEl.addEventListener("click", (event) => {
  const poiCard = event.target.closest(".poi-card[data-map-label]");
  if (poiCard?.dataset.mapLabel && !event.target.closest("a, button, select, input, textarea")) {
    const category = poiCard.closest("[data-poi-category]");
    if (category) {
      focusLiveMapPoint(category, poiCard.dataset.mapLabel, { pan: true, openInfo: true });
      return;
    }
  }

  const resetMapButton = event.target.closest(".poi-map-reset");
  if (resetMapButton) {
    const viewport = resetMapButton.closest("[data-draggable-map]");
    if (viewport) resetDraggableMap(viewport);
    return;
  }

  const retryMapButton = event.target.closest(".poi-map-retry");
  if (retryMapButton) {
    const viewport = retryMapButton.closest("[data-draggable-map]");
    const image = viewport?.querySelector(".poi-map-preview");
    const liveMap = viewport?.querySelector(".amap-live-map");
    if (liveMap) {
      const points = parseLiveMapPoints(liveMap);
      destroyLiveMap(liveMap);
      if (points.length) {
        ensureLiveMap(liveMap, { polyline: liveMap.dataset.polyline === "true" });
      }
    }
    if (image) {
      setMapLoadState(image, "loading");
      const cleanSrc = image.src.split("&_retry=")[0];
      image.src = `${cleanSrc}&_retry=${Date.now()}`;
    }
    return;
  }

  const filterButton = event.target.closest(".poi-filter-chip");
  if (filterButton) {
    filterButton.classList.toggle("active");
    const category = filterButton.closest("[data-poi-category]");
    if (category) applyPoiControls(category);
    return;
  }

  const filterReset = event.target.closest(".poi-filter-reset");
  if (filterReset) {
    const category = filterReset.closest("[data-poi-category]");
    if (!category) return;
    category.querySelectorAll(".poi-filter-chip.active").forEach((button) => button.classList.remove("active"));
    const sort = category.querySelector(".poi-sort");
    const type = category.querySelector(".poi-type-filter");
    if (sort) sort.value = "default";
    if (type) type.value = "all";
    applyPoiControls(category);
  }
});

messagesEl.addEventListener("change", (event) => {
  if (!event.target.matches(".poi-sort, .poi-type-filter")) return;
  const category = event.target.closest("[data-poi-category]");
  if (category) applyPoiControls(category);
});

clearBtn.addEventListener("click", () => {
  if (currentConversationId) {
    deleteConversation(currentConversationId);
  } else {
    renderWelcome();
  }
  inputEl.focus();
});

newChatBtn.addEventListener("click", async () => {
  currentConversationId = "";
  localStorage.removeItem(CURRENT_CONVERSATION_KEY);
  renderWelcome();
  await loadConversations();
  inputEl.focus();
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

// ====== Sidebar Tabs & Collapse ======

const appShell = document.querySelector("#appShell");
const sidebar = document.querySelector("#sidebar");
const tabButtons = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".sidebar-tab-content");
const collapseSidebarBtn = document.querySelector("#collapseSidebarBtn");
const expandSidebarBtn = document.querySelector("#expandSidebarBtn");

const ACTIVE_TAB_KEY = "travel_agent_sidebar_active_tab";
const SIDEBAR_COLLAPSED_KEY = "travel_agent_sidebar_collapsed";

function switchTab(tabId) {
  tabButtons.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  tabContents.forEach(content => {
    content.classList.toggle("active", content.id === `tab-${tabId}`);
  });
  
  // Switch main content area
  const chatPanel = document.querySelector(".chat-panel");
  const edgeCloudPanel = document.querySelector("#edgeCloudPanel");
  if (chatPanel && edgeCloudPanel) {
    if (tabId === "edge") {
      chatPanel.hidden = true;
      edgeCloudPanel.hidden = false;
      loadEdgeTasks();
    } else {
      chatPanel.hidden = false;
      edgeCloudPanel.hidden = true;
    }
  }
  
  localStorage.setItem(ACTIVE_TAB_KEY, tabId);
}

// Bind tabs click
tabButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab);
  });
});

// ====== Mode Switcher and Tab Filtering ======
const modeSwitchBtns = document.querySelectorAll(".mode-switch-btn");

function switchMode(mode) {
  modeSwitchBtns.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  const tabBtns = document.querySelectorAll(".tab-btn");
  if (mode === "travel") {
    // Show travel tabs, hide edge tabs
    tabBtns.forEach(btn => {
      const isTravelTab = btn.dataset.tab === "history" || btn.dataset.tab === "skills";
      btn.style.display = isTravelTab ? "flex" : "none";
    });
    // Fallback if current active tab is not travel
    const activeTab = localStorage.getItem(ACTIVE_TAB_KEY) || "history";
    if (activeTab !== "history" && activeTab !== "skills") {
      switchTab("history");
    } else {
      switchTab(activeTab);
    }
  } else if (mode === "edge") {
    // Show edge tabs, hide travel tabs
    tabBtns.forEach(btn => {
      const isEdgeTab = btn.dataset.tab === "edge" || btn.dataset.tab === "status";
      btn.style.display = isEdgeTab ? "flex" : "none";
    });
    // Fallback if current active tab is not edge
    const activeTab = localStorage.getItem(ACTIVE_TAB_KEY) || "edge";
    if (activeTab !== "edge" && activeTab !== "status") {
      switchTab("edge");
    } else {
      switchTab(activeTab);
    }
  }
  localStorage.setItem("active_mode", mode);
}

modeSwitchBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    switchMode(btn.dataset.mode);
  });
});

// Restore active tab & mode
const savedMode = localStorage.getItem("active_mode") || "travel";
switchMode(savedMode);

function setSidebarCollapsed(collapsed) {
  if (collapsed) {
    appShell.classList.add("sidebar-collapsed");
    if (expandSidebarBtn) expandSidebarBtn.style.display = "inline-flex";
  } else {
    appShell.classList.remove("sidebar-collapsed");
    if (expandSidebarBtn) expandSidebarBtn.style.display = "none";
  }
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
}

if (collapseSidebarBtn) {
  collapseSidebarBtn.addEventListener("click", () => {
    setSidebarCollapsed(true);
  });
}

if (expandSidebarBtn) {
  expandSidebarBtn.addEventListener("click", () => {
    setSidebarCollapsed(false);
  });
}

const expandSidebarBtnEdge = document.querySelector("#expandSidebarBtnEdge");
if (expandSidebarBtnEdge) {
  expandSidebarBtnEdge.addEventListener("click", () => {
    setSidebarCollapsed(false);
  });
}

// Restore sidebar state
const savedSidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
setSidebarCollapsed(savedSidebarCollapsed);

renderWelcome();
updateLocationStatus();
loadStatus();
loadEdgeTasks();
loadSkills();
detectIpLocation();
loadConversations().then(() => {
  if (currentConversationId) {
    loadConversation(currentConversationId).catch(() => {
      currentConversationId = "";
      localStorage.removeItem(CURRENT_CONVERSATION_KEY);
      renderWelcome();
    });
  }
});

if (refreshEdgeTasksBtn) {
  refreshEdgeTasksBtn.addEventListener("click", loadEdgeTasks);
}

const refreshEdgeDashboardBtn = document.querySelector("#refreshEdgeDashboardBtn");
if (refreshEdgeDashboardBtn) {
  refreshEdgeDashboardBtn.addEventListener("click", loadEdgeTasks);
}
if (manualHeartbeatBtn) {
  manualHeartbeatBtn.addEventListener("click", () => sendManualHeartbeat(manualHeartbeatBtn));
}


setInterval(loadEdgeTasks, 10000);

// ====== Structured Card Rendering ======

function mergeHotelPhotosFromTrace(data, trace = []) {
  if (!data?.hotel_options?.length || !Array.isArray(trace)) return data;
  const hotelToolText = trace
    .filter((item) => item?.tool === "search_hotel_prices")
    .map((item) => String(item.result || ""))
    .join("\n");
  if (!hotelToolText) return data;
  data.hotel_options.forEach((hotel) => {
    const name = String(hotel.name || "").trim();
    if (!name) return;
    const line = hotelToolText.split(/\r?\n/).find((item) => item.includes(name) && /https?:\/\/cf\.bstatic\.com/.test(item));
    const photo = line?.match(/https?:\/\/cf\.bstatic\.com[^\s"'<>]+/)?.[0]?.replace(/[，,。；;]+$/, "");
    if (photo) hotel.photo_url = photo;
  });
  return data;
}

function renderStructuredCardsInto(article, data, trace = []) {
  const bubble = article.querySelector(".bubble");
  if (!bubble || !data) return;
  mergeHotelPhotosFromTrace(data, trace);
  removeDuplicateItineraryFromBubble(bubble, data);
  const html = buildStructuredCards(data);
  if (!html) return;
  const container = document.createElement("div");
  container.className = "structured-container";
  container.innerHTML = html;
  bubble.appendChild(container);
  initDraggableMaps(container);
  initLiveMaps(container);
  loadHotelImagesBatched(container);
}

function buildStructuredCards(data) {
  if (!data || typeof data !== "object") return "";
  let html = "";
  if (data.summary) {
    html += `<div class="card-section summary-card"><div class="summary-text">${escapeHtml(data.summary)}</div></div>`;
  }
  if (data.weather && data.weather.length) {
    html += renderWeatherCards(data.weather);
  }
  if (data.weather_alerts && data.weather_alerts.length) {
    html += renderWeatherAlertCards(data.weather_alerts);
  }
  if (data.weather_indices && data.weather_indices.length) {
    html += renderWeatherIndexCards(data.weather_indices);
  }
  if (data.daily_itinerary && data.daily_itinerary.length) {
    html += renderItineraryTimeline(data.daily_itinerary, data.poi_recommendations || [], data.hotel_options || []);
  }
  if (data.transport_options && data.transport_options.length) {
    html += renderTransportCards(data.transport_options);
  }
  if (data.hotel_options && data.hotel_options.length) {
    html += renderHotelCards(data.hotel_options);
  }
  if (data.budget && typeof data.budget.total === "number" && (data.budget.total > 0 || data.budget.notes || Object.keys(data.budget.breakdown || {}).length)) {
    html += renderBudgetCard(data.budget);
  }
  if (data.tips && data.tips.length) {
    html += renderTipsList(data.tips);
  }
  if (data.poi_recommendations && data.poi_recommendations.length) {
    html += renderPoiCards(data.poi_recommendations);
  }
  html += renderDataCredibility(data);
  return html;
}

function renderWeatherCards(weatherList) {
  const cards = weatherList.map(w => `
    <div class="weather-card">
      <div class="weather-card-header">
        <span class="weather-card-city">${escapeHtml(w.city || "")}</span>
        <span class="weather-card-date">${escapeHtml(w.date || "")}</span>
      </div>
      <div class="weather-card-body">
        <span class="weather-card-temp">${escapeHtml(w.temperature || "--")}</span>
        <span class="weather-card-condition">${escapeHtml(w.condition || "")}</span>
      </div>
      <div class="weather-card-details">
        <span>湿度 ${escapeHtml(w.humidity || "--")}</span>
        <span>风速 ${escapeHtml(w.wind || "--")}</span>
      </div>
    </div>
  `).join("");
  return `<div class="card-section"><h3 class="card-section-title">天气信息</h3><div class="weather-card-grid">${cards}</div></div>`;
}

function weatherAlertClass(alert) {
  const text = `${alert.severity || ""} ${alert.level || ""} ${alert.title || ""} ${alert.status || ""}`.toLowerCase();
  if (text.includes("red") || text.includes("红") || text.includes("严重")) return "danger";
  if (text.includes("orange") || text.includes("橙") || text.includes("较重")) return "orange";
  if (text.includes("yellow") || text.includes("黄") || text.includes("一般")) return "yellow";
  if (text.includes("blue") || text.includes("蓝")) return "blue";
  if (text.includes("no_active") || text.includes("无预警")) return "clear";
  if (text.includes("unavailable") || text.includes("不可用")) return "muted";
  return "default";
}

function renderWeatherAlertCards(alerts) {
  const cards = alerts.map(alert => {
    const kind = weatherAlertClass(alert);
    const title = alert.title || (alert.status === "no_active" ? "当前无天气灾害预警" : "天气预警");
    return `
      <div class="weather-alert-card alert-${kind}">
        <div class="weather-alert-head">
          <span class="weather-alert-badge">${escapeHtml(alert.severity || alert.level || alert.type || "预警")}</span>
          <span class="weather-alert-city">${escapeHtml(alert.city || "")}</span>
        </div>
        <h4>${escapeHtml(title)}</h4>
        <div class="weather-alert-meta">
          ${alert.type ? `<span>${escapeHtml(alert.type)}</span>` : ""}
          ${alert.pub_time ? `<span>${escapeHtml(alert.pub_time)}</span>` : ""}
          ${alert.data_source ? `<span>${escapeHtml(alert.data_source)}</span>` : ""}
        </div>
        ${alert.text ? `<p>${escapeHtml(alert.text)}</p>` : ""}
      </div>
    `;
  }).join("");
  return `<div class="card-section"><h3 class="card-section-title">天气预警</h3><div class="weather-alert-grid">${cards}</div></div>`;
}

function weatherIndexClass(item) {
  const text = `${item.name || ""} ${item.category || ""} ${item.level || ""} ${item.text || ""}`;
  if (/不适宜|较不宜|强|很强|较差|易发|高风险|严重/.test(text)) return "orange";
  if (/适宜|舒适|良好|弱|不需要|较少/.test(text)) return "clear";
  return "default";
}

function renderWeatherIndexCards(indices) {
  const cards = indices.map(item => {
    const kind = weatherIndexClass(item);
    return `
      <div class="weather-alert-card weather-index-card alert-${kind}">
        <div class="weather-alert-head">
          <span class="weather-alert-badge">${escapeHtml(item.category || item.level || "指数")}</span>
          <span class="weather-alert-city">${escapeHtml(item.city || "")}</span>
        </div>
        <h4>${escapeHtml(item.name || "天气指数")}</h4>
        <div class="weather-alert-meta">
          ${item.date ? `<span>${escapeHtml(item.date)}</span>` : ""}
          ${item.level ? `<span>等级 ${escapeHtml(item.level)}</span>` : ""}
          ${item.data_source ? `<span>${escapeHtml(item.data_source)}</span>` : ""}
        </div>
        ${item.text ? `<p>${escapeHtml(item.text)}</p>` : ""}
      </div>
    `;
  }).join("");
  return `<div class="card-section"><h3 class="card-section-title">天气指数</h3><div class="weather-alert-grid weather-index-grid">${cards}</div></div>`;
}

function renderItineraryTimeline(itinerary, poiCategories = [], hotels = []) {
  const poiItems = itineraryMapItems(poiCategories, hotels);
  const items = itinerary.map((d, index) => `
    <div class="timeline-item">
      <div class="timeline-marker">D${escapeHtml(String(d.day))}</div>
      <div class="timeline-content">
        <h4 class="timeline-title">${escapeHtml(d.title || "")}</h4>
        ${d.activities && d.activities.length ? `<p class="timeline-activities"><strong>活动</strong> ${d.activities.map(a => escapeHtml(a)).join(" → ")}</p>` : ""}
        ${d.meals && d.meals.length ? `<p class="timeline-meals"><strong>餐饮</strong> ${d.meals.map(m => escapeHtml(m)).join("、")}</p>` : ""}
        ${d.accommodation ? `<p class="timeline-accommodation"><strong>住宿</strong> ${escapeHtml(d.accommodation)}</p>` : ""}
        ${renderMiniMap(matchItineraryPois(d, poiItems), `Day ${escapeHtml(String(d.day))} 地点关系`)}
      </div>
    </div>
  `).join("");
  return `<div class="card-section"><h3 class="card-section-title">每日行程</h3><div class="timeline">${items}</div></div>`;
}

function transportCategory(option) {
  const raw = `${option.category || ""} ${option.mode || ""} ${option.notes || ""}`.toLowerCase();
  const text = `${option.category || ""} ${option.mode || ""} ${option.notes || ""}`;
  if (raw.includes("driving") || text.includes("驾车") || text.includes("自驾")) return "driving";
  if (raw.includes("interline") || text.includes("中转") || (Array.isArray(option.legs) && option.legs.length > 1)) return "interline";
  if (raw.includes("flight") || text.includes("航班") || /^[A-Z]{2}\s?\d+/.test(option.mode || "")) return "flight";
  if (raw.includes("train") || text.includes("高铁") || text.includes("动车") || /^[GDCZTK]\d+/.test(option.mode || "")) return "train";
  if (raw.includes("transit") || text.includes("地铁") || text.includes("公交")) return "transit";
  if (raw.includes("walking") || text.includes("步行")) return "walking";
  if (raw.includes("bicycling") || text.includes("骑行")) return "bicycling";
  if (raw.includes("traffic") || text.includes("路况") || text.includes("拥堵")) return "traffic";
  return "generic";
}

function transportIcon(category) {
  return {
    flight: "航",
    train: "铁",
    interline: "转",
    transit: "乘",
    walking: "步",
    bicycling: "骑",
    traffic: "堵",
    driving: "驾",
    generic: "行",
  }[category] || "行";
}

function transportLabel(category) {
  return {
    flight: "航班",
    train: "火车",
    interline: "中转火车",
    transit: "公交地铁",
    walking: "步行",
    bicycling: "骑行",
    traffic: "实时路况",
    driving: "驾车",
    generic: "交通",
  }[category] || "交通";
}

function isUsefulTransportValue(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (["--", "-", "未知", "可用", "available", "null", "undefined"].includes(text.toLowerCase())) return false;
  return true;
}

function cleanTransportNote(note) {
  const text = String(note || "").trim();
  if (!text) return "";
  if (/Aviationstack/i.test(text) && /不提供票价|票价/.test(text)) {
    return "航班票价需以航司或购票平台为准";
  }
  if (/不支持按指定日期查询/.test(text)) {
    return "当前航班数据仅作近期班次参考";
  }
  return text;
}

function transportMetaChips(option) {
  const chips = [];
  if (isUsefulTransportValue(option.status) && !["success", "ok"].includes(String(option.status).toLowerCase())) {
    chips.push(option.status);
  }
  if (isUsefulTransportValue(option.departure_time) || isUsefulTransportValue(option.arrival_time)) {
    chips.push(`${isUsefulTransportValue(option.departure_time) ? option.departure_time : "--"} → ${isUsefulTransportValue(option.arrival_time) ? option.arrival_time : "--"}`);
  }
  return chips.map(chip => `<span>${escapeHtml(String(chip))}</span>`).join("");
}

function renderTransportLegs(legs) {
  if (!Array.isArray(legs) || !legs.length) return "";
  const items = legs.map((leg, index) => `
    <div class="transport-leg">
      <div class="transport-leg-index">${index + 1}</div>
      <div class="transport-leg-body">
        <div class="transport-leg-title">
          <strong>${escapeHtml(leg.mode || `第 ${index + 1} 段`)}</strong>
          ${leg.status ? `<span>${escapeHtml(leg.status)}</span>` : ""}
        </div>
        <div class="transport-leg-route">${escapeHtml(leg.from || "")} → ${escapeHtml(leg.to || "")}</div>
        <div class="transport-leg-meta">
          ${leg.departure_time || leg.arrival_time ? `<span>${escapeHtml(leg.departure_time || "--")} → ${escapeHtml(leg.arrival_time || "--")}</span>` : ""}
          ${leg.duration ? `<span>${escapeHtml(leg.duration)}</span>` : ""}
          ${leg.cost_estimate ? `<span>${escapeHtml(leg.cost_estimate)}</span>` : ""}
        </div>
        ${leg.notes ? `<div class="transport-leg-notes">${escapeHtml(leg.notes)}</div>` : ""}
      </div>
    </div>
  `).join("");
  return `<div class="transport-legs">${items}</div>`;
}

function renderTransportCards(transportList) {
  const cards = transportList.map(t => {
    const category = transportCategory(t);
    const note = cleanTransportNote(t.notes);
    return `
    <div class="transport-card transport-${category}">
      <div class="transport-card-head">
        <span class="transport-icon">${transportIcon(category)}</span>
        <div>
          <span class="transport-mode-badge">${escapeHtml(t.mode || transportLabel(category))}</span>
          <div class="transport-type-label">${transportLabel(category)}</div>
        </div>
      </div>
      <div class="transport-route">${escapeHtml(t.from || "")} → ${escapeHtml(t.to || "")}</div>
      ${transportMetaChips(t) ? `<div class="transport-meta-chips">${transportMetaChips(t)}</div>` : ""}
      <div class="transport-details">
        <div class="transport-detail"><span>时长</span><span>${escapeHtml(isUsefulTransportValue(t.duration) ? t.duration : "--")}</span></div>
        <div class="transport-detail"><span>费用/票价</span><span>${escapeHtml(isUsefulTransportValue(t.cost_estimate) ? t.cost_estimate : "--")}</span></div>
      </div>
      ${renderTransportLegs(t.legs)}
      ${note ? `<div class="transport-notes">${escapeHtml(note)}</div>` : ""}
    </div>
  `}).join("");
  return `<div class="card-section"><h3 class="card-section-title">交通方案</h3><div class="transport-grid">${cards}</div></div>`;
}

function renderBudgetCard(budget) {
  let rows = "";
  if (budget.breakdown && typeof budget.breakdown === "object") {
    rows = Object.entries(budget.breakdown).map(([key, val]) => `
      <div class="budget-row">
        <span class="budget-label">${escapeHtml(key)}</span>
        <span class="budget-value">${escapeHtml(String(val))} 元</span>
      </div>
    `).join("");
  }
  return `
    <div class="card-section"><h3 class="card-section-title">预算明细</h3>
      <div class="budget-card">
        ${rows}
        <div class="budget-row budget-total">
          <span class="budget-label">总计</span>
          <span class="budget-value">${escapeHtml(String(budget.total))} ${escapeHtml(budget.currency || "元")}</span>
        </div>
        ${budget.notes ? `<p class="budget-notes">${escapeHtml(budget.notes)}</p>` : ""}
      </div>
    </div>`;
}

function renderHotelCards(hotels) {
  const cards = hotels.map((hotel) => {
    const photo = proxiedImageUrl(hotel.photo_url || hotel.photo || "");
    let price = String(hotel.price_total || hotel.price || hotel.cost || "价格待确认");
    if (hotel.currency && /^\d+(?:\.\d+)?$/.test(price.trim())) {
      price = `${hotel.currency} ${price}`;
    }
    const meta = [
      hotel.rating ? `评分 ${hotel.rating}` : "",
      hotel.review_count ? `${hotel.review_count} 条评论` : "",
      hotel.stars ? `${hotel.stars} 星` : "",
      hotel.currency && !String(price).includes(hotel.currency) ? hotel.currency : "",
    ].filter(Boolean);
    const times = [
      hotel.checkin ? `入住 ${hotel.checkin}` : "",
      hotel.checkout ? `离店 ${hotel.checkout}` : "",
    ].filter(Boolean);
    return `
      <div class="hotel-card">
        ${photo ? `<img class="hotel-photo" data-src="${escapeHtml(photo)}" alt="${escapeHtml(hotel.name || "酒店照片")}" referrerpolicy="no-referrer" onerror="retryOrReplaceHotelPhoto(this)"><div class="hotel-photo-skeleton"></div>` : `<div class="hotel-photo hotel-photo-empty">酒店</div>`}
        <div class="hotel-body">
          <div class="hotel-head">
            <h4>${escapeHtml(hotel.name || "酒店")}</h4>
            <strong>${escapeHtml(String(price))}</strong>
          </div>
          ${hotel.area ? `<p class="hotel-area">${escapeHtml(hotel.area)}</p>` : ""}
          ${meta.length ? `<div class="hotel-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
          ${times.length ? `<div class="hotel-times">${times.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
          ${hotel.notes ? `<p class="hotel-notes">${escapeHtml(hotel.notes)}</p>` : ""}
        </div>
      </div>
    `;
  }).join("");
  return `<div class="card-section"><h3 class="card-section-title">酒店价格参考</h3><div class="hotel-grid">${cards}</div></div>`;
}

function renderTipsList(tips) {
  const items = tips.map((t, i) => `
    <li class="tips-item">
      <span class="tips-num">${i + 1}</span>
      <span>${escapeHtml(t)}</span>
    </li>
  `).join("");
  return `<div class="card-section"><h3 class="card-section-title">出行提示</h3><ul class="tips-list">${items}</ul></div>`;
}

function renderDataCredibility(data) {
  const sources = new Map();
  const limits = [];

  (data.weather || []).forEach((item) => {
    sources.set(item.data_source || "和风天气/高德天气", "天气信息");
  });
  (data.weather_alerts || []).forEach((item) => {
    if (item.data_source) sources.set(item.data_source, "天气预警");
    if (item.status === "unavailable") limits.push("天气预警或空气质量可能受接口权限影响。");
  });
  (data.weather_indices || []).forEach((item) => {
    if (item.data_source) sources.set(item.data_source, "天气指数");
  });
  (data.transport_options || []).forEach((item) => {
    if (item.data_source) sources.set(item.data_source, "交通方案");
    if (/Aviationstack/i.test(`${item.data_source || ""} ${item.notes || ""}`)) {
      limits.push("航班信息来自 Aviationstack，仅作时刻/状态参考，不包含真实票价。");
    }
    if (/12306/.test(`${item.data_source || ""} ${item.notes || ""}`)) {
      sources.set("12306", "火车票/中转查询");
    }
    if (/高德|amap/i.test(`${item.data_source || ""} ${item.notes || ""}`)) {
      sources.set("高德地图", "路线与地点");
    }
  });
  (data.poi_recommendations || []).forEach((category) => {
    if ((category.items || []).length) sources.set("高德地图", "POI 地点推荐");
  });
  if ((data.hotel_options || []).length) {
    const hotelSourceText = (data.hotel_options || []).map((item) => `${item.data_source || ""} ${item.notes || ""}`).join(" ");
    if (/高德地图|POI|无实时房价|实时价格不可用/.test(hotelSourceText)) {
      sources.set("高德地图酒店 POI", "酒店位置参考");
      limits.push("酒店卡片为高德地图 POI 兜底结果时，不包含实时房价、库存或可订状态。");
    }
    if (/Booking\.com|RapidAPI/i.test(hotelSourceText) || !/高德地图|POI/.test(hotelSourceText)) {
      sources.set("Booking.com/RapidAPI", "酒店价格");
      limits.push("酒店价格为实时接口参考值，库存、税费和最终支付价以 Booking.com 确认页为准。");
    }
  }
  if (data.budget && typeof data.budget.total === "number") {
    sources.set("本地预算计算", "预算估算");
    if (data.budget.notes) limits.push("预算为估算值，真实价格以购票、酒店和商家平台为准。");
  }

  const sourceItems = [...sources.entries()].map(([source, usage]) => `
    <span><strong>${escapeHtml(source)}</strong>${escapeHtml(usage)}</span>
  `).join("");
  const uniqueLimits = [...new Set(limits)].slice(0, 4);
  if (!sourceItems && !uniqueLimits.length) return "";

  return `
    <div class="card-section credibility-card">
      <h3 class="card-section-title">数据可信度</h3>
      ${sourceItems ? `<div class="credibility-sources">${sourceItems}</div>` : ""}
      ${uniqueLimits.length ? `<ul class="credibility-notes">${uniqueLimits.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}
    </div>
  `;
}

function renderPoiCards(categories) {
  if (!categories || !categories.length) return "";
  const sections = categories.map((cat, catIndex) => {
    const rawItems = Array.isArray(cat.items) ? cat.items : [];
    const mapItems = rawItems.filter((item) => item.location).slice(0, POI_MARKER_LABELS.length);
    const locations = mapItems.map((item) => item.location);
    const mapUrl = buildMapImageUrl(locations);
    const mapPoints = buildMapPoints(mapItems);
    const categoryId = `poi-category-${catIndex}`;
    const typeOptions = [...new Set(rawItems.map(normalizedPoiType))]
      .filter(Boolean)
      .slice(0, 10);
    const controls = rawItems.length ? `
      <div class="poi-controls" data-poi-controls="${categoryId}">
        <label>
          <span>排序</span>
          <select class="poi-sort">
            <option value="default">默认</option>
            <option value="rating">评分优先</option>
            <option value="cost">人均低优先</option>
            <option value="name">名称</option>
          </select>
        </label>
        <label>
          <span>类型</span>
          <select class="poi-type-filter">
            <option value="all">全部</option>
            ${typeOptions.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="poi-filter-chip" data-filter="high-rating">高评分</button>
        <button type="button" class="poi-filter-chip" data-filter="low-cost">低人均</button>
        <button type="button" class="poi-filter-chip" data-filter="tel">可联系</button>
        <button type="button" class="poi-filter-reset">重置</button>
      </div>
    ` : "";
    const mapLegend = mapItems.length ? `
      <div class="poi-map-legend">
        ${mapItems.map((item, index) => `
          <span><b>${markerLabel(index)}</b>${escapeHtml(item.name || `地点${index + 1}`)}</span>
        `).join("")}
      </div>
    ` : "";
    const items = rawItems.map((item, index) => `
      <div class="poi-card"
        data-poi-card
        data-original-index="${index}"
        data-rating="${parsePoiRating(item)}"
        data-cost="${parsePoiCost(item)}"
        data-type="${escapeHtml(normalizedPoiType(item))}"
        data-name="${escapeHtml(item.name || "")}"
        data-address="${escapeHtml(item.address || "")}"
        data-location="${escapeHtml(item.location || "")}"
        data-map-label="${index < POI_MARKER_LABELS.length && item.location ? markerLabel(index) : ""}"
        data-has-tel="${item.tel ? "true" : "false"}">
        ${index < POI_MARKER_LABELS.length && item.location ? `<span class="poi-card-index">${markerLabel(index)}</span>` : ""}
        <span class="poi-card-type">${escapeHtml(item.type || "")}</span>
        <h4 class="poi-card-name">${escapeHtml(item.name || "")}</h4>
        ${item.address ? `<p class="poi-card-address">${escapeHtml(item.address)}</p>` : ""}
        ${renderPoiMeta(item)}
      </div>
    `).join("");
    return `
      <div class="poi-category" data-poi-category="${categoryId}">
        <h4 class="poi-category-title">${escapeHtml(cat.category || "POI推荐")}</h4>
        ${mapUrl ? `
          <div class="poi-map-viewport" data-draggable-map>
            <div class="poi-map-toolbar">
              <span>拖动查看周边位置关系</span>
              <button type="button" class="poi-map-retry">重试</button>
              <button type="button" class="poi-map-reset">重置视角</button>
              <a class="poi-map-open-link" href="${escapeHtml(mapUrl)}" target="_blank" rel="noreferrer">打开图像</a>
            </div>
            <div class="amap-live-map" data-live-map data-points="${htmlAttrJson(mapPoints)}"></div>
            <img class="poi-map-preview" src="${escapeHtml(mapUrl)}" alt="${escapeHtml(cat.category || "地点")}地图预览" loading="lazy" referrerpolicy="no-referrer" draggable="false" onload="setMapLoadState(this, 'loaded')" onerror="setMapLoadState(this, 'error')">
            <div class="poi-map-fallback">地图暂时加载失败，可点击重试或打开图像查看。</div>
          </div>
        ` : ""}
        ${mapLegend}
        ${controls}
        <div class="poi-card-grid">${items}</div>
      </div>
    `;
  }).join("");
  return `<div class="card-section"><h3 class="card-section-title">地点推荐</h3><div class="poi-categories">${sections}</div></div>`;
}

function renderPoiMeta(item) {
  const chips = [];
  if (item.rating) chips.push(`评分 ${item.rating}`);
  if (item.cost) chips.push(`人均 ${item.cost}`);
  if (item.tel) chips.push(item.tel);
  if (item.location) chips.push(item.location);
  if (!chips.length && !item.photo_url && !item.map_url) return "";
  return `
    <div class="poi-card-meta">
      ${chips.map(chip => `<span>${escapeHtml(String(chip))}</span>`).join("")}
      ${item.map_url ? `<a href="${escapeHtml(item.map_url)}" target="_blank" rel="noreferrer">地图</a>` : ""}
      ${item.photo_url ? `<a href="${escapeHtml(item.photo_url)}" target="_blank" rel="noreferrer">图片</a>` : ""}
    </div>
  `;
}

function applyPoiControls(category) {
  const controls = category.querySelector(".poi-controls");
  const grid = category.querySelector(".poi-card-grid");
  if (!controls || !grid) return;

  const sortValue = controls.querySelector(".poi-sort")?.value || "default";
  const typeValue = controls.querySelector(".poi-type-filter")?.value || "all";
  const activeFilters = [...controls.querySelectorAll(".poi-filter-chip.active")]
    .map((button) => button.dataset.filter);
  const cards = [...grid.querySelectorAll("[data-poi-card]")];

  cards.forEach((card) => {
    const rating = Number(card.dataset.rating || 0);
    const cost = Number(card.dataset.cost || 999999);
    const type = card.dataset.type || "";
    const hasTel = card.dataset.hasTel === "true";
    let visible = true;
    if (typeValue !== "all" && type !== typeValue) visible = false;
    if (activeFilters.includes("high-rating") && rating < 4.6) visible = false;
    if (activeFilters.includes("low-cost") && cost > 120) visible = false;
    if (activeFilters.includes("tel") && !hasTel) visible = false;
    card.hidden = !visible;
  });

  const sortedCards = [...cards].sort((a, b) => {
    if (sortValue === "rating") return Number(b.dataset.rating || 0) - Number(a.dataset.rating || 0);
    if (sortValue === "cost") return Number(a.dataset.cost || 999999) - Number(b.dataset.cost || 999999);
    if (sortValue === "name") return (a.dataset.name || "").localeCompare(b.dataset.name || "", "zh-Hans-CN");
    return Number(a.dataset.originalIndex || 0) - Number(b.dataset.originalIndex || 0);
  });
  sortedCards.forEach((card) => grid.appendChild(card));

  const visibleCards = sortedCards.filter((card) => !card.hidden);
  visibleCards.forEach((card, index) => {
    let badge = card.querySelector(".poi-card-index");
    if (card.dataset.location && !badge && index < POI_MARKER_LABELS.length) {
      badge = document.createElement("span");
      badge.className = "poi-card-index";
      card.prepend(badge);
    }
    if (badge) {
      if (index < POI_MARKER_LABELS.length && card.dataset.location) {
        const label = markerLabel(index);
        card.dataset.mapLabel = label;
        badge.textContent = label;
        badge.hidden = false;
      } else {
        card.dataset.mapLabel = "";
        badge.hidden = true;
      }
    }
  });

  cards.filter((card) => card.hidden).forEach((card) => {
    card.dataset.mapLabel = "";
    card.classList.remove("map-highlight");
    const badge = card.querySelector(".poi-card-index");
    if (badge) badge.hidden = true;
  });

  const mappedCards = visibleCards
    .filter((card) => card.dataset.location)
    .slice(0, POI_MARKER_LABELS.length);
  const locations = mappedCards.map((card) => card.dataset.location);
  const mapUrl = buildMapImageUrl(locations);
  const viewport = category.querySelector(".poi-map-viewport");
  const image = category.querySelector(".poi-map-preview");
  const mapLink = category.querySelector(".poi-map-open-link");
  const legend = category.querySelector(".poi-map-legend");
  if (viewport) {
    viewport.hidden = !mapUrl;
    resetDraggableMap(viewport);
  }
  if (image && mapUrl) {
    image.src = mapUrl;
    image.addEventListener("load", () => {
      if (viewport) clampMapOffset(viewport);
    }, { once: true });
  }
  if (mapLink && mapUrl) {
    mapLink.href = mapUrl;
  }
  if (legend) {
    legend.innerHTML = mappedCards.map((card, index) => `
      <span><b>${markerLabel(index)}</b>${escapeHtml(card.dataset.name || `地点${index + 1}`)}</span>
    `).join("");
    legend.hidden = !mappedCards.length;
  }

  const liveMap = category.querySelector(".amap-live-map");
  if (liveMap) {
    const points = mappedCards.map((card, index) => {
      const point = parseLngLat(card.dataset.location);
      if (!point) return null;
      return {
        label: markerLabel(index),
        name: card.dataset.name || `地点${index + 1}`,
        type: card.dataset.type || "",
        address: card.dataset.address || "",
        location: card.dataset.location,
        lng: point.lng,
        lat: point.lat,
      };
    }).filter(Boolean);
    liveMap.dataset.points = JSON.stringify(points);
    destroyLiveMap(liveMap);
    if (points.length) {
      liveMap.dataset.mapReady = "true";
      renderLiveMap(liveMap, points);
    }
  }

  let empty = category.querySelector(".poi-empty");
  if (!visibleCards.length) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "poi-empty";
      empty.textContent = "当前筛选下没有匹配地点";
      grid.after(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}
