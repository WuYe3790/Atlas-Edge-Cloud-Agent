# LangChain 旅游规划智能体

这是一个用于“智能体架构与开发流程”实验的课程项目。项目基于 Python、Flask、LangChain 和 DeepSeek API，实现了一个可以进行自然语言旅游规划的 Agent：理解需求、拆解任务、调用模型、选择外部工具、汇总结果，并在网页端展示最终方案和执行过程。

项目参考了本地下载的飞桨 AI Studio 教程《【LangChain+文心大模型】构建旅游出行规划智能体》，但当前版本已经扩展为带 Web UI、多轮会话、流式执行过程、真实地图/天气/交通工具和结构化卡片展示的本地演示系统。

## 当前状态

当前项目适合用于：

- 课程实验验收
- 本地演示 LangChain Agent 工作流
- 继续打磨为简历项目或面试展示项目

核心能力已经完成：

- DeepSeek 普通模式和深度思考模式切换
- LangChain Agent 自主选择工具
- Flask Web 聊天界面
- SSE 流式返回 Agent 执行过程
- SQLite 历史会话持久化
- 本地知识库 RAG + FAISS 向量检索，支持课程实验资料、Agent 架构说明、历史会话经验和城市攻略补充
- Skill 高阶编排能力，支持智能体自动判断调用，也支持用户通过前端显式调用
- Markdown 回答 + 结构化卡片双输出
- 高德地图、和风天气、LetsFG、Aviationstack、12306-MCP、Booking.com/RapidAPI 等外部数据源接入

当前工具数量：

- 20 个核心 Python 工具
- 3 个可选 12306 火车票工具
- 2 个已安装 Skill
- Node.js / npx 不可用时，12306 工具自动降级，不影响其他功能

## 技术栈

- Python
- Flask
- LangChain
- `langchain-openai` OpenAI-compatible 接口
- DeepSeek API
- 高德地图 Web 服务 API
- 和风天气 API
- LetsFG 本地实时机票搜索
- Aviationstack API
- Booking.com / RapidAPI
- 12306-MCP
- 本地 Markdown 知识库 RAG
- FAISS CPU
- SQLite
- 原生 HTML / CSS / JavaScript
- SSE 流式通信

推荐解释器：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe
```

## 运行方式

安装依赖：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe -m pip install -r requirements.txt
```

启动 Web 项目：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe app.py
```

浏览器访问：

```text
http://127.0.0.1:5000
```

命令行普通模式：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe run.py -q "我明天从郑州去杭州，玩3天"
```

命令行深度思考模式：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe run.py --thinking -q "我明天从郑州去杭州，玩3天"
```

命令行离线演示：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe run.py --offline-demo -q "我明天从郑州去杭州，玩3天"
```

离线演示不会调用 DeepSeek，只用于验证页面、工具链和卡片渲染流程。

## 环境变量

复制模板：

```powershell
Copy-Item .env.example .env
```

`.env` 需要配置：

```text
LLM_API_KEY=你的 DeepSeek API Key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
LLM_THINKING_MODEL=deepseek-v4-pro
LLM_TEMPERATURE=0.3
LLM_TIMEOUT=90

AMAP_API_KEY=你的高德地图 Web 服务 Key
AMAP_JS_API_KEY=你的高德 JS API Key
AMAP_JS_SECURITY_CODE=你的高德 JS API 安全密钥
QWEATHER_API_KEY=你的和风天气 API Key
QWEATHER_API_HOST=你的和风天气专属 API Host
QWEATHER_JWT_KEY_ID=你的和风天气 JWT 凭据 ID
QWEATHER_JWT_PROJECT_ID=你的和风天气项目 ID
QWEATHER_JWT_PRIVATE_KEY_PATH=你的 Ed25519 私钥文件路径
QWEATHER_JWT_PRIVATE_KEY=也可以直接填写 Ed25519 私钥内容，换行写成 \n
QWEATHER_JWT_PUBLIC_KEY_SHA256=控制台显示的公钥 SHA-256，仅用于人工核对
AVIATIONSTACK_API_KEY=你的 Aviationstack API Key
LETSFG_SEARCH_TIMEOUT=600
LETSFG_SEARCH_MODE=fast
LETSFG_MAX_BROWSERS=3
LETSFG_MAX_STOPOVERS=0
RAPIDAPI_KEY=你的 RapidAPI Key
RAPIDAPI_HOST=booking-com15.p.rapidapi.com
```

注意：

