// ============================================================
// ui.ts - 配置面板UI: 注入到B站页面 (简约版)
// ============================================================
import type { FilterConfig, KeywordRule, MarkedComment, AIRule, FilteredComment, AccumulatedStats } from "./types";
import { DEFAULT_CONFIG, AI_PROVIDERS } from "./types";
import { testAPIConnection, fetchModels, learnFromMarked } from "./api";
import {
  clearCache,
  getAllKeywords,
  addKeyword,
  updateKeyword,
  removeKeyword,
  clearKeywords,
  getAllMarkedComments,
  getUnlearnedMarkedComments,
  markCommentsAsLearned,
  addMarkedComment,
  removeMarkedComment,
  clearMarkedComments,
  getAllAIRules,
  addAIRule,
  removeAIRule,
  clearAIRules,
  addFalsePositive,
  removeFalsePositive,
} from "./db";
import { buildBlacklistPanelHTML } from "./logger";

// ---------- 工具函数 ----------

function contrastText(bg: string): string {
  const hex = bg.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1a1a1a" : "#ffffff";
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

let keywordIdCounter = Date.now();
function nextKeywordId(): number {
  return keywordIdCounter++;
}

// ---------- 深色模式 ----------

const LIGHT_COLORS = {
  bg: "#ffffff",
  bgHover: "#f5f5f5",
  bgActive: "#e8e8e8",
  border: "#e0e0e0",
  text: "#1a1a1a",
  textSecondary: "#666666",
  textMuted: "#999999",
  accent: "#e0e0e0",
  accentHover: "#cccccc",
  danger: "#d32f2f",
  success: "#2e7d32",
};

const DARK_COLORS = {
  bg: "#1a1a1a",
  bgHover: "#2a2a2a",
  bgActive: "#333333",
  border: "#3a3a3a",
  text: "#e0e0e0",
  textSecondary: "#a0a0a0",
  textMuted: "#707070",
  accent: "#404040",
  accentHover: "#505050",
  danger: "#ef5350",
  success: "#66bb6a",
};

let isDarkMode = false;

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function resolveDarkMode(mode: "light" | "dark" | "auto"): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return systemPrefersDark();
}

function getColors(config: FilterConfig): typeof LIGHT_COLORS {
  isDarkMode = resolveDarkMode(config.darkMode);
  return isDarkMode ? DARK_COLORS : LIGHT_COLORS;
}

// 监听系统主题变化
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (currentConfig?.darkMode === "auto") {
    applyTheme(currentConfig);
  }
});

let currentConfig: FilterConfig | null = null;

function applyTheme(config: FilterConfig): void {
  currentConfig = config;
  const c = getColors(config);
  const panel = document.getElementById("cb-panel");
  if (panel) {
    panel.style.background = c.bg;
    panel.style.borderColor = c.border;
    panel.style.color = c.text;
  }
  const fab = document.getElementById("cb-fab");
  if (fab) {
    fab.style.background = c.accent;
    fab.style.color = contrastText(c.accent);
  }
}

// ---------- 全局UI状态 ----------
let panelVisible = false;
let panelRoot: HTMLDivElement | null = null;
let fabBadge: HTMLElement | null = null;
let currentStats: AccumulatedStats | null = null;
let COLORS = { ...LIGHT_COLORS };

export function loadConfig(): FilterConfig {
  try {
    const raw = GM_getValue("comment-block-config", "");
    if (raw) {
      const config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      COLORS = getColors(config);
      return config;
    }
  } catch {}
  const config = { ...DEFAULT_CONFIG };
  COLORS = getColors(config);
  return config;
}

export function saveConfig(config: FilterConfig): void {
  GM_setValue("comment-block-config", JSON.stringify(config));
  COLORS = getColors(config);
}

export function setStatsRef(stats: AccumulatedStats): void {
  currentStats = stats;
  updateFabBadge();
  updateStatsPanel();
}

function updateFabBadge(): void {
  if (fabBadge && currentStats) {
    const count = currentStats.totalFiltered;
    fabBadge.textContent = count > 0 ? String(count) : "R";
  }
}

export function injectUI(config: FilterConfig, onConfigChange: (cfg: FilterConfig) => void): void {
  COLORS = getColors(config);
  injectFloatingButton(config, onConfigChange);

  // 监听标记评论事件，实时更新AI面板
  window.addEventListener("cb-comment-marked", () => {
    if (panelRoot && panelVisible) {
      const aiTab = panelRoot.querySelector("#cb-tab-ai") as HTMLElement;
      if (aiTab && aiTab.style.display !== "none") {
        refreshAIPanel(panelRoot);
      }
    }
  });
}

function injectFloatingButton(config: FilterConfig, onConfigChange: (cfg: FilterConfig) => void): void {
  const btn = document.createElement("div");
  btn.id = "cb-fab";
  btn.title = "哔哩哔哩评论区屏蔽 - 设置";
  Object.assign(btn.style, {
    position: "fixed", bottom: "20px", right: "20px", zIndex: "99999",
    width: "40px", height: "40px", borderRadius: "50%", background: COLORS.accent,
    color: contrastText(COLORS.accent), display: "flex", alignItems: "center",
    justifyContent: "center", fontSize: "12px", fontWeight: "600",
    fontFamily: "system-ui, -apple-system, sans-serif", cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)", transition: "all 0.15s ease",
    userSelect: "none",
  });
  btn.textContent = "R";
  fabBadge = btn;

  btn.addEventListener("mouseenter", () => {
    btn.style.background = COLORS.accentHover;
    btn.style.color = contrastText(COLORS.accentHover);
    btn.style.transform = "scale(1.05)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = COLORS.accent;
    btn.style.color = contrastText(COLORS.accent);
    btn.style.transform = "scale(1)";
  });
  btn.addEventListener("click", () => toggleSettingsPanel(config, onConfigChange));

  document.body.appendChild(btn);
}

function toggleSettingsPanel(config: FilterConfig, onConfigChange: (cfg: FilterConfig) => void): void {
  if (panelRoot && panelVisible) {
    panelRoot.style.display = "none";
    panelVisible = false;
    return;
  }
  if (!panelRoot) {
    panelRoot = buildSettingsPanel(config, onConfigChange);
    document.body.appendChild(panelRoot);
  }
  panelRoot.style.display = "block";
  panelVisible = true;
}

function buildSettingsPanel(config: FilterConfig, onConfigChange: (cfg: FilterConfig) => void): HTMLDivElement {
  const root = document.createElement("div");
  root.id = "cb-panel";
  Object.assign(root.style, {
    position: "fixed", bottom: "70px", right: "20px", width: "360px", height: "520px",
    background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: "8px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.1)", zIndex: "99998", display: "none",
    overflow: "hidden", fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "13px", color: COLORS.text,
  });
  root.innerHTML = buildPanelHTML(config);
  document.body.appendChild(root);
  bindPanelEvents(root, config, onConfigChange);
  return root;
}

