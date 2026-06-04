import { createApp, ref, reactive, onMounted, watch, nextTick } from 'vue';
import SidebarComponent from './components/SidebarComponent.js?v=20260604-ux';
import TravelAssistant from './components/TravelAssistant.js?v=20260604-ux';
import EdgeMonitor from './components/EdgeMonitor.js?v=20260604-ux';
import TaskModal from './components/TaskModal.js?v=20260604-ux';

createApp({
  components: {
    SidebarComponent,
    TravelAssistant,
    EdgeMonitor,
    TaskModal
  },
  setup() {
    // LocalStorage Keys
    const CURRENT_CONVERSATION_KEY = "travel_agent_current_conversation_id";
    const LOCATION_CONTEXT_KEY = "travel_agent_location_context";
    const INPUT_SUGGEST_KEY = "travel_agent_input_suggest_enabled";
    const ACTIVE_MODE_KEY = "travel_agent_active_mode";

    // Reactive State
    const activeMode = ref(localStorage.getItem(ACTIVE_MODE_KEY) || 'travel');
    const activeTab = ref(activeMode.value === 'travel' ? 'history' : 'device');
    const sidebarCollapsed = ref(false);
    
    const conversations = ref([]);
    const activeConversationId = ref(localStorage.getItem(CURRENT_CONVERSATION_KEY) || "");
    const messages = ref([]);
    const skills = ref([]);
    const devices = ref([]);
    const tasks = ref([]);
    
    // System Config & Status
    const systemStatus = ref({
      model: '',
      thinking_model: '',
      api_key_loaded: false,
      amap_key_loaded: false,
      qweather_key_loaded: false,
      qweather_host_loaded: false,
      train_tools_available: false,
      aviationstack_key_loaded: false,
      rapidapi_key_loaded: false
    });
    
    // Location Context
    const locationContext = ref({});
    const locationStatusText = ref("未定位");

    // Chat Inputs & Streaming
    const chatInput = ref('');
    const isGenerating = ref(false);
    const thinkingMode = ref(true);
    const offlineMode = ref(false);
    const inputSuggest = ref(localStorage.getItem(INPUT_SUGGEST_KEY) !== "false");
    
    const inputTips = ref([]);
    const showInputTips = ref(false);
    let inputTipTimer = null;

    // SSE generation specific state (passed to loading status renderer)
    const generationStatus = ref('');
    const generationTrace = ref([]);
    const generationStats = reactive({
      eventCount: 0,
      silentSeconds: 0,
      model: ''
    });

    // Task Modal state
    const isModalOpen = ref(false);
    const activeTaskId = ref('');
    const activeTaskDetail = ref(null);
    const modalLoading = ref(false);
    const modalError = ref('');

    // Board Control SSH specific state
    const isBoardConsoleOpen = ref(false);
    const boardConsoleTitle = ref('');
    const boardConsoleLog = ref('');
    const boardConsoleLoading = ref(false);

    // Helpers
    const generateId = () => Math.random().toString(36).substring(2, 15);
    
    const renderWelcome = () => {
      messages.value = [
        {
          id: 'welcome',
          role: 'assistant',
          text: '你好，我是你的智能旅游规划助理。你可以直接用自然语言向我描述你的出行计划，我会自动帮你查询天气、路线、高铁票、机票与酒店价格，并生成精美的行程卡片。\n\n<b>试试输入以下例子体验：</b>\n“我明天从郑州去杭州，玩3天，2个人，预算酒店300，餐饮120，门票300”'
        }
      ];
    };

    const loadLocationContext = () => {
      try {
        const val = localStorage.getItem(LOCATION_CONTEXT_KEY);
        locationContext.value = val ? JSON.parse(val) : {};
        updateLocationLabel();
      } catch {
        locationContext.value = {};
        locationStatusText.value = "未定位";
      }
    };

    const saveLocationContext = (context) => {
      locationContext.value = context || {};
      localStorage.setItem(LOCATION_CONTEXT_KEY, JSON.stringify(locationContext.value));
      updateLocationLabel();
    };

    const updateLocationLabel = () => {
      const ctx = locationContext.value;
      const label = ctx.city || ctx.district || ctx.province || "";
      locationStatusText.value = label || "未定位";
    };

    // Load static and configuration data
    const loadStatus = async () => {
      try {
        const response = await fetch("/api/status");
        const data = await response.json();
        systemStatus.value = data;
      } catch (err) {
        console.error("Failed to load status:", err);
      }
    };

    const loadSkills = async () => {
      try {
        const response = await fetch("/api/skills");
        const data = await response.json();
        skills.value = data.skills || [];
      } catch (err) {
        console.error("Failed to load skills:", err);
      }
    };

    const loadConversationsList = async () => {
      try {
        const response = await fetch("/api/conversations");
        const data = await response.json();
        conversations.value = data.conversations || [];
      } catch (err) {
        console.error("Failed to load conversations:", err);
      }
    };

    const selectConversation = async (conversationId) => {
      activeMode.value = 'travel'; // Automatically switch to travel mode on select
      if (!conversationId) {
        activeConversationId.value = "";
        localStorage.removeItem(CURRENT_CONVERSATION_KEY);
        renderWelcome();
        return;
      }
      activeConversationId.value = conversationId;
      localStorage.setItem(CURRENT_CONVERSATION_KEY, conversationId);
      
      try {
        const response = await fetch(`/api/conversations/${conversationId}/messages`);
        const data = await response.json();
        const msgList = data.messages || [];
        messages.value = msgList.map(m => ({
          id: m.id || generateId(),
          role: m.role,
          text: m.text,
          structuredData: m.meta?.structured_data || null,
          metaData: m.meta || null,
          extraClass: m.extraClass || ""
        }));
        if (!messages.value.length) renderWelcome();
      } catch (err) {
        console.error("Failed to load conversation messages:", err);
      }
    };

    const deleteConversation = async (conversationId) => {
      if (confirm("确定要删除这次对话吗？")) {
        try {
          const response = await fetch(`/api/conversations/${conversationId}`, {
            method: "DELETE"
          });
          const data = await response.json();
          if (data.deleted) {
            if (activeConversationId.value === conversationId) {
              activeConversationId.value = "";
              localStorage.removeItem(CURRENT_CONVERSATION_KEY);
              renderWelcome();
            }
            await loadConversationsList();
          }
        } catch (err) {
          console.error("Failed to delete conversation:", err);
        }
      }
    };

    const newChat = () => {
      selectConversation("");
    };

    // Location request
    const requestBrowserLocation = () => {
      locationStatusText.value = "定位中...";
      if (!navigator.geolocation) {
        requestIpLocation();
        return;
      }
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { longitude, latitude } = position.coords;
          const location = `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
          try {
            const response = await fetch(`/api/amap/reverse-geocode?location=${encodeURIComponent(location)}`);
            const data = await response.json();
            if (response.ok) {
              saveLocationContext({
                source: "浏览器定位",
                province: data.province || "",
                city: data.city || data.province || "",
                district: data.district || "",
                adcode: data.adcode || "",
                address: data.address || "",
                location
              });
            } else {
              requestIpLocation();
            }
          } catch {
            requestIpLocation();
          }
        },
        () => {
          requestIpLocation();
        },
        { timeout: 6000 }
      );
    };

    const requestIpLocation = async () => {
      try {
        const response = await fetch("/api/amap/ip-location");
        const data = await response.json();
        if (response.ok && (data.city || data.province)) {
          saveLocationContext({
            source: "高德IP定位",
            province: data.province || "",
            city: data.city || data.province || "",
            district: "",
            adcode: data.adcode || "",
            address: data.city || data.province || "",
            location: ""
          });
        } else {
          locationStatusText.value = "定位失败";
        }
      } catch {
        locationStatusText.value = "定位失败";
      }
    };

    // Input tips loading
    const loadInputTips = async () => {
      if (!inputSuggest.value || !chatInput.value.trim()) {
        showInputTips.value = false;
        return;
      }
      try {
        const params = new URLSearchParams({ keywords: chatInput.value });
        const city = locationContext.value.city || locationContext.value.province || "";
        if (city) params.set("city", city);
        
        const response = await fetch(`/api/amap/input-tips?${params.toString()}`);
        const data = await response.json();
        const tips = Array.isArray(data.tips) ? data.tips.filter(tip => tip.name) : [];
        if (tips.length) {
          inputTips.value = tips.map(tip => tip.name);
          showInputTips.value = true;
        } else {
          showInputTips.value = false;
        }
      } catch {
        showInputTips.value = false;
      }
    };

    const selectTip = (tip) => {
      chatInput.value = tip;
      showInputTips.value = false;
      // Refocus text area if possible
    };

    // Chat Dialog submission
    const getConversationHistory = () => {
      return messages.value
        .filter(m => m.id !== 'welcome')
        .slice(-8)
        .map(m => ({
          role: m.role,
          text: m.text
        }));
    };

    const sendMessage = async () => {
      const msgText = chatInput.value.trim();
      if (!msgText || isGenerating.value) return;

      chatInput.value = "";
      showInputTips.value = false;
      
      // Add user message
      messages.value.push({
        id: generateId(),
        role: 'user',
        text: msgText
      });
      
      // Setup generator status state
      isGenerating.value = true;
      generationStatus.value = "AI 正在连接中...";
      generationTrace.value = [];
      generationStats.eventCount = 0;
      generationStats.silentSeconds = 0;
      generationStats.model = "";

      let finalData = null;
      let lastEventAt = Date.now();
      
      const statsTimer = setInterval(() => {
        generationStats.silentSeconds = Math.round((Date.now() - lastEventAt) / 1000);
      }, 1000);

      try {
        await window.requestChatStream(
          {
            message: msgText,
            conversation_id: activeConversationId.value,
            history: getConversationHistory(),
            offline_demo: offlineMode.value,
            thinking_mode: thinkingMode.value,
            client_context: locationContext.value
          },
          (data) => {
            generationStats.eventCount += 1;
            lastEventAt = Date.now();
            if (data.conversation_id) {
              activeConversationId.value = data.conversation_id;
              localStorage.setItem(CURRENT_CONVERSATION_KEY, data.conversation_id);
            }
            if (data.model) {
              generationStats.model = data.model;
            }

            if (data.event === "status") {
              generationStatus.value = data.message || generationStatus.value;
            } else if (data.event === "trace") {
              generationTrace.value = Array.isArray(data.trace) ? data.trace : generationTrace.value;
              const item = data.item || {};
              if (data.phase === "tool_call" || item.type === "tool_call") {
                generationStatus.value = `正在调用 ${window.traceToolInfo?.(item.tool)?.title || item.tool}...`;
              } else if (data.phase === "tool_result" || item.type === "tool_result") {
                generationStatus.value = `调用 ${window.traceToolInfo?.(item.tool)?.title || item.tool} 完成`;
              } else if (data.phase === "llm_response" || item.type === "llm_response") {
                generationStatus.value = `决策分析中...`;
              } else if (data.message) {
                generationStatus.value = data.message;
              }
            } else if (data.event === "done" || data.event === "error") {
              finalData = data;
            }
          }
        );

        clearInterval(statsTimer);
        isGenerating.value = false;

        if (finalData?.conversation_id) {
          activeConversationId.value = finalData.conversation_id;
          localStorage.setItem(CURRENT_CONVERSATION_KEY, finalData.conversation_id);
        }

        // Push assistant response
        messages.value.push({
          id: generateId(),
          role: 'assistant',
          text: finalData?.answer || finalData?.error || "无响应内容。",
          structuredData: finalData?.structured_data || null,
          metaData: finalData || null
        });

        await loadConversationsList();
      } catch (error) {
        clearInterval(statsTimer);
        isGenerating.value = false;
        
        if (error.name === "AbortError") {
          messages.value.push({
            id: generateId(),
            role: 'assistant',
            text: "对话已被中止。"
          });
        } else {
          messages.value.push({
            id: generateId(),
            role: 'assistant',
            text: `出错了: ${error.message}`
          });
        }
      }
    };

    const clearMessages = () => {
      // In Flask backend, we don't necessarily delete the conversation history,
      // but we can start a new empty conversation for the UI.
      newChat();
    };

    const useSkill = (skill) => {
      const exampleText = Array.isArray(skill.examples) && skill.examples.length 
        ? skill.examples[0] 
        : (skill.example || `@${skill.display_name || skill.name}`);
      chatInput.value = exampleText;
      nextTick(() => {
        // Find textarea and focus
        const textarea = document.querySelector(".composer textarea");
        if (textarea) textarea.focus();
      });
    };

    // Edge tasks & devices polling
    const loadEdgeStatus = async () => {
      try {
        const [tasksResponse, statusResponse] = await Promise.all([
          fetch("/api/edge/tasks?limit=24"),
          fetch("/api/edge/status")
        ]);
        const tasksData = await tasksResponse.json();
        const statusData = await statusResponse.json();
        
        devices.value = statusData.devices || [];
        tasks.value = tasksData.tasks || [];
      } catch (err) {
        console.error("Failed to load edge status:", err);
      }
    };

    const manualHeartbeat = async () => {
      try {
        const firstDevice = Array.isArray(devices.value) && devices.value.length ? devices.value[0] : {};
        const payload = {
          device_id: firstDevice.device_id || "atlas-200i-dk-a2-01",
          hostname: firstDevice.hostname || "dashboard-manual",
          source: "dashboard_manual",
          note: "Manual heartbeat sent from dashboard button.",
          system_metrics: firstDevice.system_metrics || {},
          pending_events: firstDevice.pending_events || 0
        };
        const response = await fetch("/api/edge/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (response.ok && data.ok !== false) {
          await loadEdgeStatus();
        }
      } catch (err) {
        console.error("Manual heartbeat error:", err);
      }
    };

    const runAnalysis = async (taskId) => {
      try {
        const response = await fetch("/api/edge/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task_id: taskId, thinking_mode: true })
        });
        if (response.ok) {
          const data = await response.json();
          if (data.ok) {
            if (isModalOpen.value && activeTaskId.value === taskId) {
              activeTaskDetail.value = data.task;
            }
            await loadEdgeStatus();
          }
        }
      } catch (err) {
        console.error("Cloud analysis error:", err);
      }
    };

    // Task details modal
    const openTaskModal = async (taskId) => {
      activeTaskId.value = taskId;
      isModalOpen.value = true;
      modalLoading.value = true;
      modalError.value = "";
      activeTaskDetail.value = null;

      try {
        const response = await fetch(`/api/edge/tasks/${encodeURIComponent(taskId)}`);
        const data = await response.json();
        if (data.ok) {
          activeTaskDetail.value = data.task;
        } else {
          modalError.value = data.error || "获取任务失败";
        }
      } catch (err) {
        modalError.value = err.message || "请求失败";
      } finally {
        modalLoading.value = false;
      }
    };

    const closeTaskModal = () => {
      isModalOpen.value = false;
      activeTaskId.value = "";
      activeTaskDetail.value = null;
    };

    const executeBoardControl = async (action) => {
      boardConsoleTitle.value = action === 'run_yolo' ? '板端运行 YOLO 推理与上报任务流' : '板端设备物理控制控制台';
      boardConsoleLog.value = '正在通过 SSH 连接开发板并执行操作...\n';
      isBoardConsoleOpen.value = true;
      boardConsoleLoading.value = true;

      try {
        const response = await fetch("/api/edge/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action })
        });
        const data = await response.json();
        boardConsoleLoading.value = false;
        
        if (data.ok) {
          boardConsoleLog.value += `[成功] ${data.message}\n`;
          if (data.command) {
            boardConsoleLog.value += `执行命令: ${data.command}\n`;
          }
          if (data.output) {
            boardConsoleLog.value += `\n--- 命令行标准输出 (STDOUT) ---\n${data.output}\n`;
          }
          if (data.error_output) {
            boardConsoleLog.value += `\n--- 命令行错误输出 (STDERR) ---\n${data.error_output}\n`;
          }
          
          await loadEdgeStatus();
        } else {
          boardConsoleLog.value += `[错误] ${data.error || '执行失败'}\n`;
        }
      } catch (err) {
        boardConsoleLoading.value = false;
        boardConsoleLog.value += `[网络错误] 无法连接到服务器进行控制: ${err.message || err}\n`;
      }
    };

    // Watchers & Life Cycle Hooks
    watch(activeMode, (newVal) => {
      localStorage.setItem(ACTIVE_MODE_KEY, newVal);
      if (newVal === 'travel') {
        activeTab.value = 'history';
      } else {
        activeTab.value = 'device';
      }
    });

    watch(chatInput, () => {
      clearTimeout(inputTipTimer);
      inputTipTimer = setTimeout(loadInputTips, 260);
    });

    watch(inputSuggest, (newVal) => {
      localStorage.setItem(INPUT_SUGGEST_KEY, newVal ? "true" : "false");
      if (!newVal) {
        showInputTips.value = false;
      }
    });

    onMounted(async () => {
      // Load static configurations
      await loadStatus();
      await loadSkills();
      loadLocationContext();
      
      // Load conversations and messages
      await loadConversationsList();
      if (activeConversationId.value) {
        await selectConversation(activeConversationId.value);
      } else {
        renderWelcome();
      }

      // Initialize maps and listeners in travel_helpers
      if (window.initTravelHelpers) {
        window.initTravelHelpers();
      }

      // Load Edge tasks/devices
      await loadEdgeStatus();
      
      // Poll Edge tasks periodically (every 4 seconds)
      setInterval(() => {
        loadEdgeStatus();
      }, 4000);
    });

    return {
      activeMode,
      activeTab,
      sidebarCollapsed,
      conversations,
      activeConversationId,
      messages,
      skills,
      devices,
      tasks,
      systemStatus,
      locationStatusText,
      chatInput,
      isGenerating,
      thinkingMode,
      offlineMode,
      inputSuggest,
      inputTips,
      showInputTips,
      generationStatus,
      generationTrace,
      generationStats,
      isModalOpen,
      activeTaskId,
      activeTaskDetail,
      modalLoading,
      modalError,
      isBoardConsoleOpen,
      boardConsoleTitle,
      boardConsoleLog,
      boardConsoleLoading,
      
      selectConversation,
      deleteConversation,
      newChat,
      sendMessage,
      clearMessages,
      useSkill,
      selectTip,
      requestBrowserLocation,
      manualHeartbeat,
      runAnalysis,
      openTaskModal,
      closeTaskModal,
      executeBoardControl
    };
  }
}).mount('#appShell');