- `.env` 包含真实密钥，不要提交到公开仓库。
- DeepSeek 控制台没有请求记录时，先检查前端是否开启了“离线演示”。
- 和风天气优先使用 JWT 认证；JWT 缺失或失败时回退 API Key。空气质量已升级到 `airquality/v1/current/{lat}/{lon}`，天气预警已升级到 `weatheralert/v1/current/{lat}/{lon}`，旧版 v7 接口只作为兜底。
- LetsFG 当前用于优先查询实时机票报价，本地搜索可能较慢，因此默认设置 600 秒超时，失败后自动回退到 Aviationstack。
- LetsFG 默认使用 3 个本地浏览器槽，并优先查询直飞报价（`LETSFG_MAX_STOPOVERS=0`）；如需中转机票，可改为 `1` 或 `2`。
- Aviationstack 当前只用于航班时刻/状态回退查询，不提供真实机票价格。
- Booking.com/RapidAPI 当前用于酒店价格参考，价格和库存以 Booking.com 确认页为准。
- 如果 RapidAPI 免费额度用尽或接口限流，`search_hotel_prices` 会自动降级为高德地图酒店 POI 参考：只展示酒店位置、评分、联系方式等信息，不包含实时房价和库存。
- 12306 工具需要本机 Node.js / npx，首次调用可能较慢。
- LetsFG 本地搜索依赖 Playwright Chromium；首次安装依赖后可执行 `C:\Users\BaoXinJie\anaconda3\python.exe -m playwright install chromium`。

## 项目结构

```text
.
├── app.py                         # Flask 启动入口
├── web.py                         # Flask 兼容入口，创建 server app
├── run.py                         # CLI 启动入口
├── requirements.txt               # Python 依赖
├── .env.example                   # 环境变量模板
├── README.md                      # 项目说明
├── EXPERIMENT_REPORT.md           # 实验报告材料
├── knowledge/                     # 本地 RAG 知识库，支持 Markdown / TXT
│   ├── agent_architecture.md       # 智能体架构、LangChain、RAG/Memory/Skill
│   ├── travel_tips.md              # 通用旅行规划知识
│   ├── history_insights.md         # 从历史会话整理出的城市经验和工具经验
│   └── cities/                     # 城市攻略和避坑建议
├── data/
│   └── travel_agent.db            # SQLite 数据库，运行后生成
├── static/
│   ├── app.js                     # 前端交互、SSE、卡片渲染、地图拖拽
│   └── styles.css                 # 页面样式
├── templates/
│   └── index.html                 # 页面模板
├── server/
│   ├── __init__.py                # Flask app 工厂与蓝图注册
│   ├── bootstrap.py               # 项目路径、缓存目录和运行环境初始化
│   ├── context.py                 # 前端定位上下文、乱码检测
│   ├── core_routes.py             # 首页、图片代理、运行状态接口
│   ├── amap_client.py             # 高德 Web API 客户端
│   ├── amap_routes.py             # 高德定位、联想、静态地图代理
│   ├── conversation_routes.py     # 历史会话 CRUD
│   └── chat_routes.py             # 普通聊天与 SSE 流式聊天接口
└── src/
    └── travel_agent/
        ├── agent.py               # Agent 构建、运行入口、流式事件
        ├── cli.py                 # CLI 参数解析
        ├── config.py              # 配置读取
        ├── prompts.py             # 系统提示词、工具使用规则、结构化输出协议
        ├── skills.py              # Skill 注册中心和高阶编排工具
        ├── storage.py             # SQLite 会话持久化
        ├── structured.py          # 结构化 JSON 提取、卡片数据兜底解析
        ├── tool_clients.py        # API Key 读取、通用 HTTP 请求、和风 JWT 认证
        ├── tool_data.py           # 天气代码、机场三字码、酒店城市别名等静态数据
        ├── tool_flights.py        # LetsFG 本地搜索、机场三字码解析、航班报价格式化
        ├── tool_formatters.py     # 工具输出格式化、耗时/距离/航班/日志文案
        ├── tool_hotels.py         # Booking.com/RapidAPI 目的地解析和酒店查询辅助
        ├── tool_maps.py           # 高德地点解析、坐标归一化、地图链接基础能力
        ├── tool_rag.py            # 本地知识库 RAG 检索工具
        ├── tool_transport.py      # 驾车、公交/地铁、步行、骑行、距离矩阵、实时路况
        ├── tool_weather.py        # 天气、空气质量、天气预警、生活指数工具
        ├── trace.py               # 执行报告、工具状态、trace 清洗
        ├── tools.py               # 核心工具
        └── train_tools.py         # 12306-MCP 客户端和火车票工具
```

当前重构原则：

