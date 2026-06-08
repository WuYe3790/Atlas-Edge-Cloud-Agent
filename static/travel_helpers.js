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

function markTraceInteraction() {
  traceInteractionUntil = Date.now() + 700;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