function buildPanelHTML(config: FilterConfig): string {
  return `
<div style="display:flex;flex-direction:column;height:520px">
  <div style="padding:14px 16px;border-bottom:1px solid ${COLORS.border}">
    <div style="font-size:14px;font-weight:600">哔哩哔哩评论区屏蔽</div>
    <div style="font-size:11px;color:${COLORS.textMuted};margin-top:2px">AI 驱动的评论过滤</div>
  </div>

  <div id="cb-tabs" style="display:flex;border-bottom:1px solid ${COLORS.border}">
    <button class="cb-tab active" data-tab="settings" style="flex:1;padding:10px;border:none;background:none;cursor:pointer;font-size:12px;font-weight:500;color:${COLORS.text};border-bottom:2px solid ${COLORS.text}">设置</button>
    <button class="cb-tab" data-tab="ai" style="flex:1;padding:10px;border:none;background:none;cursor:pointer;font-size:12px;font-weight:500;color:${COLORS.textMuted};border-bottom:2px solid transparent">AI学习</button>
    <button class="cb-tab" data-tab="keywords" style="flex:1;padding:10px;border:none;background:none;cursor:pointer;font-size:12px;font-weight:500;color:${COLORS.textMuted};border-bottom:2px solid transparent">关键词</button>
    <button class="cb-tab" data-tab="stats" style="flex:1;padding:10px;border:none;background:none;cursor:pointer;font-size:12px;font-weight:500;color:${COLORS.textMuted};border-bottom:2px solid transparent">统计</button>
  </div>

  <div id="cb-tab-settings" style="overflow-y:auto;flex:1;padding:16px;min-height:0">
    <div style="margin-bottom:14px">
      <label style="font-size:11px;color:${COLORS.textSecondary};display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">AI 服务提供商</label>
      <div style="display:flex;gap:6px">
        ${AI_PROVIDERS.map((p) => {
          const key = p.name.toLowerCase().includes("deepseek") ? "deepseek" : "mimo";
          const isActive = config.provider === key;
          return `<button class="cb-provider-btn" data-provider="${key}" data-endpoint="${p.apiEndpoint}" style="flex:1;padding:6px;border:1px solid ${isActive ? COLORS.text : COLORS.border};border-radius:4px;background:${isActive ? COLORS.text : COLORS.bg};color:${isActive ? contrastText(COLORS.text) : COLORS.text};font-size:11px;cursor:pointer">${p.name}</button>`;
        }).join("")}
        <button class="cb-provider-btn" data-provider="custom" style="flex:1;padding:6px;border:1px solid ${config.provider === "custom" ? COLORS.text : COLORS.border};border-radius:4px;background:${config.provider === "custom" ? COLORS.text : COLORS.bg};color:${config.provider === "custom" ? contrastText(COLORS.text) : COLORS.text};font-size:11px;cursor:pointer">自定义</button>
      </div>
    </div>
    <div style="margin-bottom:14px">
      <label style="font-size:11px;color:${COLORS.textSecondary};display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">API Key</label>
      <input id="cb-apikey" type="password" value="${escapeAttr(config.apiKeys?.[config.provider] ?? config.apiKey)}" placeholder="sk-xxxxxxxx" autocomplete="off"
        style="width:100%;padding:8px 10px;border:1px solid ${COLORS.border};border-radius:4px;font-size:13px;box-sizing:border-box;background:${COLORS.bg};color:${COLORS.text};outline:none">
    </div>
    <div style="margin-bottom:14px;display:${config.provider === "custom" ? "block" : "none"}">
      <label style="font-size:11px;color:${COLORS.textSecondary};display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">API Endpoint</label>
      <input id="cb-endpoint" type="text" value="${escapeAttr(config.apiEndpoint)}" autocomplete="off"
        style="width:100%;padding:8px 10px;border:1px solid ${COLORS.border};border-radius:4px;font-size:13px;box-sizing:border-box;background:${COLORS.bg};color:${COLORS.text};outline:none">
    </div>
    <div style="margin-bottom:14px">
      <label style="font-size:11px;color:${COLORS.textSecondary};display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">模型</label>
      <div style="display:flex;gap:6px">
        <input id="cb-model" type="text" value="${escapeAttr(config.model)}" placeholder="模型名称" autocomplete="off"
          style="flex:1;padding:8px 10px;border:1px solid ${COLORS.border};border-radius:4px;font-size:13px;box-sizing:border-box;background:${COLORS.bg};color:${COLORS.text};outline:none">
        <button id="cb-fetch-models" style="padding:8px 12px;border:1px solid ${COLORS.border};border-radius:4px;background:${COLORS.bg};color:${COLORS.text};font-size:11px;cursor:pointer;white-space:nowrap">获取列表</button>
      </div>
      <div id="cb-model-list" style="margin-top:6px;display:none">
        <select id="cb-model-select" style="width:100%;padding:6px 8px;border:1px solid ${COLORS.border};border-radius:4px;font-size:12px;background:${COLORS.bg};color:${COLORS.text};outline:none">
        </select>
      </div>
    </div>
    <div style="margin-bottom:10px">
      <label style="font-size:12px;display:flex;align-items:center;gap:8px;cursor:pointer">
        <input id="cb-local-only" type="checkbox" ${config.localOnly ? "checked" : ""} style="accent-color:${COLORS.accent}">
        本地模式 (断开AI，仅使用关键词+规则)
      </label>
    </div>
    <div id="cb-ai-settings" style="opacity:${config.localOnly ? "0.4" : "1"};pointer-events:${config.localOnly ? "none" : "auto"}">
      <div style="margin-bottom:10px">
        <label style="font-size:12px;display:flex;align-items:center;gap:8px;cursor:pointer">
          <input id="cb-enable-ai" type="checkbox" ${config.enableAI ? "checked" : ""} style="accent-color:${COLORS.accent}">
          启用自定义提示词
        </label>
      </div>
      <div id="cb-prompt-section" style="margin-bottom:14px;display:${config.enableAI ? "block" : "none"}">
        <label style="font-size:11px;color:${COLORS.textSecondary};display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">过滤提示词</label>
        <textarea id="cb-prompt" rows="2"
          style="width:100%;padding:8px 10px;border:1px solid ${COLORS.border};border-radius:4px;font-size:13px;box-sizing:border-box;background:${COLORS.bg};color:${COLORS.text};outline:none;font-family:inherit;resize:none;overflow:hidden;min-height:50px">${escapeHtml(config.prompt)}</textarea>
      </div>
      <div style="margin-bottom:10px">
        <label style="font-size:12px;display:flex;align-items:center;gap:8px;cursor:pointer">
          <input id="cb-enable-ai-prompt" type="checkbox" ${(config as any).enableAIPrompt ? "checked" : ""} style="accent-color:${COLORS.accent}">
          启用 AI 学习提示词
        </label>
      </div>
      <div id="cb-ai-prompt-section" style="margin-bottom:14px;display:${(config as any).enableAIPrompt ? "block" : "none"}">
        <label style="font-size:11px;color:${COLORS.textSecondary};display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">AI 学习提示词</label>
        <textarea id="cb-ai-prompt" rows="2"
          style="width:100%;padding:8px 10px;border:1px solid ${COLORS.border};border-radius:4px;font-size:12px;box-sizing:border-box;background:${COLORS.bg};color:${COLORS.text};outline:none;font-family:inherit;resize:none;overflow:hidden;min-height:40px">${escapeHtml((config as any).aiLearnedPrompt || "")}</textarea>
      </div>
    </div>
    <div style="margin-bottom:10px">
      <label style="font-size:12px;display:flex;align-items:center;gap:8px;cursor:pointer">
        <input id="cb-fold-mode" type="checkbox" ${config.foldMode ? "checked" : ""} style="accent-color:${COLORS.accent}">
        显示屏蔽评论 (关闭后完全隐藏)
      </label>
    </div>
    <div style="margin-bottom:14px">
      <label style="font-size:11px;color:${COLORS.textSecondary};display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">外观模式</label>
      <div style="display:flex;gap:6px">
        <button class="cb-theme-btn" data-theme="light" style="flex:1;padding:6px;border:1px solid ${config.darkMode === "light" ? COLORS.text : COLORS.border};border-radius:4px;background:${config.darkMode === "light" ? COLORS.text : COLORS.bg};color:${config.darkMode === "light" ? contrastText(COLORS.text) : COLORS.text};font-size:11px;cursor:pointer">亮色</button>
        <button class="cb-theme-btn" data-theme="auto" style="flex:1;padding:6px;border:1px solid ${config.darkMode === "auto" ? COLORS.text : COLORS.border};border-radius:4px;background:${config.darkMode === "auto" ? COLORS.text : COLORS.bg};color:${config.darkMode === "auto" ? contrastText(COLORS.text) : COLORS.text};font-size:11px;cursor:pointer">跟随系统</button>
        <button class="cb-theme-btn" data-theme="dark" style="flex:1;padding:6px;border:1px solid ${config.darkMode === "dark" ? COLORS.text : COLORS.border};border-radius:4px;background:${config.darkMode === "dark" ? COLORS.text : COLORS.bg};color:${config.darkMode === "dark" ? contrastText(COLORS.text) : COLORS.text};font-size:11px;cursor:pointer">暗色</button>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="cb-save" style="flex:1;padding:8px;border:none;border-radius:4px;background:${COLORS.accent};color:${contrastText(COLORS.accent)};font-size:12px;cursor:pointer;font-weight:500">保存设置</button>
      <button id="cb-test" style="padding:8px 14px;border:1px solid ${COLORS.border};border-radius:4px;background:${COLORS.bg};color:${COLORS.text};font-size:12px;cursor:pointer;font-weight:500">测试连接</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button id="cb-clear-cache" style="flex:1;padding:6px;border:1px solid ${COLORS.border};border-radius:4px;background:${COLORS.bg};color:${COLORS.textMuted};font-size:11px;cursor:pointer">清除缓存</button>
    </div>
    <div id="cb-status" style="margin-top:8px;font-size:11px;color:${COLORS.textMuted};min-height:16px"></div>
  </div>

  <div id="cb-tab-ai" style="display:none;overflow-y:auto;flex:1;padding:16px;min-height:0">
    <div id="cb-ai-content"></div>
  </div>

  <div id="cb-tab-keywords" style="display:none;overflow-y:auto;flex:1;padding:16px;min-height:0">
    <div id="cb-keywords-content"></div>
  </div>

  <div id="cb-tab-stats" style="display:none;overflow-y:auto;flex:1;padding:16px;min-height:0">
    <div id="cb-stats-content" style="font-size:13px">
      <div style="text-align:center;color:${COLORS.textMuted};padding:20px">暂无统计数据</div>
    </div>
  </div>
</div>`;
}

