// TaskModal Component - Detailed task analysis, annotated images, detection list, and metrics popup.

export default {
  name: 'TaskModal',
  props: {
    isOpen: { type: Boolean, default: false },
    taskId: { type: String, default: '' },
    taskDetail: { type: Object, default: () => null },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' }
  },
  emits: ['close', 'run-analysis'],
  methods: {
    escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    },
    parseClassCounts(counts) {
      if (!counts) return '';
      const entries = Object.entries(counts);
      if (!entries.length) return '';
      return entries.map(([name, count]) => `${name}:${count}`).join(', ');
    },
    renderMarkdown(md) {
      if (!md) return '无研判内容。';
      try {
        return marked.parse(md);
      } catch (e) {
        return md;
      }
    }
  },
  template: `
    <div class="modal-overlay" :hidden="!isOpen" @click="$emit('close')" style="z-index: 1000;">
      <div class="modal-dialog" @click.stop="" style="max-height: 90vh; overflow-y: auto;">
        <header class="modal-header">
          <h3 id="modalTaskTitle">任务详情: {{ taskDetail ? (taskDetail.image_id || taskDetail.event?.image_id || '未命名') : '' }}</h3>
          <button id="modalCloseBtn" type="button" class="modal-close-btn" @click="$emit('close')">&times;</button>
        </header>
        
        <div id="modalBody" class="modal-body">
          <div v-if="loading" class="modal-loading">加载任务详情...</div>
          <div v-else-if="error" class="modal-error">加载失败: {{ error }}</div>
          <div v-else-if="taskDetail">
            
            <!-- 1. Basic Info -->
            <section class="modal-section">
              <h4 class="modal-section-title">基本信息</h4>
              <div class="modal-info-grid">
                <div><span>任务 ID</span><code>{{ taskDetail.id }}</code></div>
                <div><span>设备 ID</span>{{ taskDetail.device_id || taskDetail.event?.device_id || 'unknown' }}</div>
                <div><span>主机名</span>{{ taskDetail.event?.hostname || 'unknown' }}</div>
                <div><span>图片 ID</span>{{ taskDetail.image_id || taskDetail.event?.image_id || '' }}</div>
                <div><span>来源</span>{{ taskDetail.source_type || taskDetail.event?.source_type || 'edge' }}</div>
                <div><span>状态</span><strong>{{ taskDetail.status === 'completed' ? '已分析' : (taskDetail.status || '已接收') }}</strong></div>
                <div><span>创建时间</span>{{ taskDetail.created_at }}</div>
                <div><span>更新时间</span>{{ taskDetail.updated_at }}</div>
              </div>
            </section>
            
            <!-- 2. Performance -->
            <section class="modal-section">
              <h4 class="modal-section-title">推理性能</h4>
              <div class="modal-metrics-grid">
                <div class="modal-metric"><div>模型</div><strong>{{ taskDetail.event?.inference?.model || 'N/A' }}</strong></div>
                <div class="modal-metric"><div>延迟</div><strong>{{ taskDetail.event?.inference?.latency_ms != null ? taskDetail.event.inference.latency_ms + ' ms' : 'N/A' }}</strong></div>
                <div class="modal-metric"><div>FPS</div><strong>{{ taskDetail.event?.inference?.fps != null ? taskDetail.event.inference.fps : 'N/A' }}</strong></div>
                <div class="modal-metric"><div>置信度阈值</div><strong>{{ taskDetail.event?.inference?.conf_thres != null ? taskDetail.event.inference.conf_thres : 'N/A' }}</strong></div>
                <div class="modal-metric"><div>IoU 阈值</div><strong>{{ taskDetail.event?.inference?.iou_thres != null ? taskDetail.event.inference.iou_thres : 'N/A' }}</strong></div>
              </div>
            </section>
            
            <!-- 3. Annotated Image -->
            <section v-if="taskDetail.event?.annotated_image_url" class="modal-section">
              <h4 class="modal-section-title">标注图像</h4>
              <img class="modal-annotated-image" :src="taskDetail.event.annotated_image_url" alt="YOLO Annotated Result" style="max-width:100%; border-radius:8px;">
            </section>
            
            <!-- 4. Detections -->
            <section v-if="taskDetail.event?.detections && taskDetail.event.detections.length" class="modal-section">
              <h4 class="modal-section-title">检测明细 ({{ taskDetail.event.detections.length }} 个目标)</h4>
              <div class="modal-table-wrap">
                <table class="modal-detection-table">
                  <thead>
                    <tr><th>#</th><th>类别</th><th>类别 ID</th><th>置信度</th><th>边界框</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="(d, i) in taskDetail.event.detections" :key="i">
                      <td>{{ i + 1 }}</td>
                      <td><strong>{{ d.class_name || d.class_id }}</strong></td>
                      <td>{{ d.class_id }}</td>
                      <td>{{ d.confidence != null ? (d.confidence * 100).toFixed(1) + '%' : 'N/A' }}</td>
                      <td>{{ d.bbox ? d.bbox.map(v => v.toFixed(1)).join(', ') : 'N/A' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
            
            <!-- 5. Summary -->
            <section class="modal-section">
              <h4 class="modal-section-title">检测摘要</h4>
              <div class="modal-metrics-grid">
                <div class="modal-metric"><div>总目标数</div><strong>{{ taskDetail.event?.summary?.total_count || 0 }}</strong></div>
                <div class="modal-metric"><div>人数</div><strong>{{ taskDetail.event?.summary?.person_count || 0 }}</strong></div>
                <div class="modal-metric"><div>车辆数</div><strong>{{ taskDetail.event?.summary?.vehicle_count || 0 }}</strong></div>
              </div>
              <div style="font-size:13px; margin-top:8px; color:var(--muted)">
                {{ parseClassCounts(taskDetail.event?.summary?.class_counts) || 'total:' + (taskDetail.event?.summary?.total_count || 0) }}
              </div>
            </section>
            
            <!-- 6. Decision -->
            <section class="modal-section">
              <h4 class="modal-section-title">调度决策</h4>
              <div class="modal-decision">{{ taskDetail.event?.edge_decision?.reason || '无决策原因' }}</div>
              <div class="modal-info-grid">
                <div><span>本地处理</span>{{ taskDetail.event?.edge_decision?.handled_locally ? '是' : '否' }}</div>
                <div><span>云端分析</span><strong>{{ taskDetail.event?.edge_decision?.need_cloud_analysis ? '需要' : '不需要' }}</strong></div>
              </div>
            </section>
            
            <!-- 7. System Metrics -->
            <section v-if="taskDetail.event?.system_metrics && Object.keys(taskDetail.event.system_metrics).length" class="modal-section">
              <h4 class="modal-section-title">边端资源开销</h4>
              
              <!-- CPU Load -->
              <div class="modal-metric-visual-row" style="margin-bottom: 10px;">
                <span class="metric-visual-label" style="display:inline-block; width:120px; font-size:12px;">系统负载 (1m)</span>
                <div class="metric-visual-progress-bg" style="flex:1; height:8px; background:#e2e8f0; border-radius:4px; overflow:hidden; margin: 0 10px;">
                  <div class="metric-visual-progress-fill cpu" :style="{ width: Math.min(100, Math.round((parseFloat(taskDetail.event.system_metrics.loadavg?.['1m'] || taskDetail.event.system_metrics.loadavg?.split?.(' ')[0] || 0)) * 33)) + '%', background:'#3b82f6', height:'100%' }"></div>
                </div>
                <span class="metric-visual-value" style="font-size:12px; width:140px; text-align:right;">负载: {{ taskDetail.event.system_metrics.loadavg?.['1m'] || taskDetail.event.system_metrics.loadavg?.split?.(' ')[0] || 0 }}</span>
              </div>
              
              <!-- Memory -->
              <div v-if="taskDetail.event.system_metrics.memory?.used_percent !== undefined" class="modal-metric-visual-row" style="margin-bottom: 10px;">
                <span class="metric-visual-label" style="display:inline-block; width:120px; font-size:12px;">内存使用率</span>
                <div class="metric-visual-progress-bg" style="flex:1; height:8px; background:#e2e8f0; border-radius:4px; overflow:hidden; margin: 0 10px;">
                  <div class="metric-visual-progress-fill memory" :style="{ width: taskDetail.event.system_metrics.memory.used_percent + '%', background:'#10b981', height:'100%' }"></div>
                </div>
                <span class="metric-visual-value" style="font-size:12px; width:140px; text-align:right;">{{ taskDetail.event.system_metrics.memory.used_percent }}% ({{ taskDetail.event.system_metrics.memory.available_mb }} MB 可用)</span>
              </div>
              
              <!-- NPU Core -->
              <div v-if="taskDetail.event.system_metrics.npu?.utilization_percent !== undefined" class="modal-metric-visual-row" style="margin-bottom: 10px;">
                <span class="metric-visual-label" style="display:inline-block; width:120px; font-size:12px;">NPU 使用率</span>
                <div class="metric-visual-progress-bg" style="flex:1; height:8px; background:#e2e8f0; border-radius:4px; overflow:hidden; margin: 0 10px;">
                  <div class="metric-visual-progress-fill npu" :style="{ width: taskDetail.event.system_metrics.npu.utilization_percent + '%', background:'#f59e0b', height:'100%' }"></div>
                </div>
                <span class="metric-visual-value" style="font-size:12px; width:140px; text-align:right;">{{ taskDetail.event.system_metrics.npu.utilization_percent }}% ({{ taskDetail.event.system_metrics.npu.temperature_c }}℃)</span>
              </div>
              
              <!-- NPU Hugepages -->
              <div v-if="taskDetail.event.system_metrics.npu?.memory_used_percent !== undefined" class="modal-metric-visual-row" style="margin-bottom: 10px;">
                <span class="metric-visual-label" style="display:inline-block; width:120px; font-size:12px;">NPU 大页内存</span>
                <div class="metric-visual-progress-bg" style="flex:1; height:8px; background:#e2e8f0; border-radius:4px; overflow:hidden; margin: 0 10px;">
                  <div class="metric-visual-progress-fill npu" :style="{ width: (taskDetail.event.system_metrics.npu.memory_used_mb / taskDetail.event.system_metrics.npu.memory_total_mb * 100) + '%', background:'#f59e0b', height:'100%' }"></div>
                </div>
                <span class="metric-visual-value" style="font-size:12px; width:140px; text-align:right;">{{ taskDetail.event.system_metrics.npu.memory_used_mb }} / {{ taskDetail.event.system_metrics.npu.memory_total_mb }} 页 (100% 预留)</span>
              </div>
            </section>

            <!-- 8. Cloud Agent Analysis -->
            <section v-if="taskDetail.analysis && taskDetail.analysis.answer" class="modal-section">
              <h4 class="modal-section-title">🤖 云端 Agent 智能研判</h4>
              <div class="modal-analysis-content" v-html="renderMarkdown(taskDetail.analysis.answer)" style="line-height: 1.6; font-size: 13px; color: var(--text); background: rgba(59,130,246,0.02); padding: 12px; border-radius: 8px; border: 1px solid rgba(59,130,246,0.1);"></div>
            </section>

            <!-- 9. Agent Execution Trace -->
            <section v-if="taskDetail.analysis && taskDetail.analysis.trace && taskDetail.analysis.trace.length" class="modal-section">
              <h4 class="modal-section-title">🧠 智能体执行追踪 (Agent Trace)</h4>
              <div class="trace-timeline" style="display: flex; flex-direction: column; gap: 12px; margin-top: 10px;">
                <div v-for="(item, idx) in taskDetail.analysis.trace" :key="idx" 
                     class="trace-node" 
                     :style="{
                       display: 'flex',
                       gap: '12px',
                       padding: '10px 14px',
                       borderRadius: '8px',
                       border: '1px solid var(--line)',
                       background: '#fafbfc',
                       fontSize: '13px',
                       borderLeft: item.type === 'tool_call' ? '4px solid var(--accent)' : '4px solid #10b981'
                     }">
                  <div class="trace-node-icon" style="font-size: 16px;">
                    {{ item.type === 'tool_call' ? '🔧' : '🤖' }}
                  </div>
                  <div class="trace-node-body" style="flex: 1;">
                    <div class="trace-node-header" style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                      <span class="trace-node-name" style="font-weight: 600;">
                        {{ item.type === 'tool_call' ? '调用工具: ' + item.tool : '模型响应: ' + (item.model || 'unknown') }}
                      </span>
                      <span class="trace-node-duration" style="font-size: 11px; color: var(--muted);">
                        {{ item.type === 'tool_call' ? (item.duration_ms ? item.duration_ms + 'ms' : '') : (item.usage?.total_tokens ? 'Token 消耗: ' + item.usage.total_tokens : '') }}
                      </span>
                    </div>
                    <div class="trace-node-details" style="font-size: 12px; color: var(--muted); word-break: break-all;">
                      {{ item.type === 'tool_call' ? '参数: ' + JSON.stringify(item.args) : '状态: ' + (item.status || 'Success') }}
                    </div>
                    <div v-if="item.type === 'tool_call' && item.result" 
                         class="trace-node-details" 
                         style="font-size: 12px; color: var(--text); margin-top: 4px; word-break: break-all;">
                      <strong>返回:</strong> {{ item.result.length > 200 ? item.result.substring(0, 200) + '...' : item.result }}
                    </div>
                  </div>
                </div>
              </div>
            </section>
            
          </div>
        </div>
        
        <footer class="modal-footer" v-if="taskDetail">
          <a class="modal-report-link" :href="'/api/edge/tasks/' + encodeURIComponent(taskDetail.id) + '/report'" target="_blank" rel="noreferrer">导出 Markdown 报告</a>
          <a class="modal-report-link html-report" :href="'/api/edge/tasks/' + encodeURIComponent(taskDetail.id) + '/report/html'" target="_blank" rel="noreferrer">导出 HTML 报告</a>
          <button v-if="!taskDetail.analysis?.answer" id="modalAnalyzeBtn" type="button" class="modal-analyze-btn" @click="$emit('run-analysis', taskDetail.id)">触发云端分析</button>
        </footer>
      </div>
    </div>
  `
};
