// EdgeMonitor Component - Handles the collaborative inference tasks flow list.

export default {
  name: 'EdgeMonitor',
  props: {
    tasks: { type: Array, default: () => [] },
    sidebarCollapsed: { type: Boolean, default: false },
    isTerminalOpen: { type: Boolean, default: false },
    terminalLogs: { type: String, default: '' },
    terminalLoading: { type: Boolean, default: false },
    sshStatus: { type: String, default: 'disconnected' },
    sshStatusText: { type: String, default: '未连接' },
    yoloInferenceStatus: { type: String, default: 'idle' }
  },
  emits: ['open-task', 'run-analysis', 'toggle-sidebar', 'toggle-terminal', 'retry-ssh', 'upload-success', 'log', 'run-uploaded-yolo', 'camera-yolo-started', 'camera-yolo-stopped'],
  data() {
    return {
      expandedTaskId: null,
      isDragging: false,
      uploading: false,
      isUploadPanelOpen: false,
      showConfirmModal: false,
      uploadedFilePath: '',
      activeFrameIdx: 0,
      isZoomed: false,
      zoomedImageUrl: '',
      // Live preview state
      windowHost: location.hostname || '127.0.0.1',
      laptopCameraActive: false,
      cameraControlLoading: false,
      latestFrame: { frame_url: '', fps: 0, detections_count: 0, timestamp: '' },
      framePollTimer: null,
    };
  },
  watch: {
    expandedTaskId() {
      this.activeFrameIdx = 0;
      this.isZoomed = false;
      this.zoomedImageUrl = '';
    },
    yoloInferenceStatus(newVal, oldVal) {
      if (newVal === 'running_board') {
        this.startFramePolling();
      } else if (oldVal === 'running_board' && newVal !== 'running_board') {
        this.stopFramePolling();
      }
    },
  },
  mounted() {
    if (this.yoloInferenceStatus === 'running_board') {
      this.startFramePolling();
    }
    this.checkCameraStatus();
  },
  beforeUnmount() {
    this.stopFramePolling();
  },
  updated() {
    if (this.isTerminalOpen) {
      this.$nextTick(() => {
        const terminalBody = this.$refs.terminalBody;
        if (terminalBody) {
          const threshold = 80;
          const isNearBottom = (terminalBody.scrollHeight - terminalBody.scrollTop - terminalBody.clientHeight) <= threshold;
          if (isNearBottom) {
            terminalBody.scrollTop = terminalBody.scrollHeight;
          }
        }
      });
    }
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
        const semMatch = answer.match(/(?:场景理解|场景语义分析|图像语义|场景分析|场景视觉分析)[:：\s]*\n*([^#\n]+)/);
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
    },
    triggerFileInput() {
      this.$refs.fileInput.click();
    },
    onFileSelected(e) {
      const files = e.target.files;
      if (files.length) {
        this.uploadFile(files[0]);
      }
    },
    onFileDrop(e) {
      this.isDragging = false;
      const files = e.dataTransfer.files;
      if (files.length) {
        this.uploadFile(files[0]);
      }
    },
    async uploadFile(file) {
      this.uploading = true;
      const formData = new FormData();
      formData.append('file', file);
      
      this.$emit('log', `\n[${new Date().toLocaleTimeString()}] [文件上传] 正在读取并准备传输 ${file.name} (大小: ${(file.size/1024/1024).toFixed(2)} MB)...\n`);
      
      try {
        const response = await fetch('/api/edge/upload', {
          method: 'POST',
          body: formData
        });
        const data = await response.json();
        this.uploading = false;
        
        if (data.ok) {
          this.$emit('log', `[${new Date().toLocaleTimeString()}] [成功] ${data.message} | 板端路径: ${data.file_path}\n`);
          this.uploadedFilePath = data.file_path;
          this.showConfirmModal = true;
          this.$emit('upload-success');
        } else {
          this.$emit('log', `[${new Date().toLocaleTimeString()}] [错误] 文件上传失败: ${data.error || '传输失败'}\n`);
          alert(`文件上传失败: ${data.error || '未知错误'}`);
        }
      } catch (err) {
        this.uploading = false;
        this.$emit('log', `[${new Date().toLocaleTimeString()}] [网络错误] 文件上传异常: ${err.message || err}\n`);
        alert(`网络异常: ${err.message || err}`);
      }
    },
    confirmInference() {
      this.showConfirmModal = false;
      this.$emit('log', `[${new Date().toLocaleTimeString()}] [自动推理] 用户确认立即执行推理任务...\n`);
      this.$emit('run-uploaded-yolo', this.uploadedFilePath);
    },
    cancelInference() {
      this.showConfirmModal = false;
      this.$emit('log', `[${new Date().toLocaleTimeString()}] [提示] 用户选择暂不执行推理。您可以日后通过物理控制面板选择此文件运行。\n`);
    },
    openZoom(task) {
      if (task.media_type === 'video' && task.event?.frames && task.event.frames.length) {
        this.zoomedImageUrl = task.event.frames[this.activeFrameIdx || 0].annotated_image_url;
      } else {
        this.zoomedImageUrl = task.event?.annotated_image_url || '';
      }
      if (this.zoomedImageUrl) {
        this.isZoomed = true;
      }
    },
    // Live preview polling
    async loadLatestFrame() {
      try {
        const resp = await fetch('/api/edge/latest-frame');
        if (resp.ok) {
          const data = await resp.json();
          if (data.ok) {
            this.latestFrame = {
              frame_url: data.frame_url || '',
              fps: data.fps || 0,
              detections_count: data.detections_count || 0,
              timestamp: data.timestamp || '',
            };
          }
        }
      } catch {
        // Silently ignore polling errors — preview is best-effort
      }
    },
    startFramePolling() {
      this.stopFramePolling();
      this.loadLatestFrame();
      this.framePollTimer = setInterval(() => this.loadLatestFrame(), 1000);
    },
    stopFramePolling() {
      if (this.framePollTimer) {
        clearInterval(this.framePollTimer);
        this.framePollTimer = null;
      }
    },
    // Laptop camera controls
    async checkCameraStatus() {
      try {
        const resp = await fetch('/api/edge/camera/status');
        if (resp.ok) {
          const data = await resp.json();
          if (data.ok && data.camera_active) {
            this.laptopCameraActive = true;
            this.startFramePolling();
            const frameData = await fetch('/api/edge/latest-frame').then(r => r.json()).catch(() => ({}));
            if (frameData.ok) {
              this.latestFrame = frameData;
            }
          }
        }
      } catch { /* best-effort */ }
    },
    async toggleLaptopCamera() {
      if (this.cameraControlLoading) return;
      this.cameraControlLoading = true;
      const wasActive = this.laptopCameraActive;
      try {
        const endpoint = wasActive
          ? '/api/edge/camera/stop'
          : '/api/edge/camera/start-yolo';
        const resp = await fetch(endpoint, { method: 'POST' });
        const data = await resp.json();
        if (!wasActive && data.ok) {
          // Starting camera + YOLO
          this.laptopCameraActive = true;
          this.startFramePolling();
          // Auto-open terminal drawer and show output
          this.$emit('log', `\n[${new Date().toLocaleTimeString()}] [摄像头] 笔电摄像头推流已启动 → ${data.stream_url || '/camera/stream'}\n`);
          if (data.stdout) {
            this.$emit('log', data.stdout);
          }
          if (data.message) {
            this.$emit('log', `[${new Date().toLocaleTimeString()}] ${data.message}\n`);
          }
          this.$emit('toggle-terminal');
          // Notify parent to set yoloInferenceStatus = running_board
          this.$emit('camera-yolo-started');
          this.$emit('log', `[${new Date().toLocaleTimeString()}] [YOLO] Atlas 边端推理已启动，等待第一帧标注画面...\n`);
        } else if (!wasActive && !data.ok) {
          // Start failed
          this.$emit('log', `\n[${new Date().toLocaleTimeString()}] [错误] 摄像头/YOLO 启动失败: ${data.error || '未知错误'}\n`);
          if (data.stdout) {
            this.$emit('log', data.stdout);
          }
          this.$emit('toggle-terminal');
        } else if (wasActive) {
          // Stopping
          this.laptopCameraActive = false;
          this.stopFramePolling();
          this.latestFrame = { frame_url: '', fps: 0, detections_count: 0, timestamp: '' };
          this.$emit('camera-yolo-stopped');
          this.$emit('log', `[${new Date().toLocaleTimeString()}] [摄像头] 摄像头已关闭，${data.yolo_stopped || 'YOLO 已终止'}\n`);
        }
      } catch (err) {
        this.$emit('log', `[${new Date().toLocaleTimeString()}] [错误] 摄像头控制异常: ${err.message || err}\n`);
        if (!wasActive) {
          this.$emit('toggle-terminal');
        }
      }
      finally { this.cameraControlLoading = false; }
    },
  },
  template: `
    <section class="edge-cloud-panel">
      <header class="chat-header">
        <div class="chat-header-title-area">
          <button v-if="sidebarCollapsed" class="sidebar-toggle-btn expand-btn" type="button" title="展开侧边栏" @click="$emit('toggle-sidebar')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>
          <h2>昇腾边云协同控制中心 (Ascend Edge-Cloud Monitor Console)</h2>
        </div>
        <button class="upload-toggle-btn" @click="isUploadPanelOpen = !isUploadPanelOpen" style="margin-right: 12px; padding: 6px 14px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; background: var(--panel-solid); color: var(--text); display: flex; align-items: center; gap: 6px; transition: all 0.2s ease;">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
          {{ isUploadPanelOpen ? '收起上传面板' : '上传本地文件' }}
        </button>
        <!-- Laptop Camera Toggle Button -->
        <button class="camera-toggle-btn"
                :class="{ active: laptopCameraActive }"
                :disabled="cameraControlLoading"
                @click="toggleLaptopCamera"
                :title="laptopCameraActive ? '关闭笔电摄像头推流' : '开启笔电摄像头 MJPEG 推流供 Atlas 拉取'">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-5 3.75V7a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3.75L23 17V7z"/><rect x="1" y="7" width="18" height="10" rx="2" ry="2"/></svg>
          <span v-if="cameraControlLoading">...</span>
          <span v-else>{{ laptopCameraActive ? '关闭摄像头' : '开启笔电摄像头' }}</span>
        </button>
      </header>
      
      <div class="dashboard-container edge-full-tasks-layout" style="padding: 20px; flex: 1; overflow: hidden; display: flex; flex-direction: column;">
        <!-- Local Media File Drag & Drop Upload Zone -->
        <div v-if="isUploadPanelOpen" class="media-upload-card" 
             :class="{ dragging: isDragging }"
             @dragover.prevent="isDragging = true"
             @dragleave.prevent="isDragging = false"
             @drop.prevent="onFileDrop" class="upload-zone">
          
          <input type="file" 
                 ref="fileInput" 
                 @change="onFileSelected" 
                 accept=".jpg,.jpeg,.png,.webp,.mp4,.avi,.mkv,.mov" 
                 style="display: none;" />
                 
          <!-- Loading Mask -->
          <div v-if="uploading" 
               class="upload-loading-overlay" >
            <div class="upload-big-spinner"></div>
            <div class="upload-hint">正在上传媒体文件并执行板端 YOLO 推理...</div>
            <div class="upload-hint-sub">视频文件需要抽帧，可能耗时稍长，请稍候...</div>
          </div>
          
          <div @click="triggerFileInput" class="upload-prompt">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 12px;">
              <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
              <path d="M12 12v9"/>
              <path d="m16 16-4-4-4 4"/>
            </svg>
            <div class="upload-title">
              拖拽图片/视频到此处，或 <span style="color: #38bdf8; text-decoration: underline;">点击浏览</span>
            </div>
            <div class="upload-subtext">
              支持 JPG, JPEG, PNG, WEBP, MP4, AVI, MKV, MOV 格式
            </div>
          </div>
        </div>

        <!-- Live Camera + YOLO Preview Card -->
        <div v-if="laptopCameraActive" class="live-preview-card">
          <div class="live-preview-header">
            <span class="live-preview-dot" :class="{ waiting: !latestFrame.frame_url }"></span>
            <span class="live-preview-label">
              {{ latestFrame.frame_url ? '实时 YOLO 推理预览' : '笔电摄像头画面 (等待 Atlas YOLO...)' }}
            </span>
            <span class="live-preview-meta">
              <span v-if="latestFrame.fps" class="live-preview-fps">{{ latestFrame.fps }} FPS</span>
              <span v-if="latestFrame.detections_count" class="live-preview-count">{{ latestFrame.detections_count || 0 }} 目标</span>
            </span>
          </div>
          <div class="live-preview-viewport">
            <!-- Show YOLO-annotated frame when available -->
            <img v-if="latestFrame.frame_url"
                 :key="latestFrame.frame_url"
                 :src="latestFrame.frame_url"
                 class="live-preview-image"
                 alt="实时 YOLO 推理帧" />
            <!-- Fallback: show raw laptop camera MJPEG stream -->
            <img v-else
                 src="/camera/stream"
                 class="live-preview-image"
                 alt="笔电摄像头实时画面" />
          </div>
        </div>

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
                  <span :class="task.media_type === 'video' ? 'task-media-badge-video' : 'task-media-badge-image'">
                    {{ task.media_type === 'video' ? '🎥 视频' : '🖼️ 图片' }}
                  </span>
                  <strong class="task-title" style="vertical-align: middle;">{{ task.image_id || task.event?.image_id || 'world_cup.jpg' }}</strong>
                  <span class="task-device-id" style="vertical-align: middle;">设备: {{ task.device_id || task.event?.device_id || 'unknown' }}</span>
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
                    <!-- Video Mode Frames Slider -->
                    <div v-if="task.media_type === 'video' && task.event?.frames && task.event.frames.length" style="display:flex; flex-direction:column; gap:8px;">
                      <div class="edge-task-image-container task-image-zoom-area" @click="openZoom(task)">
                        <img class="edge-task-image" 
                             :src="task.event.frames[activeFrameIdx || 0].annotated_image_url" 
                             alt="YOLO Annotated Result" 
                             style="max-width:100%; height: 100%; border-radius:8px; display:block; margin:0 auto; object-fit: contain;">
                        <div class="image-zoom-hint" style="position: absolute; right: 10px; bottom: 10px; background: rgba(0,0,0,0.65); color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; pointer-events: none;">
                          🔍 点击放大帧 {{ (activeFrameIdx || 0) + 1 }}
                        </div>
                      </div>
                      <!-- Thumbnails Slider -->
                      <div style="display:flex; gap:8px; overflow-x:auto; padding:4px 0; max-width: 100%;">
                        <div v-for="(frame, fIdx) in task.event.frames" 
                             :key="fIdx" 
                             @click="activeFrameIdx = fIdx"
                             :style="{
                               flex: '0 0 70px',
                               height: '50px',
                               borderRadius: '6px',
                               overflow: 'hidden',
                               cursor: 'pointer',
                               border: (activeFrameIdx || 0) === fIdx ? '2px solid var(--accent)' : '1px solid var(--line)',
                               opacity: (activeFrameIdx || 0) === fIdx ? '1' : '0.7',
                               transition: 'all 0.15s ease'
                             }">
                          <img :src="frame.annotated_image_url" style="width:100%; height:100%; object-fit:cover;">
                        </div>
                      </div>
                    </div>
                    
                    <!-- Image Mode -->
                    <div v-else style="display:flex; flex-direction:column; gap:8px;">
                      <div class="edge-task-image-container task-image-zoom-area" @click="openZoom(task)">
                        <img v-if="task.event?.annotated_image_url" 
                             class="edge-task-image" 
                             :src="task.event.annotated_image_url" 
                             alt="YOLO Result" 
                             loading="lazy">
                        <div v-else class="edge-task-image-fallback">
                          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                          <span>无有效标注图</span>
                        </div>
                        <div v-if="task.event?.annotated_image_url" class="image-zoom-hint" style="position: absolute; right: 10px; bottom: 10px; background: rgba(0,0,0,0.65); color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; pointer-events: none;">
                          🔍 点击放大
                        </div>
                      </div>
                    </div>
                    
                    <div class="task-source-path">
                      分析源: <code>{{ task.event?.source_path || task.image_id || '/home/HwHiAiUser/samples/notebooks/01-yolov5/world_cup.jpg' }}</code>
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
                    <div v-else-if="task.event?.edge_decision?.need_cloud_analysis && !task.analysis" class="agent-analysis-card-box agent-waiting-box">
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
                  <button type="button" class="edge-analyze-btn"
                    :disabled="yoloInferenceStatus !== 'idle'"
                    @click.stop="$emit('run-analysis', task.id)"
                    :style="{ padding:'6px 14px', border:'1px solid var(--line)', borderRadius:'6px', fontSize:'12px', fontWeight:'600', cursor: yoloInferenceStatus !== 'idle' ? 'not-allowed' : 'pointer', background: yoloInferenceStatus !== 'idle' ? '#94a3b8' : 'var(--accent)', color:'white', display:'flex', alignItems:'center', gap:'4px', opacity: yoloInferenceStatus !== 'idle' ? 0.7 : 1 }">
                    <svg v-if="yoloInferenceStatus === 'idle'" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"/></svg>
                    <span v-if="yoloInferenceStatus === 'idle'">{{ task.analysis ? '重新研判' : '云端分析' }}</span>
                    <span v-else>⏳ 研判中...</span>
                  </button>
                </div>
              </div>
              
            </div>
          </div>
        </div>
      </div>

      <!-- Siri-style terminal debug button inside EdgeMonitor -->
      <button 
        class="siri-debug-btn" 
        @click="$emit('toggle-terminal')" 
        :class="{ open: isTerminalOpen }"
        type="button"
        title="打开板端 SSH 调试终端"
      >
        <div class="siri-glow"></div>
        <svg class="siri-icon" viewBox="0 0 24 24" width="22" height="22">
          <path fill="currentColor" d="M12 2A10 10 0 1 0 22 12 A10 10 0 0 0 12 2 Z M13 17 H11 V15 H13 V17 Z M13 13 H11 V7 H13 V13 Z"/>
        </svg>
      </button>

      <!-- Terminal Drawer Panel inside EdgeMonitor -->
      <div 
        class="terminal-drawer" 
        :class="{ open: isTerminalOpen }"
      >
        <div class="drawer-header">
          <div class="drawer-title">
            <span class="terminal-dot" :class="sshStatus"></span>
            <span>板端 SSH 运行终端</span>
          </div>
          <div class="drawer-actions">
            <button class="drawer-reconnect-btn" @click="$emit('retry-ssh')" :disabled="sshStatus === 'connecting'">
              {{ sshStatus === 'connecting' ? '连接中...' : '重新连接' }}
            </button>
            <button class="drawer-close-btn" @click="$emit('toggle-terminal')">&times;</button>
          </div>
        </div>
        
        <!-- SSH Connection Status Bar -->
        <div class="terminal-status-bar" :class="sshStatus">
          <span class="status-indicator"></span>
          <span class="status-text" v-text="sshStatusText"></span>
        </div>

        <!-- Logs Area -->
        <div class="terminal-body" ref="terminalBody">
          <pre class="terminal-log" v-text="terminalLogs"></pre>
          <span v-if="terminalLoading" class="cursor-blink">_</span>
        </div>
      </div>

      <!-- Custom Upload Confirm Modal -->
      <div v-if="showConfirmModal" class="modal-overlay" style="z-index: 2500; display: flex; align-items: center; justify-content: center; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(4px);">
        <div class="modal-dialog" style="max-width: 450px; width: 90%; background: var(--panel-solid); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); overflow: hidden; display: flex; flex-direction: column;">
          <header class="modal-header" style="padding: 16px 20px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center;">
            <h3 style="margin: 0; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
              <span>🔔 上传成功与推理确认</span>
            </h3>
            <button type="button" class="modal-close-btn" @click="cancelInference" style="background: none; border: none; font-size: 20px; color: var(--muted); cursor: pointer;">&times;</button>
          </header>
          <div class="modal-body" style="padding: 20px; display: flex; flex-direction: column; gap: 12px;">
            <div style="font-size: 13px; color: var(--text); line-height: 1.6;">
              本地媒体文件已成功上传至开发板！
              <div class="upload-confirm-path">
                {{ uploadedFilePath }}
              </div>
            </div>
            <div class="upload-confirm-prompt">
              是否立即对该文件运行板端 YOLO 推理与云端多模态分析？
            </div>
          </div>
          <footer class="modal-footer" style="padding: 12px 20px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 10px;">
            <button type="button" @click="cancelInference" class="upload-confirm-cancel">
              暂不执行
            </button>
            <button type="button" @click="confirmInference" class="upload-confirm-ok">
              立即推理
            </button>
          </footer>
        </div>
      </div>
      
      <!-- Zoom Lightbox -->
      <div v-if="isZoomed" class="zoom-lightbox" @click="isZoomed = false" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.95); display: flex; align-items: center; justify-content: center; z-index: 3000; cursor: zoom-out;">
        <img :src="zoomedImageUrl" style="max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 4px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
        <button class="zoom-lightbox-close">&times;</button>
      </div>
    </section>
  `
};