function bindPanelEvents(root: HTMLElement, config: FilterConfig, onConfigChange: (cfg: FilterConfig) => void): void {
  const tabs = root.querySelectorAll(".cb-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", async () => {
      tabs.forEach((t) => {
        (t as HTMLElement).style.color = COLORS.textMuted;
        (t as HTMLElement).style.borderBottomColor = "transparent";
      });
      const t = tab as HTMLElement;
      t.style.color = COLORS.text;
      t.style.borderBottomColor = COLORS.text;

      const tabName = t.dataset.tab;
      const panels = ["settings", "ai", "keywords", "stats"];
      for (const p of panels) {
        const el = root.querySelector(`#cb-tab-${p}`) as HTMLElement;
        if (el) el.style.display = p === tabName ? "block" : "none";
      }

      if (tabName === "ai") {
        refreshAIPanel(root);
      } else if (tabName === "keywords") {
        refreshKeywordsPanel(root);
      } else if (tabName === "stats") {
        updateStatsPanel();
      }
    });
  });

  // 深色模式切换
  root.querySelectorAll(".cb-theme-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = (btn as HTMLElement).dataset.theme as "light" | "auto" | "dark";
      if (!theme) return;
      config.darkMode = theme;
      COLORS = getColors(config);
      saveConfig(config);
      onConfigChange(config);
      // 重新构建面板
      root.innerHTML = buildPanelHTML(config);
      bindPanelEvents(root, config, onConfigChange);
      // 更新面板整体样式
      applyTheme(config);
    });
  });

  // 纯本地模式切换
  const localOnlyEl = root.querySelector("#cb-local-only") as HTMLInputElement;
  if (localOnlyEl) {
    localOnlyEl.addEventListener("change", () => {
      config.localOnly = localOnlyEl.checked;
      const aiSettings = root.querySelector("#cb-ai-settings") as HTMLElement;
      if (aiSettings) {
        aiSettings.style.opacity = config.localOnly ? "0.4" : "1";
        aiSettings.style.pointerEvents = config.localOnly ? "none" : "auto";
      }
      // 保存配置
      saveConfig(config);
      onConfigChange(config);
      // 触发重新扫描
      window.dispatchEvent(new CustomEvent("cb-config-changed"));
    });
  }

  // 启用自定义提示词切换
  const enableAiEl = root.querySelector("#cb-enable-ai") as HTMLInputElement;
  if (enableAiEl) {
    enableAiEl.addEventListener("change", () => {
      const promptSection = root.querySelector("#cb-prompt-section") as HTMLElement;
      if (promptSection) {
        promptSection.style.display = enableAiEl.checked ? "block" : "none";
      }
    });
  }

  // 启用AI学习提示词切换
  const enableAiPromptEl = root.querySelector("#cb-enable-ai-prompt") as HTMLInputElement;
  if (enableAiPromptEl) {
    enableAiPromptEl.addEventListener("change", () => {
      const aiPromptSection = root.querySelector("#cb-ai-prompt-section") as HTMLElement;
      if (aiPromptSection) {
        aiPromptSection.style.display = enableAiPromptEl.checked ? "block" : "none";
      }
    });
  }

  // AI 服务提供商切换
  root.querySelectorAll(".cb-provider-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const provider = (btn as HTMLElement).dataset.provider as "deepseek" | "mimo" | "custom";
      const endpoint = (btn as HTMLElement).dataset.endpoint;
      if (!provider) return;

      // 保存当前 API Key 到对应提供商
      const currentKeyInput = root.querySelector("#cb-apikey") as HTMLInputElement;
      if (currentKeyInput && config.apiKeys) {
        config.apiKeys[config.provider] = currentKeyInput.value;
      }

      // 切换提供商
      config.provider = provider;
      if (endpoint) config.apiEndpoint = endpoint;

      // 更新 provider 按钮样式
      root.querySelectorAll(".cb-provider-btn").forEach((b) => {
        const el = b as HTMLElement;
        const isActive = el.dataset.provider === provider;
        el.style.background = isActive ? COLORS.text : COLORS.bg;
        el.style.color = isActive ? contrastText(COLORS.text) : COLORS.text;
        el.style.borderColor = isActive ? COLORS.text : COLORS.border;
      });

      // 更新 API Key 输入框为对应提供商的 Key
      const newKeyInput = root.querySelector("#cb-apikey") as HTMLInputElement;
      if (newKeyInput && config.apiKeys) {
        newKeyInput.value = config.apiKeys[provider] ?? "";
      }

      // 显示/隐藏 endpoint 输入框
      const endpointRow = root.querySelector("#cb-endpoint")?.closest("div");
      if (endpointRow) {
        (endpointRow as HTMLElement).style.display = provider === "custom" ? "block" : "none";
      }
    });
  });

  // 获取模型列表
  root.querySelector("#cb-fetch-models")?.addEventListener("click", async () => {
    const apiKey = (root.querySelector("#cb-apikey") as HTMLInputElement)?.value;
    const endpoint = config.provider === "custom"
      ? (root.querySelector("#cb-endpoint") as HTMLInputElement)?.value
      : config.apiEndpoint;
    if (!apiKey) { showStatus(root, "请先填写 API Key", COLORS.danger); return; }
    showStatus(root, "获取模型列表...", COLORS.textMuted);
    const models = await fetchModels(endpoint, apiKey);
    if (models.length === 0) {
      showStatus(root, "未获取到模型列表", COLORS.textMuted);
      return;
    }
    showStatus(root, `获取到 ${models.length} 个模型`, COLORS.success);
    // 填充模型选择列表
    const selectEl = root.querySelector("#cb-model-select") as HTMLSelectElement;
    const listEl = root.querySelector("#cb-model-list") as HTMLElement;
    if (selectEl && listEl) {
      selectEl.innerHTML = models.map((m) =>
        `<option value="${m}" ${m === config.model ? "selected" : ""}>${m}</option>`
      ).join("");
      listEl.style.display = "block";
    }
  });

  // 模型选择
  root.querySelector("#cb-model-select")?.addEventListener("change", (e) => {
    const model = (e.target as HTMLSelectElement).value;
    const modelInput = root.querySelector("#cb-model") as HTMLInputElement;
    if (modelInput) modelInput.value = model;
  });

  // 过滤规则输入框自动扩充
  const promptEl = root.querySelector("#cb-prompt") as HTMLTextAreaElement;
  if (promptEl) {
    const autoResize = () => {
      promptEl.style.height = "auto";
      promptEl.style.height = promptEl.scrollHeight + "px";
    };
    promptEl.addEventListener("input", autoResize);
    // 初始调整
    setTimeout(autoResize, 0);
  }

  // AI提示词输入框自动扩充
  const aiPromptEl = root.querySelector("#cb-ai-prompt") as HTMLTextAreaElement;
  if (aiPromptEl) {
    const autoResizeAi = () => {
      aiPromptEl.style.height = "0";
      aiPromptEl.style.height = Math.max(40, aiPromptEl.scrollHeight) + "px";
    };
    aiPromptEl.addEventListener("input", autoResizeAi);
    // 初始调整 - 多次尝试确保正确
    setTimeout(autoResizeAi, 10);
    setTimeout(autoResizeAi, 100);
  }

  root.querySelector("#cb-save")?.addEventListener("click", () => {
    const currentApiKey = (root.querySelector("#cb-apikey") as HTMLInputElement)?.value ?? "";
    const apiKeys = config.apiKeys ? { ...config.apiKeys } : { deepseek: "", mimo: "", custom: "" };
    apiKeys[config.provider] = currentApiKey;

    const aiPromptValue = (root.querySelector("#cb-ai-prompt") as HTMLTextAreaElement)?.value ?? (config as any).aiLearnedPrompt ?? "";
    const enableAIPromptValue = (root.querySelector("#cb-enable-ai-prompt") as HTMLInputElement)?.checked ?? false;

    const newConfig: FilterConfig = {
      ...config,
      apiKey: currentApiKey,
      apiKeys,
      apiEndpoint: config.provider === "custom"
        ? (root.querySelector("#cb-endpoint") as HTMLInputElement)?.value ?? config.apiEndpoint
        : config.apiEndpoint,
      model: (root.querySelector("#cb-model") as HTMLInputElement)?.value ?? config.model,
      prompt: (root.querySelector("#cb-prompt") as HTMLTextAreaElement)?.value ?? config.prompt,
      localOnly: (root.querySelector("#cb-local-only") as HTMLInputElement)?.checked ?? false,
      enableAI: config.localOnly ? false : ((root.querySelector("#cb-enable-ai") as HTMLInputElement)?.checked ?? true),
      foldMode: (root.querySelector("#cb-fold-mode") as HTMLInputElement)?.checked ?? true,
      pricePerMToken: parseFloat((root.querySelector("#cb-price") as HTMLInputElement)?.value || "1.1") || 1.1,
    };

    // 保存AI提示词相关配置
    (newConfig as any).enableAIPrompt = enableAIPromptValue;
    (newConfig as any).aiLearnedPrompt = aiPromptValue;
    saveConfig(newConfig);
    onConfigChange(newConfig);
    showStatus(root, "已保存", COLORS.success);
  });

  root.querySelector("#cb-test")?.addEventListener("click", async () => {
    const apiKey = (root.querySelector("#cb-apikey") as HTMLInputElement)?.value;
    if (!apiKey) { showStatus(root, "请先填写 API Key", COLORS.danger); return; }
    showStatus(root, "测试中...", COLORS.textMuted);
    const ok = await testAPIConnection({ ...config, apiKey });
    showStatus(root, ok ? "连接成功" : "连接失败", ok ? COLORS.success : COLORS.danger);
  });

  root.querySelector("#cb-clear-cache")?.addEventListener("click", async () => {
    await clearCache();
    showStatus(root, "缓存已清除", COLORS.success);
  });
}