- `web.py` 只保留旧入口兼容，具体后端接口都在 `server/` 蓝图中维护。
- `travel_agent.prompts` 独立维护大段系统提示词和结构化输出协议，后续调整 Agent 行为时无需在运行逻辑中翻找长文本。
- `travel_agent.structured` 独立处理 JSON 提取、酒店卡片兜底、天气指数兜底等结构化数据逻辑，降低前后端卡片问题的定位成本。
- `travel_agent.trace` 独立管理执行报告状态，方便排查“工具调用显示异常”“trace 状态误判”等问题。
- `travel_agent.tool_clients` 独立管理 API Key、通用 HTTP 请求、和风 JWT 生成与认证回退，后续排查第三方接口问题更集中。
- `travel_agent.tool_data` 独立保存机场三字码、酒店城市别名、天气代码等静态数据，后续补充城市映射时不需要改工具逻辑。
- `travel_agent.tool_flights` 独立承接 LetsFG 本地搜索、机场三字码归一化和实时机票报价格式化。
- `travel_agent.tool_formatters` 独立保存距离、时间、航班、POI、日志等格式化逻辑，后续改展示文案时不需要动 API 调用代码。
- `travel_agent.tool_hotels` 独立承接 Booking.com/RapidAPI 的城市目的地解析和酒店查询辅助逻辑。
- `travel_agent.tool_maps` 独立承接高德地点解析、坐标归一化、路线起终点解析和地图 URI 生成等基础地图能力。
- `travel_agent.tool_rag` 独立承接本地知识库检索，资料来源为 `knowledge/` 下的 Markdown/TXT 文档，当前使用 FAISS 向量检索和本地哈希嵌入。
- `travel_agent.skills` 独立承接 Skill 注册和高阶编排。Skill 可以像工具一样被 Agent 自动调用，也可以由用户在前端通过 `@技能名` 显式触发。
- `travel_agent.tool_transport` 独立承接高德驾车、公交/地铁、步行、骑行、距离矩阵、实时路况等交通工具。
- `travel_agent.tool_weather` 独立承接天气、空气质量、灾害预警、生活指数四个天气相关工具。
- `travel_agent.tools` 仍保留为统一工具注册入口，避免影响 LangChain Agent 的工具列表；后续新增/删除工具时优先改对应领域模块，再在这里导入并加入 `TRAVEL_TOOLS`。

## Agent 架构

```text
用户输入
  -> Flask /api/chat/stream
  -> LangChain Agent
  -> DeepSeek LLM 理解需求
  -> LLM 决定是否调用工具
  -> 工具返回真实数据或降级结果
  -> LLM 汇总 Markdown 答案
  -> LLM 在答案末尾输出结构化 JSON
  -> 后端提取 structured_data 并去掉原始 JSON
  -> SSE 返回最终答案、trace 和 structured_data
  -> 前端渲染 Markdown、执行过程和卡片
```

这与固定流程脚本不同。固定流程通常写死“查天气 -> 查交通 -> 套模板”，而本项目由 LLM 根据用户问题自主判断是否需要天气、交通、火车、航班、POI、预算等工具。

## 核心功能

### Web 对话

- 多轮聊天
- 历史会话保存到 SQLite
- 刷新页面后恢复会话
- 可新建、切换、删除会话
- 支持停止当前流式请求

### 模型模式

- 普通模式：`deepseek-v4-flash`
- 深度思考模式：`deepseek-v4-pro`

当前深度思考模式是“更强模型 + 提示词层面的深度规划”，没有开启 DeepSeek API-level thinking。原因是 API-level thinking 在工具调用场景下需要维护 `reasoning_content` 回传，LangChain OpenAI-compatible 工具链暂未稳定处理该字段。为保证工具调用稳定，当前禁用了 API 原生 thinking。

### 执行过程可视化

前端会实时展示 Agent 的执行过程：

- 请求是否已发出
- 当前使用的模型
- 正在调用哪个工具
- 工具参数摘要
- 工具是否成功
- 工具耗时
- LLM token usage
- 异常步骤高亮
- 可导出执行报告 JSON

2026-05-18 已优化交互：

- 用户可以手动展开/折叠执行过程
- 手动折叠后不会被流式更新强制展开
- 展开状态下默认跟随最新阶段
- 用户拖动执行过程滚动条时，前端会短暂停止重绘，避免抢鼠标

### 结构化卡片

Agent 的最终回答末尾会输出 JSON，后端提取为 `structured_data`，前端渲染为卡片：

- 行程摘要
- 天气卡片
- 天气预警卡片
- 交通方案卡片
- 12306 中转分段卡片
- 每日行程时间轴
- 预算明细
- 出行提示
- POI 地点推荐卡片

如果模型没有输出合法 JSON，系统会自动回退到纯 Markdown，不影响回答展示。

### 本地知识库 RAG

项目新增了 `knowledge/` 本地知识库和 `search_local_knowledge` 工具。Agent 在遇到课程实验、智能体架构、LangChain、RAG/Memory/Skill、项目说明、城市攻略和避坑建议等问题时，可以先检索本地资料，再结合实时工具结果回答。

