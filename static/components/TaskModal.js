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
  data() {
    return {
      isZoomed: false,
      activeFrameIdx: 0
    };
  },
  watch: {
    taskId() {
      this.activeFrameIdx = 0;
      this.isZoomed = false;
    }
  },
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
  computed: {
    zoomFrameCount() {
      var evt = this.taskDetail && this.taskDetail.event;
      var frames = evt && evt.frames;
      return (Array.isArray(frames) && frames.length) || 0;
    },
    zoomSrc() {
      if (this.zoomFrameCount > 0) {
        return this.taskDetail.event.frames[this.activeFrameIdx].annotated_image_url;
      }
      var evt = this.taskDetail && this.taskDetail.event;
      return (evt && evt.annotated_image_url) || '';
    },
    hasMultipleFrames() { return this.zoomFrameCount > 1; }
  },
  template: `
    <div class="modal-overlay" :hidden="!isOpen" @click="$emit('close')" style="z-index: 1000;">
      <div class="modal-dialog" @click.stop="" style="max-height: 90vh; overflow-y: auto;">
        <header class="modal-header">
          <h3 id="modalTaskTitle" style="display: flex; align-items: center; gap: 8px;">
            <span :style="taskDetail && taskDetail.media_type === 'video' ? 'background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe;' : 'background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0;'" style="font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-family: sans-serif;">
              {{ taskDetail && taskDetail.media_type === 'video' ? '🎥 视频' : '🖼️ 图片' }}
            </span>
            <span>任务详情: {{ taskDetail ? (taskDetail.image_id || taskDetail.event?.image_id || '未命名') : '' }}</span>
          </h3>
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
                <div><span>媒体类型</span><strong>{{ taskDetail.media_type === 'video' ? '🎥 视频 (Video)' : '🖼️ 图片 (Image)' }}</strong></div>
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
            
            <!-- 3. Annotated Image / Video Frames -->
            <section v-if="taskDetail.event?.annotated_image_url || (taskDetail.event?.frames && taskDetail.event.frames.length)" class="modal-section">
              <h4 class="modal-section-title">
                {{ taskDetail.media_type === 'video' ? '🎥 视频帧序列标注图像 (点击可放大)' : '🖼️ 标注图像 (点击可放大)' }}
              </h4>
              
              <!-- Video Mode Frames Slider -->
              <div v-if="taskDetail.media_type === 'video' && taskDetail.event?.frames && taskDetail.event.frames.length" style="display:flex; flex-direction:column; gap:8px;">
                <div class="modal-image-container" style="position: relative; cursor: zoom-in;" @click="isZoomed = true">
                  <img class="modal-annotated-image" 
                       :src="taskDetail.event.frames[activeFrameIdx].annotated_image_url" 
                       alt="YOLO Annotated Result" 
                       style="max-width:100%; border-radius:8px; display:block; margin:0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                  <div class="image-zoom-hint" style="position: absolute; right: 10px; bottom: 10px; background: rgba(0,0,0,0.65); color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; pointer-events: none;">
                    🔍 点击放大帧 {{ (activeFrameIdx) + 1 }}
                  </div>
                </div>
                <!-- Frame Thumbnails Grid -->
                <div style="display:flex; flex-wrap:wrap; gap:6px; padding:4px 0; max-height:220px; overflow-y:auto;">
                  <div v-for="(frame, fIdx) in taskDetail.event.frames"
                       :key="fIdx"
                       @click="activeFrameIdx = fIdx"
                       :style="{
                         width: '80px',
                         height: '56px',
                         borderRadius: '6px',
                         overflow: 'hidden',
                         cursor: 'pointer',
                         border: activeFrameIdx === fIdx ? '2px solid var(--accent)' : '1px solid var(--line)',
                         opacity: activeFrameIdx === fIdx ? '1' : '0.7',
                         transition: 'all 0.15s ease'
                       }">
                    <img :src="frame.annotated_image_url" style="width:100%; height:100%; object-fit:cover;">
                  </div>
                </div>
              </div>
              
              <!-- Image Mode -->
              <div v-else class="modal-image-container" style="position: relative; cursor: zoom-in;" @click="isZoomed = true">
                <img class="modal-annotated-image" :src="taskDetail.event.annotated_image_url" alt="YOLO Annotated Result" style="max-width:100%; border-radius:8px; display:block; margin:0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                <div class="image-zoom-hint" style="position: absolute; right: 10px; bottom: 10px; background: rgba(0,0,0,0.65); color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; pointer-events: none;">
                  🔍 点击放大
                </div>
              </div>
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

            <!-- 8. Cloud Agent Analysis (DeepSeek text supplement) -->
            <section v-if="taskDetail.analysis && taskDetail.analysis.answer" class="modal-section">
              <h4 class="modal-section-title">🤖 云端 Agent 综合研判</h4>
              <div class="modal-analysis-content" v-html="renderMarkdown(taskDetail.analysis.answer)" style="line-height: 1.6; font-size: 13px; color: var(--text); background: rgba(59,130,246,0.02); padding: 12px; border-radius: 8px; border: 1px solid rgba(59,130,246,0.1);"></div>
            </section>

            <!-- 8b. SenseNova Multimodal Visual Analysis (separate panel) -->
            <section v-if="taskDetail.analysis && taskDetail.analysis.vision_analysis && taskDetail.analysis.vision_analysis.answer" class="modal-section">
              <h4 class="modal-section-title" style="display:flex; align-items:center; gap:8px;">
                <span>🎬 商汤 SenseNova 多模态视觉分析</span>
                <span style="font-weight:400; font-size:11px; color:var(--muted); background:#fef3c7; padding:2px 8px; border-radius:999px;">基于 YOLO 标注图</span>
              </h4>
              <div v-html="renderMarkdown(taskDetail.analysis.vision_analysis.answer)" style="line-height: 1.6; font-size: 13px; color: var(--text); background: rgba(245,158,11,0.03); padding: 12px; border-radius: 8px; border: 1px solid rgba(245,158,11,0.2);"></div>
              <div style="margin-top:8px; font-size:11px; color:var(--muted); display:flex; gap:16px;">
                <span>模型: {{ taskDetail.analysis.vision_analysis.model || 'sensenova-6.7-flash-lite' }}</span>
                <span>Token 用量: {{ taskDetail.analysis.vision_analysis.usage?.total_tokens || taskDetail.analysis.vision_analysis.trace?.[0]?.usage?.total_tokens || 'N/A' }}</span>
                <span>输入: {{ taskDetail.analysis.frame_count || taskDetail.analysis.vision_analysis.frame_count || 1 }} 帧 YOLO 标注图</span>
                <span v-if="taskDetail.analysis.media_type === 'video'">类型: 视频分析</span>
              </div>
            </section>

            <!-- 9. Agent Execution Trace -->
            <section v-if="taskDetail.analysis && taskDetail.analysis.trace && taskDetail.analysis.trace.length" class="modal-section">
              <h4 class="modal-section-title">&#x1f9e0; 智能体执行追踪 (Agent Trace)</h4>
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
                       borderLeft: item.type === 'vision_analysis' ? '4px solid #f59e0b' : (item.type === 'tool_call' ? '4px solid var(--accent)' : '4px solid #10b981')
                     }">
                  <div class="trace-node-icon" style="font-size: 16px;">
                    {{ item.type === 'vision_analysis' ? '🎥' : (item.type === 'tool_call' ? '🔧' : '🤖') }}
                  </div>
                  <div class="trace-node-body" style="flex: 1;">
                    <div class="trace-node-header" style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                      <span class="trace-node-name" style="font-weight: 600;">
                        {{ item.type === 'vision_analysis' ? '🎬 多模态视觉分析 (SenseNova ' + (item.media_type === 'video' ? '视频' : '图片') + ' ' + (item.frame_count || '') + '帧): ' + (item.model || 'sensenova-6.7-flash-lite') : (item.type === 'tool_call' ? '调用工具: ' + item.tool : '模型响应: ' + (item.model || 'unknown')) }}
                      </span>
                      <span class="trace-node-duration" style="font-size: 11px; color: var(--muted);">
                        {{ item.type === 'vision_analysis' ? (item.usage && item.usage.total_tokens ? 'Token: ' + item.usage.total_tokens : '') : (item.type === 'tool_call' ? (item.duration_ms ? item.duration_ms + 'ms' : '') : (item.usage && item.usage.total_tokens ? 'Token 消耗: ' + item.usage.total_tokens : '')) }}
                      </span>
                    </div>
                    <div class="trace-node-details" style="font-size: 12px; color: var(--muted); word-break: break-all;">
                      {{ item.type === 'vision_analysis' ? '模型: ' + (item.model || 'sensenova-6.7-flash-lite') + ' | 状态: ' + (item.status || 'success') + ' | 输入: ' + (item.media_type === 'video' ? (item.frame_count || '?') + ' 帧标注图' : '单张标注图') : (item.type === 'tool_call' ? '参数: ' + JSON.stringify(item.args) : '状态: ' + (item.status || 'Success')) }}
                    </div>
                    <div v-if="item.type === 'tool_call' && item.result"
                         class="trace-node-details"
                         style="font-size: 12px; color: var(--text); margin-top: 4px; word-break: break-all;">
                      <strong>返回:</strong> {{ item.result.length > 500 ? item.result.substring(0, 500) + '...' : item.result }}
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
    <!-- Zoom Lightbox: teleported to <body> to escape .app-shell backdrop-filter containment -->
    <teleport to="body">
      <div v-if="isZoomed" class="zoom-lightbox" @click.stop="isZoomed = false" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.95); display: flex; align-items: center; justify-content: center; z-index: 3000; cursor: zoom-out;">
        <img :src="zoomSrc" @click.stop style="max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 4px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
        <div v-if="hasMultipleFrames" style="position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,0.6); font-size: 13px;">
          帧 {{ activeFrameIdx + 1 }} / {{ zoomFrameCount }}
        </div>
        <button @click.stop="isZoomed = false" style="position: absolute; top: 20px; right: 20px; background: rgba(255,255,255,0.25); color: white; border: none; border-radius: 50%; width: 44px; height: 44px; font-size: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); transition: all 0.2s;">&times;</button>
      </div>
    </teleport>
  `
};