function showStatus(root: HTMLElement, msg: string, color: string): void {
  const el = root.querySelector("#cb-status");
  if (el) { el.textContent = msg; (el as HTMLElement).style.color = color; }
}

// ========== AI 学习管理 ==========

async function refreshAIPanel(root: HTMLElement): Promise<void> {
  const container = root.querySelector("#cb-ai-content");
  if (!container) return;

  const marked = await getAllMarkedComments();
  const unlearned = marked.filter((m) => !m.learned);
  const learned = marked.filter((m) => m.learned);
  const rules = await getAllAIRules();

  container.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:${COLORS.textSecondary}">
        待学习评论 (${unlearned.length}/1000)
      </div>
      <div style="font-size:11px;color:${COLORS.textMuted};margin-bottom:8px">点击评论菜单添加（给评论点踩可快速添加）</div>
      ${unlearned.length === 0 ? `<div style="padding:12px;text-align:center;color:${COLORS.textMuted};font-size:12px;border:1px dashed ${COLORS.border};border-radius:4px">暂无待学习评论</div>` : ""}
      <div style="max-height:120px;overflow-y:auto">
        ${unlearned.slice(0, 20).map((m) => `
          <div style="padding:6px 0;border-bottom:1px solid ${COLORS.border};display:flex;justify-content:space-between;align-items:center">
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;font-weight:500">${escapeHtml(m.uname)}</div>
              <div style="font-size:10px;color:${COLORS.textMuted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.message.slice(0, 60))}</div>
            </div>
            <button class="cb-mark-delete" data-id="${m.id}" style="padding:2px 6px;font-size:10px;background:transparent;border:1px solid ${COLORS.border};border-radius:2px;cursor:pointer;color:${COLORS.textMuted};margin-left:8px">删除</button>
          </div>
        `).join("")}
        ${unlearned.length > 20 ? `<div style="font-size:10px;color:${COLORS.textMuted};padding:4px 0;text-align:center">还有 ${unlearned.length - 20} 条...</div>` : ""}
      </div>
      ${unlearned.length > 0 ? `
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="cb-ai-learn" style="flex:1;padding:8px;border:none;border-radius:4px;background:${COLORS.accent};color:${contrastText(COLORS.accent)};font-size:12px;cursor:pointer;font-weight:500">开始学习</button>
          <button id="cb-mark-clear" style="padding:8px 12px;border:1px solid ${COLORS.danger};border-radius:4px;background:${COLORS.bg};color:${COLORS.danger};font-size:11px;cursor:pointer">清空</button>
        </div>
      ` : ""}
    </div>
    ${learned.length > 0 ? `
    <div style="margin-bottom:16px;border-top:1px solid ${COLORS.border};padding-top:12px">
      <details>
        <summary style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:${COLORS.textSecondary};cursor:pointer;user-select:none">
          已学习评论 (${learned.length})
        </summary>
        <div style="max-height:100px;overflow-y:auto;margin-top:8px">
          ${learned.map((m) => `
            <div style="padding:4px 0;border-bottom:1px solid ${COLORS.border};font-size:10px;color:${COLORS.textMuted};display:flex;justify-content:space-between;align-items:center">
              <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                <span style="font-weight:500;color:${COLORS.textSecondary}">${escapeHtml(m.uname)}</span>
                <span style="margin:0 4px">|</span>
                ${escapeHtml(m.message.slice(0, 40))}
              </div>
              <button class="cb-learned-delete" data-id="${m.id}" style="padding:1px 4px;font-size:9px;background:transparent;border:1px solid ${COLORS.border};border-radius:2px;cursor:pointer;color:${COLORS.textMuted};margin-left:4px;flex-shrink:0">删除</button>
            </div>
          `).join("")}
        </div>
      </details>
    </div>
    ` : ""}

    <div style="border-top:1px solid ${COLORS.border};padding-top:12px">
      <div style="font-weight:600;margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:${COLORS.textSecondary}">AI 生成的规则 (${rules.length})</div>
      ${rules.length === 0 ? `<div style="padding:12px;text-align:center;color:${COLORS.textMuted};font-size:12px;border:1px dashed ${COLORS.border};border-radius:4px">暂无AI规则</div>` : ""}
      <div style="max-height:150px;overflow-y:auto">
        ${rules.map((r) => `
          <div style="padding:8px 0;border-bottom:1px solid ${COLORS.border}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:10px;padding:1px 4px;border-radius:2px;background:${COLORS.bgHover};color:${COLORS.textSecondary}">${r.isRegex ? "正则" : "关键词"}</span>
              <button class="cb-rule-delete" data-id="${r.id}" style="padding:2px 6px;font-size:10px;background:transparent;border:1px solid ${COLORS.border};border-radius:2px;cursor:pointer;color:${COLORS.textMuted}">删除</button>
            </div>
            <div style="font-size:11px;margin-top:4px;font-family:${r.isRegex ? "monospace" : "inherit"}">${escapeHtml(r.pattern)}</div>
            <div style="font-size:10px;color:${COLORS.textMuted};margin-top:2px">${escapeHtml(r.description)}</div>
          </div>
        `).join("")}
      </div>
      ${rules.length > 0 ? `
        <button id="cb-rule-clear" style="width:100%;margin-top:8px;padding:6px;border:1px solid ${COLORS.danger};border-radius:4px;background:${COLORS.bg};color:${COLORS.danger};font-size:11px;cursor:pointer">清空规则</button>
      ` : ""}
    </div>
    <div id="cb-ai-status" style="margin-top:8px;font-size:11px;color:${COLORS.textMuted};min-height:16px"></div>
    
    <div style="border-top:1px solid ${COLORS.border};padding-top:12px;margin-top:12px">
      <div style="font-weight:600;margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:${COLORS.textSecondary}">标记评论管理</div>
      <div style="display:flex;gap:8px">
        <button id="cb-mark-export" style="flex:1;padding:6px;border:1px solid ${COLORS.border};border-radius:4px;background:${COLORS.bg};color:${COLORS.textSecondary};font-size:11px;cursor:pointer">导出 JSON</button>
        <button id="cb-mark-import" style="flex:1;padding:6px;border:1px solid ${COLORS.border};border-radius:4px;background:${COLORS.bg};color:${COLORS.textSecondary};font-size:11px;cursor:pointer">导入 JSON</button>
      </div>
      <input type="file" id="cb-mark-file" accept=".json" style="display:none">
    </div>
  `;

  // 绑定事件
  container.querySelectorAll(".cb-mark-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = parseInt((btn as HTMLElement).dataset.id ?? "0");
      if (id) {
        await removeMarkedComment(id);
        refreshAIPanel(root);
      }
    });
  });

  // 已学习评论删除
  container.querySelectorAll(".cb-learned-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = parseInt((btn as HTMLElement).dataset.id ?? "0");
      if (id) {
        await removeMarkedComment(id);
        refreshAIPanel(root);
      }
    });
  });

  container.querySelectorAll(".cb-rule-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = parseInt((btn as HTMLElement).dataset.id ?? "0");
      if (id) {
        await removeAIRule(id);
        refreshAIPanel(root);
      }
    });
  });

  // 开始学习
  container.querySelector("#cb-ai-learn")?.addEventListener("click", async () => {
    const learnBtn = container.querySelector("#cb-ai-learn") as HTMLButtonElement;
    const aiStatusEl = container.querySelector("#cb-ai-status") as HTMLElement;
    const rulesListEl = container.querySelector("#cb-ai-rules-list") as HTMLElement;
    
    // 禁用按钮，显示学习中
    if (learnBtn) {
      learnBtn.textContent = "学习中...";
      learnBtn.disabled = true;
      learnBtn.style.opacity = "0.6";
      learnBtn.style.cursor = "not-allowed";
    }
    if (aiStatusEl) { aiStatusEl.textContent = "正在向AI发送请求..."; aiStatusEl.style.color = COLORS.textMuted; }
    
    // 清空已生成规则区域
    if (rulesListEl) {
      rulesListEl.innerHTML = `<div style="padding:12px;text-align:center;color:${COLORS.textMuted};font-size:11px">等待AI返回结果...</div>`;
    }

    const allMarked = await getAllMarkedComments();
    const unlearned = allMarked.filter((m) => !m.learned);
    const allAIRules = await getAllAIRules();

    // 发送给AI的数据：已学习 + 未学习的评论
    const samplesForAI = allMarked.map((m) => ({ message: m.message, reason: m.reason }));

    // 获取点赞点踩的评论
    const likeComments = (currentStats?.recentFiltered ?? [])
      .filter((r) => r.feedback === "like")
      .map((r) => ({ message: r.message, reason: r.reason, rule: r.reason }));
    const dislikeComments = (currentStats?.recentFiltered ?? [])
      .filter((r) => r.feedback === "dislike")
      .map((r) => ({ message: r.message, reason: r.reason, rule: r.reason }));

    // 至少需要标记评论或点赞点踩评论才能学习
    if (samplesForAI.length < 3 && likeComments.length === 0 && dislikeComments.length === 0) {
      if (aiStatusEl) { aiStatusEl.textContent = "至少需要3条标记评论或点赞点踩才能学习"; aiStatusEl.style.color = COLORS.danger; }
      // 恢复按钮
      if (learnBtn) {
        learnBtn.textContent = "开始学习";
        learnBtn.disabled = false;
        learnBtn.style.opacity = "1";
        learnBtn.style.cursor = "pointer";
      }
      return;
    }

    // 获取配置
    const raw = GM_getValue("comment-block-config", "");
    const config: FilterConfig = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };

    if (!config.apiKey) {
      if (aiStatusEl) { aiStatusEl.textContent = "请先配置 API Key"; aiStatusEl.style.color = COLORS.danger; }
      // 恢复按钮
      if (learnBtn) {
        learnBtn.textContent = "开始学习";
        learnBtn.disabled = false;
        learnBtn.style.opacity = "1";
        learnBtn.style.cursor = "pointer";
      }
      return;
    }

    try {
      // 清空旧的AI规则，让AI重新生成
      await clearAIRules();

      // 发送已学习评论和AI规则给AI
      const existingAIRulesData = allAIRules.map((r) => ({ pattern: r.pattern, isRegex: r.isRegex, description: r.description }));
      const result = await learnFromMarked(config, samplesForAI, existingAIRulesData, likeComments, dislikeComments);
      
      if (result.rules.length === 0 && !result.aiPrompt) {
        if (aiStatusEl) { aiStatusEl.textContent = "未生成新规则"; aiStatusEl.style.color = COLORS.textMuted; }
        return;
      }

      // 保存新规则
      for (const r of result.rules) {
        await addAIRule({
          pattern: r.pattern,
          isRegex: r.isRegex,
          description: r.description,
          matchedComments: r.matchedComments || [],
          createdAt: Date.now(),
          lastLearnedAt: Date.now(),
          sampleCount: samplesForAI.length,
        });
      }

      // 保存AI提示词到配置（不直接应用）
      if (result.aiPrompt) {
        (config as any).aiLearnedPrompt = result.aiPrompt;
        GM_setValue("comment-block-config", JSON.stringify(config));
      }

      // 标记未学习的评论为已学习
      const unlearnedIds = unlearned.map((m) => m.id);
      if (unlearnedIds.length > 0) {
        await markCommentsAsLearned(unlearnedIds);
      }

      // 清空点赞点踩评论的 feedback 记录
      if (currentStats) {
        for (const item of currentStats.recentFiltered) {
          if (item.feedback) {
            item.feedback = null;
          }
        }
      }

      if (aiStatusEl) { aiStatusEl.textContent = `学习完成，生成 ${result.rules.length} 条规则${result.aiPrompt ? " + 提示词" : ""}`; aiStatusEl.style.color = COLORS.success; }
      refreshAIPanel(root);
    } catch (err) {
      if (aiStatusEl) { aiStatusEl.textContent = "学习失败: " + (err as Error).message; aiStatusEl.style.color = COLORS.danger; }
      // 恢复按钮
      if (learnBtn) {
        learnBtn.textContent = "开始学习";
        learnBtn.disabled = false;
        learnBtn.style.opacity = "1";
        learnBtn.style.cursor = "pointer";
      }
    }
  });

  // 清空标记
  container.querySelector("#cb-mark-clear")?.addEventListener("click", async () => {
    if (!confirm("确定要清空所有标记评论吗？")) return;
    await clearMarkedComments();
    refreshAIPanel(root);
  });

  // 清空规则
  container.querySelector("#cb-rule-clear")?.addEventListener("click", async () => {
    if (!confirm("确定要清空所有AI规则吗？")) return;
    await clearAIRules();
    refreshAIPanel(root);
  });

  // 导出标记评论
  container.querySelector("#cb-mark-export")?.addEventListener("click", async () => {
    const marks = await getAllMarkedComments();
    const json = JSON.stringify(marks, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cb-marked-comments-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(container as HTMLElement, "已导出", COLORS.success);
  });

  // 导入标记评论
  container.querySelector("#cb-mark-import")?.addEventListener("click", () => {
    const fileInput = container.querySelector("#cb-mark-file") as HTMLInputElement;
    if (fileInput) fileInput.click();
  });

  container.querySelector("#cb-mark-file")?.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("格式错误");
      let count = 0;
      for (const item of data) {
        if (item.uname && item.message) {
          await addMarkedComment({
            uname: item.uname,
            message: item.message,
            reason: item.reason || "导入",
            timestamp: item.timestamp || Date.now(),
          });
          count++;
        }
      }
      showStatus(container as HTMLElement, `已导入 ${count} 条`, COLORS.success);
      refreshAIPanel(root);
    } catch {
      showStatus(container as HTMLElement, "导入失败: JSON 格式错误", COLORS.danger);
    }
  });
}

// ========== 关键词管理 ==========

async function refreshKeywordsPanel(root: HTMLElement): Promise<void> {
  const container = root.querySelector("#cb-keywords-content");
  if (!container) return;

  const rules = await getAllKeywords();
  const aiRules = await getAllAIRules();

  container.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="cb-kw-input" type="text" placeholder="输入关键词或正则" autocomplete="off"
        style="flex:1;padding:7px 10px;border:1px solid ${COLORS.border};border-radius:4px;font-size:12px;box-sizing:border-box;background:${COLORS.bg};color:${COLORS.text};outline:none">
      <label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap">
        <input id="cb-kw-regex" type="checkbox" style="accent-color:${COLORS.accent}"> 正则
      </label>
      <button id="cb-kw-add" style="padding:7px 12px;border:none;border-radius:4px;background:${COLORS.accent};color:${contrastText(COLORS.accent)};font-size:11px;cursor:pointer;font-weight:500">添加</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button id="cb-kw-export" style="flex:1;padding:6px;border:1px solid ${COLORS.border};border-radius:4px;background:${COLORS.bg};color:${COLORS.textSecondary};font-size:11px;cursor:pointer">导出 JSON</button>
      <button id="cb-kw-import" style="flex:1;padding:6px;border:1px solid ${COLORS.border};border-radius:4px;background:${COLORS.bg};color:${COLORS.textSecondary};font-size:11px;cursor:pointer">导入 JSON</button>
      <button id="cb-kw-clear" style="padding:6px 12px;border:1px solid ${COLORS.danger};border-radius:4px;background:${COLORS.bg};color:${COLORS.danger};font-size:11px;cursor:pointer">清空</button>
    </div>
    <input type="file" id="cb-kw-file" accept=".json" style="display:none">
    
    <details style="border-top:1px solid ${COLORS.border};padding-top:8px;margin-bottom:8px">
      <summary style="font-size:11px;font-weight:600;color:${COLORS.textSecondary};cursor:pointer;user-select:none">
        AI 自动生成 (${aiRules.length})
      </summary>
      <div id="cb-ai-rules-list" style="margin-top:8px">
        ${aiRules.length === 0 ? `<div style="padding:8px;text-align:center;color:${COLORS.textMuted};font-size:11px">暂无</div>` : ""}
        ${aiRules.map((r) => `
          <div style="padding:8px 0;border-bottom:1px solid ${COLORS.border}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:10px;padding:1px 4px;border-radius:2px;background:${COLORS.bgHover};color:${COLORS.textSecondary}">${r.isRegex ? "正则" : "关键词"}</span>
              <button class="cb-ai-rule-delete" data-id="${r.id}" style="padding:2px 6px;font-size:10px;background:transparent;border:1px solid ${COLORS.border};border-radius:2px;cursor:pointer;color:${COLORS.textMuted}">删除</button>
            </div>
            <div style="font-size:11px;margin-top:3px;font-family:${r.isRegex ? "monospace" : "inherit"}">${escapeHtml(r.pattern)}</div>
            <div style="font-size:10px;color:${COLORS.textMuted};margin-top:2px">${escapeHtml(r.description)}</div>
          </div>
        `).join("")}
      </div>
    </details>

    <details style="border-top:1px solid ${COLORS.border};padding-top:8px">
      <summary style="font-size:11px;font-weight:600;color:${COLORS.textSecondary};cursor:pointer;user-select:none">
        自定义关键词 (${rules.length})
      </summary>
      <div id="cb-kw-list" style="margin-top:8px">
        ${rules.length === 0 ? `<div style="padding:8px;text-align:center;color:${COLORS.textMuted};font-size:11px">暂无</div>` : ""}
        ${rules.map((r) => buildKeywordItem(r)).join("")}
      </div>
    </details>
  `;

  // 绑定事件
  const kwInput = container.querySelector("#cb-kw-input") as HTMLInputElement;
  const kwRegex = container.querySelector("#cb-kw-regex") as HTMLInputElement;
  const addBtn = container.querySelector("#cb-kw-add");

  addBtn?.addEventListener("click", async () => {
    const pattern = kwInput.value.trim();
    if (!pattern) return;
    const rule: KeywordRule = {
      id: nextKeywordId(),
      pattern,
      isRegex: kwRegex.checked,
      enabled: true,
      note: "",
      timestamp: Date.now(),
    };
    await addKeyword(rule);
    kwInput.value = "";
    kwRegex.checked = false;
    refreshKeywordsPanel(root);
  });

  kwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (addBtn as HTMLElement)?.click();
  });

  // 导出
  container.querySelector("#cb-kw-export")?.addEventListener("click", async () => {
    const rules = await getAllKeywords();
    const json = JSON.stringify(rules, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cb-keywords-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(root, "已导出", COLORS.success);
  });

  // 导入
  container.querySelector("#cb-kw-import")?.addEventListener("click", () => {
    const fileInput = container.querySelector("#cb-kw-file") as HTMLInputElement;
    if (fileInput) fileInput.click();
  });

  container.querySelector("#cb-kw-file")?.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("格式错误");
      let count = 0;
      for (const item of data) {
        if (item.pattern && typeof item.pattern === "string") {
          await addKeyword({
            id: nextKeywordId(),
            pattern: item.pattern,
            isRegex: !!item.isRegex,
            enabled: item.enabled !== false,
            note: item.note || "",
            timestamp: item.timestamp || Date.now(),
          });
          count++;
        }
      }
      showStatus(root, `已导入 ${count} 条`, COLORS.success);
      refreshKeywordsPanel(root);
    } catch {
      showStatus(root, "导入失败: JSON 格式错误", COLORS.danger);
    }
  });

  // 清空
  container.querySelector("#cb-kw-clear")?.addEventListener("click", async () => {
    if (!confirm("确定要清空所有关键词规则吗？")) return;
    await clearKeywords();
    refreshKeywordsPanel(root);
  });

  // 单个规则事件
  bindKeywordEvents(container, root);
}

