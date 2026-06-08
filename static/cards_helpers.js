// Structured card rendering & init — extracted from travel_helpers.js
window.initTravelHelpers = function() {
  const messagesEl = document.querySelector("#messages");
  if (!messagesEl) return;
  
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
    }
  });
};


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



window.renderStructuredCardsInto = renderStructuredCardsInto;
window.locationLabel = locationLabel;
window.loadLocationContext = loadLocationContext;
window.saveLocationContext = saveLocationContext;
window.runLiveMapQueue = runLiveMapQueue;
window.initLiveMaps = initLiveMaps;
window.initDraggableMaps = initDraggableMaps;
