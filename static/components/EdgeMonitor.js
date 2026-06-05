// EdgeMonitor Component - Handles the collaborative inference tasks flow list.

export default {
  name: 'EdgeMonitor',
  props: {
    tasks: { type: Array, default: () => [] },
    sidebarCollapsed: { type: Boolean, default: false }
  },
  emits: ['open-task', 'run-analysis', 'refresh-tasks', 'toggle-sidebar'],
  data() {
    return {
      expandedTaskId: null
    };
  },
  methods: {
    toggleExpand(taskId) {
      this.expandedTaskId = this.expandedTaskId === taskId ? null : taskId;
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
    },
    parseClassCounts(counts) {
      if (!counts) return '';
      const entries = Object.entries(counts);
      if (!entries.length) return '';
      return entries.map(([name, count]) => `${name}:${count}`).join(' / ');
    },
    parseAgentAnalysis(answer) {
      if (!answer) return null;
      try {
        let riskLevel = "低风险";
        if (answer.includes("高风险")) riskLevel = "高风险";
        else if (answer.includes("中风险")) riskLevel = "中风险";
        
        let semantics = "";
        const semMatch = answer.match(/(?:场景理解|场景语义分析|图像语义|场景分析)[:：\s]*\n*([^#\n]+)/);
        if (semMatch) semantics = semMatch[1].trim();
        else {
          const firstLine = answer.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.includes('风险'));
          semantics = firstLine ? firstLine.trim() : "无异常静态场景";
        }
        
        const advice = [];
        const advMatches = answer.matchAll(/(?:处置建议|建议|策略)[:：\s]*\n*(?:[-*\d.\s]+([^\n#]+)\n*)+/gi);
        // Fallback simple line scanning
        const lines = answer.split('\n');
        let inAdviceSection = false;
        for (const line of lines) {
          const l = line.trim();
          if (l.includes("处置建议") || l.includes("处置策略")) {
            inAdviceSection = true;
            continue;
          }
          if (inAdviceSection) {
            if (l.startsWith('#')) {
              inAdviceSection = false;
              continue;
            }
            const clean = l.replace(/^[-*\d.\s]+/, '').trim();
            if (clean) advice.push(clean);
          }
        }
        if (!advice.length) {
          advice.push("继续保持边缘本地监控；");
          advice.push("系统运行状况良好，无需干预。");
        }
        return { riskLevel, semantics, advice };
      } catch (err) {
        return null;
      }
    }
  },
  template: `
    <section class="edge-cloud-panel" style="display: flex; flex-direction: column;">
      <header class="chat-header">
        <div class="chat-header-title-area">
          <button v-if="sidebarCollapsed" class="sidebar-toggle-btn expand-btn" type="button" title="展开侧边栏" @click="$emit('toggle-sidebar')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>
          <h2>昇腾边云协同控制中心 (Ascend Edge-Cloud Monitor Console)</h2>
        </div>
        <button class="dashboard-refresh-btn" type="button" @click="$emit('refresh-tasks')">刷新任务流</button>
      </header>
      
      <div class="dashboard-container edge-full-tasks-layout" style="padding: 20px; flex: 1; overflow: hidden; display: flex; flex-direction: column;">
        <!-- Tasks Grid (Occupies full 100% width) -->
        <div class="dashboard-column task-column full-width" style="flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;">
          <h3 class="dashboard-column-title" style="display:flex; align-items:center; gap:8px;">
            <span class="icon">⏳</span>
            <span>最新协同推理与分析任务流 (共 {{ tasks.length }} 个事件)</span>
          </h3>
          
          <div class="edge-tasks-history-list">
            <div v-if="!tasks.length" class="edge-empty" style="text-align:center; padding:40px; color:var(--muted)">
              暂无协同推理任务
            </div>
            
            <div v-for="task in tasks" 
                 :key="task.id" 
                 class="edge-task-history-item"
                 :class="{ expanded: expandedTaskId === task.id }">
              
              <!-- Collapsed Header View -->
              <div class="history-item-header" @click="toggleExpand(task.id)">
                <div class="header-left">
                  <span class="status-dot" :class="task.status === 'completed' ? 'completed' : 'received'"></span>
                  <strong class="task-title">{{ task.image_id || task.event?.image_id || 'world_cup.jpg' }}</strong>
                  <span class="task-device-id">设备: {{ task.device_id || task.event?.device_id || 'unknown' }}</span>
                  <span v-if="task.created_at" class="task-time" :title="'绝对时间: ' + task.created_at">
                    ⏰ {{ getRelativeTime(task.created_at) }}
                  </span>
                </div>
                <div class="header-right">
                  <span v-if="task.event?.edge_decision?.need_cloud_analysis" class="mode-badge cloud">☁️ 边云协同</span>
                  <span v-else class="mode-badge local">💻 边端自闭环</span>
                  <span class="status-chip" :class="task.status === 'completed' ? 'completed' : 'received'">
                    {{ task.status === 'completed' ? '已分析' : '已接收' }}
                  </span>
                  <span class="arrow-icon">
                    <svg v-if="expandedTaskId === task.id" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                    <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  </span>
                </div>
              </div>
              
              <!-- Expanded Content View -->
              <div v-if="expandedTaskId === task.id" class="history-item-content">
                <div class="content-grid">
                  <!-- Left column: Image & Caption -->
                  <div class="content-left">
                    <div class="edge-task-image-container" style="height: 200px;">
                      <img v-if="task.event?.annotated_image_url" 
                           class="edge-task-image" 
                           :src="task.event.annotated_image_url" 
                           alt="YOLO Result" 
                           loading="lazy">
                      <div v-else class="edge-task-image-fallback">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                        <span>无有效标注图</span>
                      </div>
                    </div>
                    <div style="text-align: center; margin-top: 8px; font-size: 11px; color: var(--muted); line-height: 1.4;">
                      分析源图像: <code>/home/HwHiAiUser/samples/notebooks/01-yolov5/world_cup.jpg</code>
                    </div>
                  </div>
                  
                  <!-- Right column: Pipeline & Agent Analysis -->
                  <div class="content-right">
                    <!-- Timeline Workflow Pipeline -->
                    <div class="edge-pipeline" style="margin-top:0;">
                      <!-- Step 1 -->
                      <div class="pipeline-step completed">
                        <div class="step-indicator">
                          <span class="step-dot">1</span>
                          <span class="step-line"></span>
                        </div>
                        <div class="step-content">
                          <div class="step-title">边端本地 YOLO 推理</div>
                          <div class="step-desc">
                            检测结果: <strong>{{ parseClassCounts(task.event?.summary?.class_counts) || 'total:' + (task.event?.summary?.total_count || 0) }}</strong>
                            ({{ task.event?.inference?.fps ? task.event.inference.fps + ' FPS' : (task.event?.inference?.latency_ms ? task.event.inference.latency_ms + ' ms' : '无性能数据') }})
                          </div>
                        </div>
                      </div>
                      
                      <!-- Step 2 -->
                      <div class="pipeline-step completed">
                        <div class="step-indicator">
                          <span class="step-dot">2</span>
                          <span class="step-line"></span>
                        </div>
                        <div class="step-content">
                          <div class="step-title">协同调度判定</div>
                          <div class="step-desc">
                            决策: <strong :class="task.event?.edge_decision?.need_cloud_analysis ? 'text-cloud' : 'text-local'">
                              {{ task.event?.edge_decision?.need_cloud_analysis ? '数据上云分析' : '本地闭环处理' }}
                            </strong>
                            <div v-if="task.event?.edge_decision?.reason" class="step-reason">{{ task.event.edge_decision.reason }}</div>
                          </div>
                        </div>
                      </div>
                      
                      <!-- Step 3 -->
                      <div class="pipeline-step" :class="task.analysis ? 'completed' : (task.event?.edge_decision?.need_cloud_analysis ? 'pending' : 'skipped')">
                        <div class="step-indicator">
                          <span class="step-dot">3</span>
                        </div>
                        <div class="step-content">
                          <div class="step-title">云端智能体决策</div>
                          <div class="step-desc">
                            {{ task.analysis ? '场景深度理解与推荐策略已生成' : (task.event?.edge_decision?.need_cloud_analysis ? '正在等待云端 Agent 运行决策分析...' : '本地推理置信度充足，无需触发云端 Agent') }}
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    <!-- Agent Analysis Card Box -->
                    <div v-if="task.analysis && parseAgentAnalysis(task.analysis.answer)" class="agent-analysis-card-box" style="margin-top:8px;">
                      <div class="agent-box-header">
                        <span class="agent-avatar-mini">🤖</span>
                        <strong>云端 Agent 智能研判结果</strong>
                        <span class="risk-badge-mini" :class="parseAgentAnalysis(task.analysis.answer).riskLevel === '高风险' ? 'high' : (parseAgentAnalysis(task.analysis.answer).riskLevel === '中风险' ? 'medium' : 'low')">
                          {{ parseAgentAnalysis(task.analysis.answer).riskLevel }}
                        </span>
                      </div>
                      <div class="agent-box-body">
                        <p class="analysis-semantics"><strong>💡 场景理解：</strong>{{ parseAgentAnalysis(task.analysis.answer).semantics }}</p>
                        <div v-if="parseAgentAnalysis(task.analysis.answer).advice.length" class="analysis-advice-list">
                          <strong>🛠️ 处置建议：</strong>
                          <ul>
                            <li v-for="adv in parseAgentAnalysis(task.analysis.answer).advice.slice(0, 2)" :key="adv">{{ adv }}</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                    <div v-else-if="task.event?.edge_decision?.need_cloud_analysis && !task.analysis" class="agent-analysis-card-box" style="border-style:dashed; text-align:center; color:var(--muted); margin-top:8px;">
                      <div class="agent-box-body" style="padding: 10px 0;">
                        <p>🤖 等待云端 Agent 智能决策分析...</p>
                      </div>
                    </div>
                  </div>
                </div>
                
                <!-- Actions -->
                <div class="history-item-actions">
                  <button type="button" class="edge-details-btn" @click.stop="$emit('open-task', task.id)" style="margin-right: auto; padding: 6px 12px;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: middle;"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="16" y2="12"/><line x1="12" x2="12.01" y1="8" y2="8"/></svg>
                    详细信息
                  </button>
                  <a class="edge-report-link" :href="'/api/edge/tasks/' + encodeURIComponent(task.id) + '/report'" target="_blank" @click.stop="" style="text-align:center; padding:6px 14px; border:1px solid var(--line); border-radius:6px; font-size:12px; font-weight:600; text-decoration:none; color:var(--text); background:#f8fafc; display: flex; align-items: center; gap: 4px;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                    导出报告
                  </a>
                  <button type="button" class="edge-analyze-btn" @click.stop="$emit('run-analysis', task.id)" style="padding:6px 14px; border:1px solid var(--line); border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; background:var(--accent); color:white; display: flex; align-items: center; gap: 4px;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"/></svg>
                    {{ task.analysis ? '重新研判' : '云端分析' }}
                  </button>
                </div>
              </div>
              
            </div>
          </div>
        </div>
      </div>
    </section>
  `
};