当前知识库特点：

- 支持 Markdown 和 TXT 文档，直接放入 `knowledge/` 或其子目录即可。
- 运行时按需读取并自动检查文件修改时间，知识库变化后会重建本地索引。
- 当前使用 FAISS `IndexFlatIP` 做向量检索，向量由本地字符 n-gram 哈希嵌入生成，不需要下载大模型权重。
- 后续可以把 `tool_rag.py` 内部的哈希嵌入替换为 sentence-transformers、BGE、OpenAI Embeddings 或其他 embedding 服务，外部工具名和 Agent 调用方式保持不变。

使用边界：

- RAG 用于静态知识补充，不替代实时 API。
- 天气、空气质量、预警、路况、公交、航班、高铁、酒店价格仍应调用对应实时工具。
- 如果知识库没有命中，工具会明确返回“未检索到足够相关的本地知识”，不会伪造资料。

### Skill 高阶编排

项目新增了 `travel_agent.skills`，把一组底层工具封装成更接近“可复用能力”的 Skill。Skill 同时具备两种调用方式：

- 自动调用：Agent 根据用户意图判断是否需要调用对应 Skill。
- 显式调用：用户可以在输入框中写 `@市内交通查询` 或 `@城市间交通查询`，也可以在前端 Skills 面板点击“使用”自动插入调用标记。

当前已安装 Skill：

| Skill | 显式调用 | 聚合能力 | 适用场景 |
|---|---|---|---|
| 市内交通查询 | `@市内交通查询` | 公交/地铁、步行、骑行、可选路况 | 同城车站、酒店、景点之间怎么走 |
| 城市间交通查询 | `@城市间交通查询` | 驾车、高铁/火车、可选中转、航班 | 两座城市之间比较交通方式 |

后端接口：

- `GET /api/skills`：返回当前已安装 Skill、描述、显式调用格式、示例和聚合的底层工具。

注意：Skill 是高阶编排能力，不替代底层工具。用户只问“查航班”时仍优先直接调用航班工具；用户要求“比较怎么去”或显式使用 Skill 时才调用高阶 Skill。

### 地图和地点体验

高德地图相关能力：

- IP 默认城市识别
- 浏览器定位 + 高德逆地理编码
- 地点输入联想
- 地点解析
- 全城 POI 搜索
- 周边 POI 搜索
- 驾车路线
- 公交/地铁换乘
- 步行路线
- 骑行路线
- 距离矩阵
- 实时路况
- 高德 URI 地图链接
- 静态地图预览

2026-05-18 已完成的前端体验优化：

- 输入区增加“联想”开关，用户可关闭地点补全
- 点击联想候选时只替换当前地点片段，不再清空整句
- 地点推荐卡片和地图 marker 使用同一编号
- 所有推荐地点都会展示在该类别的静态地图上
- 静态地图使用更大图片和更大的展示窗口
- 地图支持鼠标按住拖拽，在有限范围内移动视角
- 静态地图无法像真实 JS 地图一样加载新瓦片，但足够用于观察推荐点的相对位置

## 工具列表

核心工具：

| 工具 | 数据源 | 说明 |
|---|---|---|
| `get_weather_info` | 和风 > 高德 > Open-Meteo | 天气查询，含回退 |
| `get_air_quality_info` | 和风 JWT/API Key | 空气质量 v1，旧版 v7 兜底 |
| `get_weather_alerts` | 和风 JWT/API Key | 天气预警 v1，旧版 v7 兜底 |
| `get_weather_indices` | 和风 JWT/API Key | 运动、穿衣、防晒、舒适度、交通等生活指数 |
| `calculate_trip_budget` | 本地计算 | 预算估算 |
| `city_transit_skill` | Skill 编排 | 市内交通查询，聚合公交/地铁、步行、骑行和路况 |
| `intercity_transport_skill` | Skill 编排 | 城市间交通查询，聚合驾车、铁路、航班和中转方案 |
| `get_transport_advice` | 高德 | 驾车路线、距离、耗时、过路费 |
| `search_flight_options` | LetsFG > Aviationstack | 优先实时机票报价；超时或失败时回退航班时刻/状态 |
| `get_public_transit_plan` | 高德 | 公交/地铁换乘 |
| `get_walking_route` | 高德 | 步行路线 |
| `get_bicycling_route` | 高德 | 骑行路线 |
| `get_route_distance_matrix` | 高德 | 多起点距离/耗时对比 |
| `get_traffic_status` | 高德 | 实时路况 |
| `search_travel_pois` | 高德 | 全城景点、餐饮、商圈、酒店 POI |
| `search_nearby_pois` | 高德 | 指定地点周边 POI |
| `search_hotel_prices` | Booking.com/RapidAPI | 真实酒店价格参考 |
| `search_local_knowledge` | 本地知识库 RAG + FAISS | 实验资料、Agent 架构、LangChain、历史会话经验、城市攻略和避坑建议 |
| `get_place_location` | 高德 | 地点解析和坐标 |
| `get_map_marker_link` | 高德 URI | 无 Key 地图链接 |