function buildKeywordItem(r: KeywordRule): string {
  const patternDisplay = r.isRegex ? `/${escapeHtml(r.pattern)}/` : escapeHtml(r.pattern);
  const typeLabel = r.isRegex ? "正则" : "关键词";
  const statusColor = r.enabled ? COLORS.success : COLORS.textMuted;

  return `
    <div class="cb-kw-item" data-id="${r.id}" style="padding:10px 12px;border-bottom:1px solid ${COLORS.border};${r.enabled ? "" : "opacity:0.5"}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
          <input class="cb-kw-toggle" type="checkbox" ${r.enabled ? "checked" : ""} data-id="${r.id}" style="accent-color:${COLORS.accent};cursor:pointer">
          <span style="font-size:11px;padding:1px 5px;border-radius:2px;background:${COLORS.bgHover};color:${COLORS.textSecondary}">${typeLabel}</span>
          <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${r.isRegex ? "monospace" : "inherit"}">${patternDisplay}</span>
        </div>
        <button class="cb-kw-delete" data-id="${r.id}" style="padding:2px 8px;font-size:10px;background:transparent;border:1px solid ${COLORS.border};border-radius:2px;cursor:pointer;color:${COLORS.textMuted};margin-left:8px">删除</button>
      </div>
    </div>
  `;
}

