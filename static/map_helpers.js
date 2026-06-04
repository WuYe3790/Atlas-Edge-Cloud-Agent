// AMap Maps & Coordinates Helper Module

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

const POI_MARKER_LABELS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function markerLabel(index) {
  return POI_MARKER_LABELS[index] || String(index + 1);
}

export function parseLngLat(location) {
  const [lng, lat] = String(location || "").split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

export function mapViewport(locations) {
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

export function buildMapImageUrl(locations, options = {}) {
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

export function htmlAttrJson(value) {
  return JSON.stringify(value || [])
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

export function buildMapPoints(items) {
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

let amapLoaderPromise = null;

export async function loadAmapApi() {
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

export function markerContent(point, active = false) {
  return `<div class="amap-marker-badge${active ? " active" : ""}">${escapeHtml(point.label)}</div>`;
}

export function mapInfoContent(point) {
  return `
    <div class="amap-info-window">
      <strong>${escapeHtml(point.label)}. ${escapeHtml(point.name)}</strong>
      ${point.type ? `<span>${escapeHtml(point.type)}</span>` : ""}
      ${point.address ? `<p>${escapeHtml(point.address)}</p>` : ""}
    </div>
  `;
}

export function highlightPoiCard(scope, label) {
  scope.querySelectorAll("[data-map-label]").forEach((card) => {
    card.classList.toggle("map-highlight", card.dataset.mapLabel === label);
  });
}

export function highlightLiveMarker(scope, label) {
  const liveMap = scope.querySelector(".amap-live-map");
  if (!liveMap?._amapMarkers?.length) return;
  liveMap._amapMarkers.forEach((marker) => {
    const point = marker.getExtData();
    marker.setContent(markerContent(point, point?.label === label));
  });
}

export function focusLiveMapPoint(scope, label, options = {}) {
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

export function liveMapScope(container) {
  return container.closest("[data-poi-category]") || container.closest(".timeline-content") || document;
}

export function parseLiveMapPoints(container) {
  try {
    return JSON.parse(container.dataset.points || "[]");
  } catch {
    return [];
  }
}

export function markLiveMapUnavailable(container) {
  container.classList.remove("amap-ready");
  container.classList.add("amap-unavailable");
  const viewport = container.closest(".poi-map-viewport");
  const image = viewport?.querySelector(".poi-map-preview");
  if (!image || !image.complete || image.naturalWidth === 0) {
    viewport?.classList.add("map-error");
  }
}

export function destroyLiveMap(container) {
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

export function renderLiveMap(container, points, options = {}) {
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

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function updateDraggableMap(viewport) {
  const image = viewport.querySelector(".poi-map-preview");
  if (!image) return;
  const x = Number(viewport.dataset.offsetX || 0);
  const y = Number(viewport.dataset.offsetY || 0);
  image.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

export function clampMapOffset(viewport) {
  const image = viewport.querySelector(".poi-map-preview");
  if (!image || !image.complete) return;
  const maxX = Math.max(0, (image.clientWidth - viewport.clientWidth) / 2);
  const maxY = Math.max(0, (image.clientHeight - viewport.clientHeight) / 2);
  viewport.dataset.offsetX = String(clamp(Number(viewport.dataset.offsetX || 0), -maxX, maxX));
  viewport.dataset.offsetY = String(clamp(Number(viewport.dataset.offsetY || 0), -maxY, maxY));
  updateDraggableMap(viewport);
}

export function resetDraggableMap(viewport) {
  viewport.dataset.offsetX = "0";
  viewport.dataset.offsetY = "0";
  updateDraggableMap(viewport);
}

export function setMapLoadState(image, state) {
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

export function initDraggableMaps(root = document) {
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

const liveMapQueue = [];
let liveMapQueueRunning = false;

export function ensureLiveMap(container, options = {}) {
  if (!container || container.dataset.mapReady === "true") return;
  const points = parseLiveMapPoints(container);
  if (!points.length) return;
  container.dataset.mapReady = "true";
  renderLiveMap(container, points, { ...options });
}

export function scheduleLiveMap(container) {
  if (!container || container.dataset.mapReady === "true" || container.dataset.mapQueued === "true") return;
  container.dataset.mapQueued = "true";
  liveMapQueue.push(container);
  if (!liveMapQueueRunning) {
    processLiveMapQueue();
  }
}

export function processLiveMapQueue() {
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

export function initLiveMaps(root = document) {
  root.querySelectorAll("[data-live-map]").forEach((container) => {
    if (container.dataset.mapReady === "true") return;
    scheduleLiveMap(container);
  });
}