可选 12306 工具：

| 工具 | 数据源 | 说明 |
|---|---|---|
| `search_train_tickets` | 12306-MCP | 余票查询 |
| `search_interline_train_tickets` | 12306-MCP | 中转余票查询 |
| `get_train_route` | 12306-MCP | 车次经停站 |

## 主要接口

`web.py` 提供：

- `GET /`：Web 页面
- `GET /api/status`：模型和 API 状态
- `GET /api/conversations`：会话列表
- `GET /api/conversations/<id>/messages`：会话消息
- `DELETE /api/conversations/<id>`：删除会话
- `POST /api/chat`：非流式聊天，保留兼容
- `POST /api/chat/stream`：SSE 流式聊天，前端主要使用
- `GET /api/amap/ip-location`：高德 IP 定位代理
- `GET /api/amap/reverse-geocode`：高德逆地理编码代理
- `GET /api/amap/input-tips`：高德输入提示代理
- `GET /api/amap/static-map`：高德静态地图代理

前端不直接暴露高德 API Key。

## 常用验证命令

Python 编译检查：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe -m compileall app.py web.py run.py src
```

前端语法检查：

```powershell
node --check static/app.js
```

状态接口：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5000/api/status
```

查看 5000 端口：

```powershell
Get-NetTCPConnection -LocalPort 5000 -State Listen
```

关闭当前项目进程：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*web.py*' -or $_.CommandLine -like '*app.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 已知限制

- Flask 当前是开发服务器，只适合本地演示。
- DeepSeek API-level thinking 暂未开启，深度思考模式依赖 Pro 模型和提示词。
- 航班工具优先使用 LetsFG 本地实时搜索返回机票报价；若 LetsFG 超时、无结果或本机浏览器搜索失败，则回退到 Aviationstack 航班时刻/状态，此时不含真实票价。
- 酒店价格已接入 Booking.com/RapidAPI，但价格、库存、税费和最终支付价仍以 Booking.com 确认页为准。
- 和风空气质量/天气预警依赖账号权限，403 时会降级。
- 高德静态地图是图片，不是真正交互式地图；当前支持拖动图片视角，但不能缩放或加载新瓦片。
- 12306-MCP 首次调用可能因 npx 下载或初始化而较慢。

## 今日工作记录（2026-05-18）

今天主要完成了 Phase 3 用户体验和高德地图展示方向的收尾：

- 修复输入联想空白条遮挡按钮的问题。
- 解释并优化地点联想逻辑。
- 增加“联想”开关，用户可关闭高德地点补全。
- 修复点击联想候选后输入框被整句清空的问题。
- 修复执行过程流式更新时强制展开、抢滚动条、抢鼠标的问题。
- 优化执行过程滚动策略：默认跟随最新输出，用户操作时暂停重绘。
- 清理交通卡片里的技术噪声，例如无意义状态、空时间、Aviationstack 说明等。
- 修复交通卡片分类错误，例如“驾车”被误判为“火车”。
- 修复高德静态地图多 marker 参数格式错误导致的破图。
- 给静态资源增加版本号，减少浏览器缓存导致的旧页面问题。
- 将 POI 地图改为“地图编号 + 卡片编号 + 图例”对应关系。
- 支持每个推荐类别的所有地点展示在静态地图上。
- 扩大静态地图图片和展示窗口。
- 增加静态地图拖拽视角能力，方便观察推荐点相对位置。
- 继续完成 Phase 3 的 3/4/5 方向：每日行程可根据 POI 坐标生成当天地点关系小地图；单点查询提示词进一步收敛，避免简单查询扩展为完整行程；结构化卡片底部新增数据可信度区域，汇总数据源和限制说明。
- 重启并验证项目多次，确认首页模板和静态资源版本生效。
- 进入 Phase 4：接入高德 JS API 配置，POI 地图和每日行程小地图优先使用真实高德地图渲染。
- 保留静态地图兜底，避免 JS API 加载失败时地图区域空白。
- 补齐 POI 筛选/排序后的地图同步逻辑，筛选后的卡片、图例和 marker 编号会一起变化。

## 今日工作记录（2026-05-19）

