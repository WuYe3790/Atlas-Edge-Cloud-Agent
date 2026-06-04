// EdgeMonitor Component - Handles the collaborative inference tasks flow list.

export default {
  name: 'EdgeMonitor',
  props: {
    tasks: { type: Array, default: () => [] },
    sidebarCollapsed: { type: Boolean, default: false }
  },
  emits: ['open-task', 'run-analysis', 'refresh-tasks', 'toggle-sidebar'],
  methods: {
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
            <span>最新协同推理与分析任务流</span>
          </h3>
          
          <div class="edge-tasks-dashboard-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap:20px; padding:20px; flex: 1; overflow-y: auto;">
            <div v-if="!tasks.length" class="edge-empty" style="grid-column: span 3; text-align:center; padding:40px; color:var(--muted)">
              暂无协同推理任务
            </div>
            
            <div v-for="task in tasks.slice(0, 6)" 
                 :key="task.id" 
                 class="edge-task-card" 
                 :data-edge-task-id="task.id"
                 @click="$emit('open-task', task.id)"
                 style="cursor: pointer;">
              
              <!-- Card Image Viewport -->
              <div class="edge-task-image-container">
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
              
              <!-- Card Metadata -->
              <div class="edge-task-main">
                <strong>{{ task.image_id || task.event?.image_id || '未命名图片' }}</strong>
                <span>设备: {{ task.device_id || task.event?.device_id || 'unknown' }}</span>
                <span v-if="task.created_at" class="edge-task-time" :title="'绝对时间: ' + task.created_at" style="font-size:11px; color:var(--muted); margin-top:4px; display:inline-block;">
                  ⏰ {{ getRelativeTime(task.created_at) }}
                </span>
              </div>
              
              <!-- Mode accent badge -->
              <div class="edge-task-meta" style="margin-top:12px; display:flex; justify-content:space-between; align-items:center;">
                <span v-if="task.event?.edge_decision?.need_cloud_analysis" class="edge-cloud-chip on" title="触发协同调度机制，数据上云运行智能体深度决策">
                  ☁️ 边云协同模式 (数据上云)
                </span>
                <span v-else class="edge-cloud-chip off" title="目标置信度充足，由边端本地闭环处理">
                  💻 边端自闭环模式 (本地处理)
                </span>
                <span class="task-row-status-chip" :class="task.status === 'completed' ? 'completed' : 'received'">
                  {{ task.status === 'completed' ? '已分析' : '已接收' }}
                </span>
              </div>
              
              <!-- Timeline Workflow Pipeline -->
              <div class="edge-pipeline" style="margin-top:16px;">
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
              <div v-if="task.analysis && parseAgentAnalysis(task.analysis.answer)" class="agent-analysis-card-box" style="margin-top:16px;">
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
              <div v-else-if="task.event?.edge_decision?.need_cloud_analysis && !task.analysis" class="agent-analysis-card-box" style="border-style:dashed; text-align:center; color:var(--muted); margin-top:16px;">
                <div class="agent-box-body" style="padding: 10px 0;">
                  <p>🤖 等待云端 Agent 智能决策分析...</p>
                </div>
              </div>
              
              <!-- Actions -->
              <div class="edge-task-actions" style="margin-top:12px; display:flex; gap:8px;">
                <a class="edge-report-link" :href="'/api/edge/tasks/' + encodeURIComponent(task.id) + '/report'" target="_blank" @click.stop="" style="flex:1; text-align:center; padding:6px; border:1px solid var(--line); border-radius:6px; font-size:12px; font-weight:600; text-decoration:none; color:var(--text); background:#f8fafc;">导出报告</a>
                <button type="button" class="edge-analyze-btn" @click.stop="$emit('run-analysis', task.id)" style="flex:1; padding:6px; border:1px solid var(--line); border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; background:var(--accent); color:white;">
                  {{ task.analysis ? '重新研判' : '云端分析' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `
};
