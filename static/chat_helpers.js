// Chat UI, SSE streaming & trace rendering — extracted from travel_helpers.js

function getConversationHistory() {
  return [...messagesEl.querySelectorAll(".message:not(.loading)")].slice(0, -1).slice(-8).map((message) => {
    const role = message.classList.contains("user") ? "user" : "assistant";
    const bubble = message.querySelector(".bubble");
    return { role, text: bubble?.dataset.rawText || bubble?.textContent || "" };
  });
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