- 检查 `esakrissa/hotels_mcp_server`，确认其核心能力来自 RapidAPI 上的 Booking.com API。
- 实测 RapidAPI Key 可请求 Booking.com 酒店目的地和酒店价格接口。
- 未原样引入 MCP 子进程，而是将其核心查询逻辑改造为项目内置 LangChain 工具 `search_hotel_prices`。
- 新增 `RAPIDAPI_KEY` / `RAPIDAPI_HOST` 配置项和 `/api/status` 状态检测。
- 新增中文城市别名兜底，例如“杭州”可自动回退到 `Hangzhou` 查询。
- 新增 `hotel_options` 结构化 JSON 字段和前端“酒店价格参考”卡片。
- 执行报告支持展示 `search_hotel_prices` 工具调用。
- 酒店价格数据可信度说明已加入前端卡片：价格为 Booking.com/RapidAPI 实时参考，最终以确认页为准。

## 今日工作记录（2026-05-20）

- 检查 `LetsFG/LetsFG` 开源项目，确认其本地航班搜索可免费运行且不需要 API Key；地点解析、解锁和预订能力需要 LetsFG 账号/API Key。
- 安装 `letsfg` 和 Playwright Chromium 到当前 Anaconda Python 环境。
- 将 `search_flight_options` 升级为“两级策略”：优先调用 LetsFG 本地实时机票搜索，返回航司、航班号、起降时间、经停、价格和预订链接；失败或超时后自动回退 Aviationstack。
- 保留 Aviationstack 作为兜底，避免 LetsFG 搜索较慢时导致简单航班查询长时间无响应。
- 新增 `LETSFG_SEARCH_TIMEOUT`、`LETSFG_SEARCH_MODE`、`LETSFG_MAX_BROWSERS` 配置项。
- 更新 Agent 提示词：用户只询问航班/机票时，优先只回答航班和票价相关内容，不扩展成完整旅行规划。
- 清理 LetsFG 测试产生的本地浏览器缓存目录，避免无关文件进入项目。
- 优化 LetsFG 稳定性：默认提高本地浏览器并发槽到 3，优先直飞报价，清洗连接器日志中的乱码；LetsFG 未完成时返回“未返回实时票价并回退”，不再把整个航班工具标记为异常。
- 增加和风天气 JWT 认证支持：`Authorization: Bearer <JWT>` 优先，API Key 保留为回退。
- 空气质量查询升级到和风 `airquality/v1/current/{latitude}/{longitude}` 新接口；旧版 `/v7/air/now` 只在新接口失败时作为兜底。
- 天气预警查询升级到和风 `weatheralert/v1/current/{latitude}/{longitude}` 新接口；旧版 `/v7/warning/now` 只在新接口失败时作为兜底。
- 新增天气生活指数工具 `get_weather_indices`，接入和风 `/v7/indices/1d`，前端新增“天气指数”卡片。
- 完成一轮保守架构解耦：`web.py` 收缩为兼容入口，新增 `server/` 包拆分 Flask app 工厂、核心路由、高德代理、会话路由和聊天/SSE 路由；新增 `travel_agent.trace` 管理执行报告与工具状态判定。
- 继续拆分 Agent 内部职责：新增 `travel_agent.prompts` 管理系统提示词和结构化输出协议，新增 `travel_agent.structured` 管理结构化 JSON 提取、酒店卡片兜底和天气指数兜底解析。
- 新增 `travel_agent.tool_clients`，把 API Key 读取、通用 HTTP 请求、和风 JWT 认证与回退逻辑从业务工具中拆出。
- 新增 `travel_agent.tool_data`，把天气代码、机场三字码、酒店城市别名从核心工具逻辑中拆出，降低 `tools.py` 的维护压力。
- 新增 `travel_agent.tool_formatters`，把距离/时间/POI/航班/工具日志等格式化逻辑从业务工具中拆出。
- 新增 `travel_agent.tool_flights` 和 `travel_agent.tool_hotels`，分别承接 LetsFG/航班辅助逻辑与 Booking.com/RapidAPI 酒店辅助逻辑。
- 新增 `travel_agent.tool_maps`，把高德地点解析、坐标归一化、路线点解析、地图链接生成等地图基础能力从工具入口中拆出。
- 新增 `travel_agent.tool_weather`，把天气、空气质量、天气预警、生活指数四个天气工具从 `tools.py` 中拆出。
- 新增 `travel_agent.tool_transport`，把驾车、公交/地铁、步行、骑行、距离矩阵、实时路况六个交通工具从 `tools.py` 中拆出。
- 优化酒店查询降级策略：RapidAPI 未配置、免费额度用尽、限流或接口异常时，`search_hotel_prices` 自动回退高德地图酒店 POI，继续提供住宿位置参考，并明确标注“不含实时房价”。
- 清理前端 `static/app.js` 中被后续实现覆盖的重复函数定义，避免维护时误改旧版 `renderTrace`、`requestChatStream`、`appendMeta`、`setBusy` 等无效逻辑。
- 新增 `knowledge/` 本地知识库，补充智能体架构、LangChain、RAG/Memory/Skill、通用旅行规划和常用城市攻略资料。
- 新增 `travel_agent.tool_rag.search_local_knowledge` 工具，Agent 可在课程实验说明、项目实现思路、城市攻略和避坑建议场景中检索本地知识。
- 更新 Agent 提示词：明确 RAG 是静态资料补充，不替代天气、交通、酒店、航班、高铁等实时工具。
- 前端执行报告新增 RAG 工具展示文案，便于观察本地知识库检索是否被调用。
- 将 RAG 检索层升级为 FAISS：使用 `faiss.IndexFlatIP` 和本地字符 n-gram 哈希嵌入构建向量索引，无需额外模型下载。
- 检查本地 SQLite 历史会话，从已有旅行规划和工具异常处理中整理出 `knowledge/history_insights.md`，沉淀沈阳、太原、吉林、张家口、银川、重庆、桂林、哈尔滨、武汉、广州、成都等城市经验。
- 更新依赖：新增 `faiss-cpu`，并将 `numpy` 约束为 `>=1.25,<2.0`，避免 numpy 2.x 对当前 Anaconda 生态造成兼容风险。
- 新增 Skill 进阶版基础架构：`travel_agent.skills` 作为 Skill 注册中心，Skill 既可被 Agent 自动判断调用，也支持用户通过 `@技能名` 显式触发。
- 新增两个交通类 Skill：`city_transit_skill`（市内交通查询）和 `intercity_transport_skill`（城市间交通查询）。
- 新增 `/api/skills` 接口和前端 Skills 面板，用户可查看当前安装的 Skill、底层工具和显式调用格式，并一键插入调用标记。

