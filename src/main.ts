// ============================================================
// main.ts - 入口
// ============================================================
import { injectUI, loadConfig, setStatsRef } from "./ui";
import type { FilterConfig, AccumulatedStats } from "./types";
import { DEFAULT_CONFIG } from "./types";
import {
  startDOMScanner,
  extractVideoInfo,
  updateContext,
  refreshConfig,
  setUpdateStats,
} from "./interceptor";
import { pruneCache } from "./db";

const TAG = "[comment-block]";

async function main(): Promise<void> {
  let config: FilterConfig = loadConfig();
  if (!config.apiKey) {
    config = { ...DEFAULT_CONFIG };
  }

  extractVideoInfo();
  startDOMScanner();

  const titleEl = document.querySelector("title");
  let lastUrl = window.location.href;
  if (titleEl) {
    new MutationObserver(() => {
      const newUrl = window.location.href;
      // 视频切换时清空统计记录
      if (newUrl !== lastUrl) {
        lastUrl = newUrl;
        window.dispatchEvent(new CustomEvent("cb-video-changed"));
      }
      updateContext({
        videoTitle: document.title.replace(/[ _-]哔哩哔哩.*$/, ""),
      });
    }).observe(titleEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  injectUI(config, (newConfig: FilterConfig) => {
    config = newConfig;
    refreshConfig(config);
  });

  // 连接 UI 统计更新
  setUpdateStats((s: AccumulatedStats) => {
    setStatsRef(s);
  });

  // 定期清理缓存
  setInterval(
    () => {
      pruneCache().catch(() => {});
    },
    60 * 60 * 1000,
  );
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", main);
else main();
