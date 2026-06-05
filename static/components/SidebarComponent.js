// Sidebar Component - Handles Mode switching, tabs, history, skills, configuration, and device monitoring.

export default {
  name: 'SidebarComponent',
  props: {
    activeMode: { type: String, default: 'travel' },
    activeTab: { type: String, default: 'history' },
    sidebarCollapsed: { type: Boolean, default: false },
    conversations: { type: Array, default: () => [] },
    activeConversationId: { type: String, default: '' },
    skills: { type: Array, default: () => [] },
    devices: { type: Array, default: () => [] },
    systemStatus: { type: Object, default: () => ({}) },
    locationStatusText: { type: String, default: '未定位' }
  },
  emits: [
    'update:activeMode',
    'update:activeTab',
    'toggle-sidebar',
    'new-chat',
    'select-conversation',
    'delete-conversation',
    'manual-heartbeat',
    'use-skill',
    'control-device'
  ],
  methods: {
    switchMode(mode) {
      this.$emit('update:activeMode', mode);
      if (mode === 'travel') {
        this.$emit('update:activeTab', 'history');
      } else {
        this.$emit('update:activeTab', 'device');
      }
    },
    switchTab(tab) {
      this.$emit('update:activeTab', tab);
    },
    getRelativeTime(timeStr) {
      if (!timeStr) return '';
      const date = new Date(timeStr.replace('Z', '+00:00'));
      const now = new Date();
      const diff = Math.floor((now - date) / 1000);
      if (diff < 60) return '刚刚';
      if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
      if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
      return `${Math.floor(diff / 86400)} 天前`;
    }
  },
  template: `
    <aside class="sidebar" :style="{ width: sidebarCollapsed ? '0px' : '', opacity: sidebarCollapsed ? '0' : '1', borderRight: sidebarCollapsed ? '0px' : '' }">
      <div class="sidebar-header">
        <div class="brand">
          <div class="brand-mark">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          </div>
          <div>
            <h1>智能旅游规划</h1>
            <p>LangChain + DeepSeek</p>
          </div>
        </div>
        <button class="sidebar-toggle-btn" type="button" title="收起侧边栏" @click="$emit('toggle-sidebar')">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
      </div>

      <!-- Mode Switcher Segmented Control -->
      <div class="mode-switcher-container">
        <button class="mode-switch-btn" :class="{ active: activeMode === 'travel' }" @click="switchMode('travel')" type="button" title="进入智能出行规划模式">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 5px;"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          <span>出行助手</span>
        </button>
        <button class="mode-switch-btn" :class="{ active: activeMode === 'edge' }" @click="switchMode('edge')" type="button" title="进入昇腾边云协同监控模式">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 5px;"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M7 10v4h2v-4H7zm8 0v4h2v-4h-2z"/><path d="M12 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>
          <span>边云协同</span>
        </button>
      </div>

      <!-- Tabs Segmented Control depending on Active Mode -->
      <div class="sidebar-tabs">
        <template v-if="activeMode === 'travel'">
          <button class="tab-btn" :class="{ active: activeTab === 'history' }" @click="switchTab('history')" type="button" title="会话历史">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span>历史</span>
          </button>
          <button class="tab-btn" :class="{ active: activeTab === 'skills' }" @click="switchTab('skills')" type="button" title="技能面板">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z"/></svg>
            <span>技能</span>
          </button>
          <button class="tab-btn" :class="{ active: activeTab === 'status' }" @click="switchTab('status')" type="button" title="运行配置">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="3" rx="2" ry="2"/><rect width="20" height="8" x="2" y="13" rx="2" ry="2"/><line x1="6" x2="6.01" y1="7" y2="7"/><line x1="6" x2="6.01" y1="17" y2="17"/></svg>
            <span>状态</span>
          </button>
        </template>
        <template v-else>
          <button class="tab-btn active" type="button" title="边缘侧设备监控">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M7 10v4h2v-4H7zm8 0v4h2v-4h-2z"/><path d="M12 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>
            <span>设备监控</span>
          </button>
        </template>
      </div>

      <!-- Tab Content Area -->
      <div class="sidebar-tab-content-wrapper" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column;">
        <!-- Travel Mode - History Tab -->
        <div v-if="activeMode === 'travel' && activeTab === 'history'" class="sidebar-tab-content active">
          <section class="history-panel">
            <div class="history-header">
              <div class="section-label">历史会话</div>
              <button id="newChatBtn" @click="$emit('new-chat')" type="button">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>
                <span>新建会话</span>
              </button>
            </div>
            <div class="conversation-list">
              <div v-if="!conversations.length" class="history-empty">暂无历史会话</div>
              <div v-for="conv in conversations" 
                   :key="conv.id" 
                   class="conversation-item" 
                   :class="{ active: conv.id === activeConversationId }"
                   @click="$emit('select-conversation', conv.id)">
                <div class="conversation-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <div class="conversation-info">
                  <div class="conversation-title" :title="conv.title">{{ conv.title || '新对话' }}</div>
                  <div class="conversation-meta">{{ conv.message_count || 0 }} 消息</div>
                </div>
                <button class="delete-chat-btn" type="button" title="删除" @click.stop="$emit('delete-conversation', conv.id)">×</button>
              </div>
            </div>
          </section>
        </div>

        <!-- Travel Mode - Skills Tab -->
        <div v-if="activeMode === 'travel' && activeTab === 'skills'" class="sidebar-tab-content active">
          <section class="skills-panel">
            <div class="section-label">智能技能插件</div>
            <div class="skills-list">
              <div v-if="!skills.length" class="skill-empty">读取中...</div>
              <div v-for="skill in skills" :key="skill.name" class="skill-card" :data-skill-name="skill.name">
                <div class="skill-card-head">
                  <h3>{{ skill.display_name || skill.name || 'Skill' }}</h3>
                  <button class="skill-use-btn" type="button" @click="$emit('use-skill', skill)">使用</button>
                </div>
                <p>{{ skill.description || '' }}</p>
                <span class="skill-call">{{ skill.explicit_call || ('@' + (skill.display_name || skill.name)) }}</span>
                <div v-if="skill.tools && skill.tools.length" class="skill-tools">
                  <span v-for="tool in skill.tools.slice(0, 4)" :key="tool">{{ tool }}</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- Travel Mode - Config Status Tab -->
        <div v-if="activeMode === 'travel' && activeTab === 'status'" class="sidebar-tab-content active">
          <section class="status-panel">
            <h2>运行配置与服务状态</h2>
            <div class="status-row">
              <span>基础模型</span>
              <strong>{{ systemStatus.model || '读取中...' }}</strong>
            </div>
            <div class="status-row">
              <span>思考模型</span>
              <strong>{{ systemStatus.thinking_model || '读取中...' }}</strong>
            </div>
            <div class="status-row">
              <span>LLM API Key</span>
              <strong :style="{ color: systemStatus.api_key_loaded ? '#10b981' : '' }">
                {{ systemStatus.api_key_loaded ? '已配置' : '未配置' }}
              </strong>
            </div>
            <div class="status-row">
              <span>高德地图 API</span>
              <strong :style="{ color: systemStatus.amap_key_loaded ? '#10b981' : '' }">
                {{ systemStatus.amap_key_loaded ? '已配置' : '未配置' }}
              </strong>
            </div>
            <div class="status-row">
              <span>和风天气 API</span>
              <strong :style="{ color: systemStatus.qweather_key_loaded ? '#10b981' : '' }">
                {{ systemStatus.qweather_key_loaded ? (systemStatus.qweather_host_loaded ? '已配置' : '缺少 Host') : '未配置' }}
              </strong>
            </div>
            <div class="status-row">
              <span>12306 查票服务</span>
              <strong :style="{ color: systemStatus.train_tools_available ? '#10b981' : '' }">
                {{ systemStatus.train_tools_available ? '可用' : '未检测到' }}
              </strong>
            </div>
            <div class="status-row">
              <span>Aviation 航班</span>
              <strong :style="{ color: systemStatus.aviationstack_key_loaded ? '#10b981' : '' }">
                {{ systemStatus.aviationstack_key_loaded ? '已配置' : '未配置' }}
              </strong>
            </div>
            <div class="status-row">
              <span>Rapid 酒店价格</span>
              <strong :style="{ color: systemStatus.rapidapi_key_loaded ? '#10b981' : '' }">
                {{ systemStatus.rapidapi_key_loaded ? '已配置' : '未配置' }}
              </strong>
            </div>
            <div class="status-row">
              <span>默认出发地定位</span>
              <strong>{{ locationStatusText }}</strong>
            </div>
          </section>
        </div>

        <!-- Edge-Cloud Mode - Device Monitor Tab -->
        <div v-if="activeMode === 'edge'" class="sidebar-tab-content active" style="padding: 16px; display: flex; flex-direction: column; height: 100%; overflow: hidden;">
          
          <!-- Device List Header (Vercel Style) -->
          <div class="device-list-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid var(--line); flex-shrink:0;">
            <span style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted);">
              设备状态 ({{ devices.filter(d => d.online).length }}/{{ devices.length }})
            </span>
          </div>

          <!-- Device status scrollable area -->
          <div class="edge-devices-dashboard-grid" style="flex: 1; overflow-y: auto; padding-right: 4px; display: block; margin-bottom: 12px;">
            <div v-if="!devices.length" class="edge-empty" style="text-align: center; padding: 20px;">
              <p style="margin-bottom: 8px;">暂无边端设备状态</p>
            </div>
            
            <div v-for="device in devices.slice(0, 1)" :key="device.device_id" class="edge-device-detail-view" style="display:flex; flex-direction:column; gap:16px;">
              <div class="device-card-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; padding-bottom:8px; border-bottom:1px solid var(--line);">
                <div class="device-name-area">
                  <h4 style="margin:0; font-size:14px; font-weight:700; color:var(--text)">
                    {{ device.device_id }}
                  </h4>
                  <span style="font-size:11px; color:var(--muted)">主机: {{ device.hostname }}</span>
                </div>
                <span class="device-status-badge" :class="device.online ? 'online' : 'offline'">
                  {{ device.online ? '在线' : '离线' }}
                </span>
              </div>
              
              <div class="device-card-metrics">
                <div class="device-metric-group">
                  <h5 style="margin:0 0 6px 0; font-size:12px; font-weight:600; color:var(--text)">⚡ 边端 YOLO 推理性能</h5>
                  <div class="device-perf-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:8px; background:rgba(100,116,139,0.04); padding:8px; border-radius:6px; border:none;">
                    <div><span style="font-size:10px; color:var(--muted); display:block;">帧率 (FPS)</span><strong style="font-size:12px; color:var(--text)">{{ device.online && device.latest_fps ? device.latest_fps + ' FPS' : '无数据' }}</strong></div>
                    <div><span style="font-size:10px; color:var(--muted); display:block;">延迟 (Latency)</span><strong style="font-size:12px; color:var(--text)">{{ device.online && device.latest_latency_ms ? device.latest_latency_ms + ' ms' : '无数据' }}</strong></div>
                  </div>
                </div>
                
                <div class="device-metric-group" style="margin-top:8px;">
                  <h5 style="margin:0 0 6px 0; font-size:12px; font-weight:600; color:var(--text)">📊 硬件指标实时状态</h5>
                  
                  <!-- CPU Load -->
                  <div class="device-metric-row" data-tooltip="系统平均负载 (Loadavg 1m)：过去1分钟内处于可运行或等待状态的平均任务数。">
                    <div class="metric-row-label">
                      <span>📈 系统平均负载 (CPU Load 1m)</span>
                      <strong v-if="device.online && device.system_metrics.loadavg">
                        {{ Math.min(100, Math.round((parseFloat(device.system_metrics.loadavg['1m'] || device.system_metrics.loadavg.split?.(' ')[0] || 0)) * 33)) }}%
                        <small style="color:var(--muted); font-weight:400;">(负载: {{ device.system_metrics.loadavg['1m'] || device.system_metrics.loadavg.split?.(' ')[0] || 0 }})</small>
                      </strong>
                      <strong v-else>无数据</strong>
                    </div>
                    <div class="metric-progress-bg">
                      <div class="metric-progress-fill cpu" :style="{ width: device.online && device.system_metrics.loadavg ? Math.min(100, Math.round((parseFloat(device.system_metrics.loadavg['1m'] || device.system_metrics.loadavg.split?.(' ')[0] || 0)) * 33)) + '%' : '0%' }"></div>
                    </div>
                  </div>
                  
                  <!-- RAM Memory -->
                  <div class="device-metric-row" data-tooltip="系统内存使用率：当前使用的物理内存比例。">
                    <div class="metric-row-label">
                      <span>💾 系统内存使用率 (RAM Memory)</span>
                      <strong v-if="device.online && device.system_metrics.memory">
                        {{ device.system_metrics.memory.used_percent }}%
                        <small style="color:var(--muted); font-weight:400;">({{ device.system_metrics.memory.available_mb }}MB 可用)</small>
                      </strong>
                      <strong v-else>无数据</strong>
                    </div>
                    <div class="metric-progress-bg">
                      <div class="metric-progress-fill memory" :style="{ width: device.online && device.system_metrics.memory ? device.system_metrics.memory.used_percent + '%' : '0%' }"></div>
                    </div>
                  </div>
                  
                  <!-- NPU Core -->
                  <div v-if="device.online && device.system_metrics.npu" class="device-metric-row" data-tooltip="昇腾 NPU 核心利用率：达芬奇架构 AI Core 的计算负载。">
                    <div class="metric-row-label">
                      <span>🧠 昇腾 NPU 核心利用率</span>
                      <strong>
                        {{ device.system_metrics.npu.utilization_percent }}%
                        <small style="color:var(--muted); font-weight:400;">(温度: {{ device.system_metrics.npu.temperature_c }}℃)</small>
                      </strong>
                    </div>
                    <div class="metric-progress-bg">
                      <div class="metric-progress-fill npu" :style="{ width: device.system_metrics.npu.utilization_percent + '%' }"></div>
                    </div>
                  </div>
                  
                  <!-- NPU Hugepages -->
                  <div v-if="device.online && device.system_metrics.npu" class="device-metric-row" data-tooltip="昇腾 NPU 大页内存：系统为 NPU 算力核心加速配置的 Hugepages。当前已分配 15 个大页，均由昇腾驱动预留，属于板端标准运行状态，并非显存不足。">
                    <div class="metric-row-label">
                      <span>🧠 NPU 大页内存 (Hugepages)</span>
                      <strong>
                        {{ device.system_metrics.npu.memory_used_mb / device.system_metrics.npu.memory_total_mb * 100 }}%
                        <small style="color:var(--muted); font-weight:400;">(100% 预留)</small>
                      </strong>
                    </div>
                    <div class="metric-progress-bg">
                      <div class="metric-progress-fill npu" :style="{ width: (device.system_metrics.npu.memory_used_mb / device.system_metrics.npu.memory_total_mb * 100) + '%' }"></div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="device-card-footer" style="margin-top:12px; padding-top:8px; border-top:1px solid var(--line); font-size:10px; color:var(--muted);">
                <span>最近活跃: {{ device.latest_image_id || '无任务' }} · {{ device.age_seconds != null ? device.age_seconds + ' 秒前' : '无记录' }}</span>
              </div>
            </div>
          </div>

          <!-- Board SSH Control Panel (Pinned at the bottom!) -->
          <div class="board-control-section" style="padding-top:16px; border-top:1px solid var(--line); flex-shrink: 0; background: transparent;">
            <h5 style="margin:0 0 10px 0; font-size:12px; font-weight:700; color:var(--text); display:flex; align-items:center; gap:6px;">
              <span>🔌 板端 SSH 物理控制</span>
            </h5>
            <div class="board-control-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <button class="control-btn" type="button" @click="$emit('control-device', 'start_heartbeat')" style="padding:6px 8px; font-size:11px; font-weight:600; border:1px solid rgba(59,130,246,0.3); border-radius:6px; background:rgba(59,130,246,0.05); color:var(--accent); cursor:pointer; transition:all 0.2s;">启动后台心跳</button>
              <button class="control-btn" type="button" @click="$emit('control-device', 'stop_heartbeat')" style="padding:6px 8px; font-size:11px; font-weight:600; border:1px solid rgba(239,68,68,0.3); border-radius:6px; background:rgba(239,68,68,0.05); color:#ef4444; cursor:pointer; transition:all 0.2s;">停止后台心跳</button>
              <button class="control-btn" type="button" @click="$emit('control-device', 'trigger_heartbeat')" style="padding:6px 8px; font-size:11px; font-weight:600; border:1px solid var(--line); border-radius:6px; background:var(--panel-solid); color:var(--text); cursor:pointer; grid-column:span 2; transition:all 0.2s;">⚡ 单次即时上报心跳</button>
              <button class="control-btn" type="button" @click="$emit('control-device', 'run_yolo')" style="padding:8px; font-size:11px; font-weight:700; border:1px solid var(--accent); border-radius:6px; background:var(--accent); color:white; cursor:pointer; grid-column:span 2; transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:4px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                远程运行 YOLO 推理
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  `
};