## 接手指南

当前代码已经拆成“入口 + 领域模块”的结构，项目启动方式没有变化：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe app.py
```

接手时建议先看这些文件：

- `server/chat_routes.py`：Web 聊天和 SSE 流式接口。
- `src/travel_agent/agent.py`：Agent 构建、普通/深度思考模式、流式事件组装。
- `src/travel_agent/prompts.py`：系统提示词、单点查询约束、结构化 JSON 输出协议。
- `src/travel_agent/tools.py`：LangChain 工具统一注册入口，`TRAVEL_TOOLS` 在这里组装。
- `src/travel_agent/skills.py`：Skill 注册中心和高阶编排工具，新增 Skill 时优先在这里登记元数据和实现逻辑。
- `src/travel_agent/tool_weather.py`：天气、空气质量、天气预警、生活指数。
- `src/travel_agent/tool_transport.py`：驾车、公交/地铁、步行、骑行、距离矩阵、实时路况。
- `src/travel_agent/tool_flights.py`：LetsFG 本地搜索和航班辅助逻辑。
- `src/travel_agent/tool_hotels.py`：Booking.com/RapidAPI 酒店辅助逻辑。
- `src/travel_agent/tool_maps.py`：高德地点解析和坐标基础能力。
- `src/travel_agent/tool_rag.py`：本地知识库 RAG + FAISS 检索逻辑。
- `knowledge/`：可直接扩展的本地 Markdown/TXT 知识库，已包含实验资料、城市攻略和历史会话沉淀知识。
- `src/travel_agent/structured.py`：后端提取结构化 JSON 和卡片兜底数据。
- `static/app.js`：前端聊天、SSE、卡片和地图渲染。

继续拆分建议：

- 优先拆 `tools.py` 中剩余的 POI/地点展示工具：`search_travel_pois`、`search_nearby_pois`、`get_place_location`、`get_map_marker_link` 可迁入 `tool_pois.py`。
- 酒店主工具 `search_hotel_prices` 也可以迁入 `tool_hotels.py`，但要确认前端酒店卡片和执行报告仍能正常解析工具名。
- 航班主工具 `search_flight_options` 可迁入 `tool_flights.py`，但要保留 `tools.py` 中对它的导入和 `TRAVEL_TOOLS` 注册。
- 每拆一组后建议执行：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe -m compileall app.py run.py web.py server src
node --check static\app.js
```

并用 Flask test client 或浏览器至少验证 `/api/status`、`/api/chat` 离线演示和一次真实工具调用。

## 后续优化路线

### 当前 Phase 可继续优化

这一阶段仍然建议围绕“功能和用户体验”继续，不优先做工程化测试：

1. **地图交互增强**
   - 当前是可拖拽静态图，已经比普通图片强一些。
   - 已支持更大静态图、拖拽视角、重置视角、打开地图图像。
   - 后续可在不接 JS API 的前提下继续加地图全屏预览、按类别切换地图。

