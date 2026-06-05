// TravelAssistant Component - Dialogue assistants, suggestions, map widgets, and input controllers.

export default {
  name: 'TravelAssistant',
  props: {
    messages: { type: Array, default: () => [] },
    thinkingMode: { type: Boolean, default: true },
    offlineMode: { type: Boolean, default: false },
    inputSuggest: { type: Boolean, default: true },
    chatInput: { type: String, default: '' },
    isGenerating: { type: Boolean, default: false },
    inputTips: { type: Array, default: () => [] },
    showInputTips: { type: Boolean, default: false },
    sidebarCollapsed: { type: Boolean, default: false },
    generationStatus: { type: String, default: '' },
    generationTrace: { type: Array, default: () => [] },
    generationStats: { type: Object, default: () => ({}) }
  },
  emits: [
    'update:thinkingMode',
    'update:offlineMode',
    'update:inputSuggest',
    'update:chatInput',
    'send-message',
    'clear-messages',
    'locate',
    'toggle-sidebar',
    'select-tip'
  ],
  computed: {
    localChatInput: {
      get() { return this.chatInput; },
      set(val) { this.$emit('update:chatInput', val); }
    }
  },
  watch: {
    messages: {
      handler() {
        this.$nextTick(() => {
          this.scrollToBottom();
          this.initCardsAndMaps();
        });
      },
      deep: true
    }
  },
  mounted() {
    this.scrollToBottom();
    this.initCardsAndMaps();
  },
  updated() {
    this.initCardsAndMaps();
  },
  methods: {
    scrollToBottom() {
      const messagesContainer = this.$refs.messagesContainer;
      if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    },
    initCardsAndMaps() {
      if (window.initDraggableMaps) window.initDraggableMaps(this.$el);
      if (window.initLiveMaps) window.initLiveMaps(this.$el);
      if (window.loadHotelImagesBatched) window.loadHotelImagesBatched(this.$el);
      
      // Bind event listeners for dynamically rendered maps (retry/reset buttons)
      this.$el.querySelectorAll('.poi-map-retry').forEach((btn) => {
        if (btn.dataset.bound === 'true') return;
        btn.dataset.bound = 'true';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const viewport = btn.closest('.poi-map-viewport');
          const liveMap = viewport?.querySelector('.amap-live-map');
          if (liveMap) {
            liveMap.dataset.mapReady = '';
            if (window.ensureLiveMap) window.ensureLiveMap(liveMap);
          }
        });
      });
      
      this.$el.querySelectorAll('.poi-map-reset').forEach((btn) => {
        if (btn.dataset.bound === 'true') return;
        btn.dataset.bound = 'true';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const viewport = btn.closest('.poi-map-viewport');
          if (viewport && window.resetDraggableMap) {
            window.resetDraggableMap(viewport);
            const liveMap = viewport.querySelector('.amap-live-map');
            if (liveMap && liveMap._amapInstance && liveMap._amapMarkers?.length) {
              liveMap._amapInstance.setFitView(liveMap._amapMarkers, false, [58, 36, 36, 36]);
              if (liveMap._amapInfoWindow) {
                liveMap._amapInfoWindow.close();
              }
              const scope = liveMapScope(liveMap);
              if (window.highlightLiveMarker) window.highlightLiveMarker(scope, null);
              if (window.highlightPoiCard) window.highlightPoiCard(scope, null);
            }
          }
        });
      });

      // Post-process loading status if generating
      if (this.isGenerating && this.$refs.loadingArticle && window.renderLoadingStatus) {
        window.renderLoadingStatus(
          this.$refs.loadingArticle,
          this.generationStatus || 'AI 正在思考中...',
          this.generationTrace || [],
          this.generationStats || {}
        );
      }

      // Post-process metadata for completed assistant messages
      this.$el.querySelectorAll('.message.assistant:not(.loading)').forEach((el) => {
        const msgId = el.dataset.msgId;
        if (!msgId) return;
        const msg = this.messages.find(m => String(m.id) === String(msgId));
        if (msg && msg.metaData && window.appendMeta) {
          // Prevent duplicate appending
          if (!el.querySelector('.message-meta') && !el.querySelector('.trace-panel')) {
            window.appendMeta(el, msg.metaData);
          }
        }
      });
    },
    renderMarkdown(text) {
      if (window.renderMarkdown) {
        return window.renderMarkdown(text);
      }
      return text;
    },
    renderStructured(data) {
      if (window.buildStructuredCards) {
        return window.buildStructuredCards(data);
      }
      return '';
    },
    handleSubmit() {
      if (this.isGenerating || !this.localChatInput.trim()) return;
      this.$emit('send-message');
    },
    handleKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSubmit();
      }
    }
  },
  template: `
    <section class="chat-panel">
      <header class="chat-header">
        <div class="chat-header-title-area">
          <button v-if="sidebarCollapsed" class="sidebar-toggle-btn expand-btn" type="button" title="展开侧边栏" @click="$emit('toggle-sidebar')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>
          <h2>出行需求规划对话</h2>
        </div>
        <button id="clearBtn" class="clear-btn" type="button" @click="$emit('clear-messages')">清空对话</button>
      </header>

      <div ref="messagesContainer" class="messages" aria-live="polite" style="flex: 1; overflow-y: auto; padding: 20px;">
        <article v-for="msg in messages" :key="msg.id" class="message" :class="[msg.role, msg.extraClass]" :data-msg-id="msg.id">
          <div v-if="msg.role === 'assistant'" class="avatar">AI</div>
          <div class="bubble">
            <div v-if="msg.role === 'assistant'" v-html="renderMarkdown(msg.text)"></div>
            <div v-else>{{ msg.text }}</div>
            
            <!-- Render Structured travel cards if present -->
            <div v-if="msg.structuredData" class="structured-container" v-html="renderStructured(msg.structuredData)"></div>
          </div>
        </article>
        
        <article v-if="isGenerating" class="message assistant loading" ref="loadingArticle">
          <div class="avatar">AI</div>
          <div class="bubble">
            <div class="loading-dots">
              <span>.</span><span>.</span><span>.</span>
            </div>
          </div>
        </article>
      </div>

      <form class="composer" @submit.prevent="handleSubmit">
        <div class="composer-toolbar">
          <label class="switch compact-toggle">
            <input type="checkbox" :checked="thinkingMode" @change="$emit('update:thinkingMode', $event.target.checked)">
            <span class="slider"></span>
            <span>深度思考</span>
          </label>
          <label class="switch compact-toggle">
            <input type="checkbox" :checked="offlineMode" @change="$emit('update:offlineMode', $event.target.checked)">
            <span class="slider"></span>
            <span>离线演示</span>
          </label>
          <label class="switch compact-toggle">
            <input type="checkbox" :checked="inputSuggest" @change="$emit('update:inputSuggest', $event.target.checked)">
            <span class="slider"></span>
            <span>输入联想</span>
          </label>
          <button class="toolbar-button" type="button" @click="$emit('locate')">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: middle;"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
            <span>定位</span>
          </button>
        </div>
        <div class="input-wrap">
          <textarea id="messageInput" v-model="localChatInput" rows="2" placeholder="请输入你的出行需求，例如：明天从宁波去舟山玩1天，想看风景吃海鲜..." @keydown="handleKeydown"></textarea>
          
          <!-- Input suggestions block -->
          <div id="inputTips" v-if="showInputTips && inputTips.length" class="input-tips">
            <div v-for="tip in inputTips" :key="tip" class="tip-item" @click="$emit('select-tip', tip)">
              {{ tip }}
            </div>
          </div>
        </div>
        <button id="sendBtn" class="send-btn" type="submit" :disabled="isGenerating || !localChatInput.trim()">
          <span>发送</span>
        </button>
      </form>
    </section>
  `
};