function bindKeywordEvents(container: Element, root: HTMLElement): void {
  container.querySelectorAll(".cb-kw-toggle").forEach((toggle) => {
    toggle.addEventListener("change", async () => {
      const id = parseInt((toggle as HTMLElement).dataset.id ?? "0");
      const rules = await getAllKeywords();
      const rule = rules.find((r) => r.id === id);
      if (rule) {
        rule.enabled = (toggle as HTMLInputElement).checked;
        await updateKeyword(rule);
        refreshKeywordsPanel(root);
      }
    });
  });

  container.querySelectorAll(".cb-kw-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = parseInt((btn as HTMLElement).dataset.id ?? "0");
      if (id) {
        await removeKeyword(id);
        // 直接移除DOM元素，不重新构建面板
        const item = (btn as HTMLElement).closest(".cb-kw-item");
        if (item) item.remove();
        // 更新计数
        const summaryEl = container.querySelector("details[open] summary") ?? container.querySelector("details summary");
        if (summaryEl) {
          const count = container.querySelectorAll(".cb-kw-item").length;
          summaryEl.textContent = `自定义关键词 (${count})`;
        }
      }
    });
  });

  // AI规则删除
  container.querySelectorAll(".cb-ai-rule-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = parseInt((btn as HTMLElement).dataset.id ?? "0");
      if (id) {
        await removeAIRule(id);
        // 直接移除DOM元素
        const item = (btn as HTMLElement).closest(".cb-ai-rule-item") ?? (btn as HTMLElement).parentElement?.parentElement;
        if (item) item.remove();
        // 更新计数
        const summaryEl = container.querySelector("details[open] summary") ?? container.querySelector("details summary");
        if (summaryEl) {
          const count = container.querySelectorAll(".cb-ai-rule-item, [data-id]").length - 1;
          summaryEl.textContent = `AI 自动生成 (${Math.max(0, count)})`;
        }
      }
    });
  });
}