2. **POI 推荐质量**
   - 已支持按评分、人均、名称排序。
   - 已支持按类型、高评分、低人均、可联系筛选。
   - 对餐饮、景点、商圈、住宿分别使用更精确的高德 typecode。
   - 后续可结合路线顺序，增加“离当天路线近”的推荐。

3. **行程与地图联动**
   - 当前按保守方案展示每日行程相关地点小地图，不再强行绘制可能误导用户的地点连线。
   - 后续可在地点抽取、分类和顺序稳定后，再考虑恢复真正路线 polyline。
   - 交通方案卡片点击后展示该路线涉及的起终点。

4. **单点查询体验继续收敛**
   - 已强化提示词：航班、火车、天气、公交、周边 POI 等单点查询只填相关结构化字段。
   - 前端不再为 total=0 且无说明的预算 JSON 渲染空预算卡。
   - 后续可加入后端轻量意图分类，在进入 Agent 前给单点查询附加更强约束。

5. **数据可信度展示**
   - 已新增数据可信度卡片，汇总天气、交通、POI、预算等数据源。
   - 已对“LetsFG 可能超时并回退 Aviationstack”“预算为估算值”“预警接口可能受权限影响”等限制做统一说明。
   - 后续可在导出报告里进一步区分真实数据、估算数据、模型推断。

### Phase 4：真正的地图交互系统

目标是把当前“可拖拽静态地图”升级为真正地图应用。当前已接入高德 JS API，保留静态地图作为兜底。

已完成过：

- 新增 `AMAP_JS_API_KEY` 和 `AMAP_JS_SECURITY_CODE` 配置项。
- 后端新增 `/api/amap/js-config`，前端按需加载高德 JS API。
- POI 推荐地图优先渲染为真实高德地图，加载失败时回退到静态地图。
- 每日行程小地图曾尝试用折线展示当天地点关系；由于地点抽取和顺序稳定性不足，当前已回退为只展示当日相关地点。
- 点击 marker 可查看地点名称、类型和地址。
- marker hover / click 会高亮对应 POI 卡片。
- POI 卡片 hover 会反向高亮对应 marker。
- POI 类型筛选、快捷筛选、排序变化后，地图 marker 和图例同步更新。

后续可继续：

- 在真实地图中切换步行、公交、驾车路线。
- 将每日行程折线升级为真实路线 polyline，而不是地点关系连线。

### Phase 5：旅行方案编辑器

目标是让用户不仅能看方案，还能直接调整方案。

- 用户可拖动调整每日行程顺序
- 删除不喜欢的景点
- 替换餐饮或景点
- 一键让 Agent 根据修改后的行程重新规划
- 形成“Agent 生成 -> 用户编辑 -> Agent 修正”的闭环

### Phase 6：偏好系统与本地知识库

目标是让 Agent 更像个人旅行助手，而不是一次性问答工具。

- 出行节奏：轻松 / 标准 / 紧凑
- 偏好：美食 / 历史 / 自然 / 亲子 / 拍照
- 交通：公共交通 / 自驾 / 打车优先
- 预算：经济 / 舒适 / 高端
- 偏好保存到会话或本地设置
- 加入城市攻略、景点开放时间、避坑建议、实验说明文档等本地资料
- Agent 先检索本地知识库，再结合实时工具结果回答

### Phase 7：导出、展示与工程化

目标是把项目打磨成可公开展示和面试讲解的版本。

- 一键导出 Markdown / PDF / HTML 行程单
- 导出内容包含地图、每日路线、预算、交通方案、执行报告摘要
- README 增加截图和演示 GIF
- 补充 pytest、mock API、Dockerfile
- 梳理提交记录和 Demo 脚本

旧 Phase 4 中的工作量较大，因此已经拆分为 Phase 4-7，避免单阶段目标过宽。

## 简历描述参考

可以概括为：

> 基于 LangChain 和 DeepSeek 的智能旅行规划 Agent，支持多轮对话、SSE 流式执行过程可视化、SQLite 历史持久化、本地知识库 RAG + FAISS、Skill 高阶编排和 23 个工具/Skill 调用。系统接入高德地图、和风天气、LetsFG、Aviationstack、12306-MCP 与本地 Markdown 知识库，具备天气、预警、空气质量、驾车、公交、步行、骑行、实时路况、实时机票报价、航班时刻回退、火车票、POI 搜索、周边搜索、地点解析、城市攻略检索、城市间交通 Skill 和市内交通 Skill 等能力。前端将模型输出的结构化 JSON 渲染为天气、交通、预算、行程、POI 和地图卡片，并支持地点联想、Skill 面板、显式 Skill 调用、默认出发地识别、Agent 执行报告导出等交互。
