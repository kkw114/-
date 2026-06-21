// ============================================================
// logger.ts - 黑名单记录 & 折叠日志 (简约版)
// ============================================================
import type { BlacklistRecord, BiliReply } from "./types";
import { getAllBlacklist, removeFromBlacklist } from "./db";

// ---------- 工具函数 ----------

/** 根据背景色亮度返回反色文字 */
function contrastText(bg: string): string {
  const hex = bg.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1a1a1a" : "#ffffff";
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------- 样式常量 ----------
const COLORS = {
  bg: "#ffffff",
  bgHover: "#f5f5f5",
  bgActive: "#e8e8e8",
  border: "#e0e0e0",
  text: "#1a1a1a",
  textSecondary: "#666666",
  textMuted: "#999999",
  warning: "#f57c00",
  warningBg: "#fff3e0",
  danger: "#d32f2f",
};

/** 生成折叠HTML */
export function createFoldHTML(
  reply: BiliReply,
  verdict: { reason: string },
): string {
  const user = reply.member.uname;

  return `
<div class="cb-folded" style="
  background: ${COLORS.warningBg};
  border: 1px solid ${COLORS.warning};
  border-radius: 4px;
  padding: 8px 12px;
  margin: 4px 0;
  font-size: 12px;
  color: ${COLORS.text};
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
">
  <span style="margin-right:6px;color:${COLORS.warning}">●</span>
  <span style="font-weight:500">${escapeHtml(user)}</span>
  <span style="margin:0 6px;color:${COLORS.border}">|</span>
  <span style="color:${COLORS.textSecondary}">${escapeHtml(verdict.reason)}</span>
  <span style="float:right;font-size:10px;color:${COLORS.textMuted}">▼</span>
</div>
<div class="cb-original" style="display:none;padding:8px 12px;background:${COLORS.bgHover};border-left:3px solid ${COLORS.warning};margin:4px 0;border-radius:0 4px 4px 0;font-size:12px;">
  <div style="margin-bottom:4px;font-size:10px;color:${COLORS.textMuted}">
    AI 判定: <strong>${escapeHtml(verdict.reason)}</strong>
  </div>
  <div style="color:${COLORS.text};white-space:pre-wrap;word-break:break-word">${escapeHtml(reply.content.message)}</div>
</div>`;
}

/** 生成黑名单管理面板HTML */
export async function buildBlacklistPanelHTML(): Promise<string> {
  const records = await getAllBlacklist();

  if (records.length === 0) {
    return `<div style="padding:16px;text-align:center;color:${COLORS.textMuted};font-size:12px">暂无黑名单记录</div>`;
  }

  const rows = records
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((r) => {
      const date = new Date(r.timestamp).toLocaleString("zh-CN");
      const uid = r.uid ?? 0;
      const sourceLabel = r.source === "manual" ? "手动" : "AI";
      const sourceBg = r.source === "manual" ? COLORS.danger : COLORS.warning;

      return `
      <div style="padding:10px 12px;border-bottom:1px solid ${COLORS.border}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-weight:500;font-size:12px">${escapeHtml(r.uname)}</span>
            <span style="background:${sourceBg};color:${contrastText(sourceBg)};font-size:9px;padding:1px 5px;border-radius:2px">${sourceLabel}</span>
          </div>
          <span style="font-size:10px;color:${COLORS.textMuted}">${date}</span>
        </div>
        <div style="color:${COLORS.textSecondary};margin:4px 0;font-size:11px;line-height:1.4">${escapeHtml(r.message.slice(0, 80))}${r.message.length > 80 ? "..." : ""}</div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="color:${COLORS.textMuted};font-size:10px">${escapeHtml(r.reason)}</span>
          <button class="cb-remove-bl" data-uid="${uid}"
            style="padding:2px 8px;font-size:10px;background:${COLORS.bg};border:1px solid ${COLORS.border};border-radius:2px;cursor:pointer;color:${COLORS.textSecondary};transition:all 0.15s"
            onmouseover="this.style.borderColor='${COLORS.danger}';this.style.color='${COLORS.danger}'"
            onmouseout="this.style.borderColor='${COLORS.border}';this.style.color='${COLORS.textSecondary}'">
            移除
          </button>
        </div>
      </div>`;
    })
    .join("");

  return rows;
}