// ========== 统计面板 ==========

function updateStatsPanel(): void {
  const contentEl = document.querySelector("#cb-stats-content");
  if (!contentEl || !currentStats) return;

  const s = currentStats;
  const tokensPerK = (s.totalTokens / 1000).toFixed(1);
  let price = 1.1;
  try {
    const cfg = JSON.parse(GM_getValue("comment-block-config", "{}"));
    price = cfg.pricePerMToken ?? 1.1;
  } catch {}
  const costEst = ((s.totalTokens / 1000000) * price).toFixed(4);

  // 构建屏蔽记录列表 - 按来源分组
  const recentList = s.recentFiltered ?? [];
  let recentHTML = "";
  if (recentList.length > 0) {
    // 分组：用户规则/AI规则/简介类/AI判定/标记/缓存
    const userList = recentList.filter((r) => r.reason.includes("包含关键词") || r.reason.includes("匹配正则"));
    const aiRuleList = recentList.filter((r) => r.reason.includes("AI规则"));
    const descList = recentList.filter((r) => r.reason.includes("简介复读"));
    const aiList = recentList.filter((r) => !r.reason.includes("包含关键词") && !r.reason.includes("匹配正则") && !r.reason.includes("AI规则") && !r.reason.includes("简介复读") && !r.reason.includes("缓存") && !r.reason.includes("已标记"));
    const markedList = recentList.filter((r) => r.reason.includes("已标记"));
    const cacheList = recentList.filter((r) => r.reason.includes("缓存"));

    const renderGroup = (title: string, items: FilteredComment[], color: string, showActions: boolean = false) => {
      if (items.length === 0) return "";
      return `
        <details style="margin-bottom:8px" open>
          <summary style="font-size:11px;font-weight:600;color:${color};cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px">
            <span style="width:6px;height:6px;border-radius:50%;background:${color}"></span>
            ${title} (${items.length})
          </summary>
          <div style="margin-top:6px">
            ${items.slice(0, 10).map((r) => {
              const time = new Date(r.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
              return `
              <div style="padding:6px 0;border-bottom:1px solid ${COLORS.border}">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                  <span style="font-size:11px;font-weight:500">${escapeHtml(r.uname)}</span>
                  <span style="font-size:9px;color:${COLORS.textMuted}">${time}</span>
                </div>
                <div style="font-size:11px;color:${COLORS.textSecondary};word-break:break-all;line-height:1.4">${escapeHtml(r.message.slice(0, 80))}${r.message.length > 80 ? "..." : ""}</div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
                  <span style="font-size:10px;color:${COLORS.textMuted}">${escapeHtml(r.reason)}</span>
                  ${showActions ? `
                  <div style="display:flex;gap:4px">
                    <button class="cb-feedback-like" data-id="${r.id}" data-uname="${escapeAttr(r.uname)}" data-message="${escapeAttr(r.message)}" data-reason="${escapeAttr(r.reason)}" style="padding:1px 4px;font-size:10px;background:transparent;border:1px solid ${COLORS.border};border-radius:2px;cursor:pointer;color:${COLORS.textMuted}" title="标记为正确过滤">+1</button>
                    <button class="cb-feedback-dislike" data-id="${r.id}" data-uname="${escapeAttr(r.uname)}" data-message="${escapeAttr(r.message)}" data-reason="${escapeAttr(r.reason)}" style="padding:1px 4px;font-size:10px;background:transparent;border:1px solid ${COLORS.border};border-radius:2px;cursor:pointer;color:${COLORS.textMuted}" title="标记为误判">-1</button>
                  </div>
                  ` : ""}
                </div>
              </div>`;
            }).join("")}
            ${items.length > 10 ? `<div style="font-size:10px;color:${COLORS.textMuted};padding:4px 0;text-align:center">还有 ${items.length - 10} 条...</div>` : ""}
          </div>
        </details>`;
    };

    recentHTML = `
      <div style="margin-top:16px">
        <div style="font-weight:600;margin-bottom:10px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:${COLORS.textSecondary}">屏蔽记录 (${recentList.length})</div>
        ${renderGroup("用户规则", userList, "#667eea")}
        ${renderGroup("AI规则", aiRuleList, "#764ba2", true)}
        ${renderGroup("简介类", descList, "#ff9800")}
        ${renderGroup("AI判定", aiList, "#f57c00", true)}
        ${renderGroup("用户标记", markedList, "#2e7d32")}
        ${renderGroup("缓存命中", cacheList, "#999", true)}
      </div>`;
  }

  contentEl.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:10px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:${COLORS.textSecondary}">统计</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="background:${COLORS.bgHover};padding:10px;border-radius:4px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:${COLORS.text}">${s.totalFiltered}</div>
          <div style="font-size:10px;color:${COLORS.textMuted};margin-top:2px">已过滤</div>
        </div>
        <div style="background:${COLORS.bgHover};padding:10px;border-radius:4px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:${COLORS.text}">${s.apiCalls}</div>
          <div style="font-size:10px;color:${COLORS.textMuted};margin-top:2px">API 调用</div>
        </div>
        <div style="background:${COLORS.bgHover};padding:10px;border-radius:4px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:${COLORS.text}">${tokensPerK}K</div>
          <div style="font-size:10px;color:${COLORS.textMuted};margin-top:2px">Token</div>
        </div>
        <div style="background:${COLORS.bgHover};padding:10px;border-radius:4px;text-align:center;cursor:pointer" id="cb-cost-setting" title="双击设置Token单价">
          <div style="font-size:18px;font-weight:700;color:${COLORS.text}">¥${costEst}</div>
          <div style="font-size:10px;color:${COLORS.textMuted};margin-top:2px">费用（双击设置）</div>
        </div>
      </div>
    </div>
    <div style="font-size:10px;color:${COLORS.textMuted};text-align:center;padding-top:4px;border-bottom:1px solid ${COLORS.border};padding-bottom:12px">
      ¥${price}/1M tokens · prompt ${(s.promptTokens / 1000).toFixed(1)}K · completion ${(s.completionTokens / 1000).toFixed(1)}K
    </div>
    ${recentHTML}
  `;

  // 绑定双击费用设置
  const costSetting = contentEl.querySelector("#cb-cost-setting");
  if (costSetting) {
    costSetting.addEventListener("dblclick", () => {
      const newPrice = prompt("设置 Token 单价 (元/百万)", String(price));
      if (newPrice !== null) {
        const parsed = parseFloat(newPrice);
        if (!isNaN(parsed) && parsed >= 0) {
          const raw = GM_getValue("comment-block-config", "{}");
          const config: FilterConfig = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
          config.pricePerMToken = parsed;
          GM_setValue("comment-block-config", JSON.stringify(config));
          updateStatsPanel();
        }
      }
    });
  }

  // 绑定赞/踩按钮事件
  bindFeedbackEvents(contentEl);
}

async function bindFeedbackEvents(container: Element): Promise<void> {
  // 点赞：标记为满意
  container.querySelectorAll(".cb-feedback-like").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const el = btn as HTMLElement;
      const id = parseFloat(el.dataset.id ?? "0");

      // 更新 currentStats 中的 feedback
      if (currentStats) {
        const item = currentStats.recentFiltered.find((r) => r.id === id);
        if (item) {
          item.feedback = "like";
        }
      }

      // 按钮状态
      el.textContent = "已标记";
      el.style.color = COLORS.success;
      el.style.borderColor = COLORS.success;
      el.style.cursor = "default";
      (el as HTMLButtonElement).disabled = true;

      // 隐藏踩按钮
      const dislikeBtn = el.parentElement?.querySelector(".cb-feedback-dislike") as HTMLElement;
      if (dislikeBtn) dislikeBtn.style.display = "none";
    });
  });

  // 点踩：标记为误判
  container.querySelectorAll(".cb-feedback-dislike").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const el = btn as HTMLElement;
      const id = parseFloat(el.dataset.id ?? "0");

      // 更新 currentStats 中的 feedback
      if (currentStats) {
        const item = currentStats.recentFiltered.find((r) => r.id === id);
        if (item) {
          item.feedback = "dislike";
        }
      }

      // 按钮状态
      el.textContent = "已标记";
      el.style.color = COLORS.danger;
      el.style.borderColor = COLORS.danger;
      el.style.cursor = "default";
      (el as HTMLButtonElement).disabled = true;

      // 隐藏赞按钮
      const likeBtn = el.parentElement?.querySelector(".cb-feedback-like") as HTMLElement;
      if (likeBtn) likeBtn.style.display = "none";
    });
  });
}
