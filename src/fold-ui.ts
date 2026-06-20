// ============================================================
// fold-ui.ts - 评论折叠/隐藏 UI 操作
// ============================================================
import { esc } from "./dom-utils";
import type { PendingComment } from "./comment-extractor";
import { triggerReport, copyReason } from "./report";

const TAG = "[ruozhi-filter]";

/** 折叠评论元素，显示折叠提示条 */
export function foldEl(
  el: Element,
  info: PendingComment,
  verdict: { reason: string; severity: string },
  style: "classic" | "light" = "classic",
): boolean {
  try {
    const labelMap: Record<string, string> = {
      low: "⚠️ 轻微不适",
      medium: "🚫 违规言论",
      high: "⛔ 严重违规",
      block: "🛑 永久拉黑",
    };
    const label = labelMap[verdict.severity] ?? "🚫 已过滤";

    const severityAccent: Record<string, string> = {
      low: "#c8c8c8",
      medium: "#d4a574",
      high: "#d47574",
      block: "#b87070",
    };
    const accent = severityAccent[verdict.severity] ?? "#ccc";

    // 严重以上显示举报按钮
    const showReportBtn =
      verdict.severity === "high" || verdict.severity === "block";
    const reportBtnsHTML = showReportBtn
      ? `<div style="margin-top:8px;display:flex;gap:8px">
  <button class="ruozhi-copy-reason" style="padding:3px 10px;font-size:12px;border:1px solid #d4a574;border-radius:4px;background:#fff;color:#d4a574;cursor:pointer">📋 复制理由</button>
  <button class="ruozhi-report-btn" style="padding:3px 10px;font-size:12px;border:1px solid #d47574;border-radius:4px;background:#fff;color:#d47574;cursor:pointer">🚨 举报此评论</button>
</div>`
      : "";

    const html =
      style === "classic"
        ? `<div class="ruozhi-folded" style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:8px 12px;margin:4px 0;font-size:13px;color:#856404;cursor:pointer;user-select:none;font-family:system-ui,sans-serif">
<span style="margin-right:8px">${label}</span><span style="font-weight:600">${esc(info.uname)}</span><span style="margin:0 8px;color:#ccc">|</span><span style="font-size:12px;color:#aaa">${esc(verdict.reason)}</span><span style="float:right;font-size:11px;color:#999">▼ 展开</span>
</div><div class="ruozhi-original" style="display:none;padding:8px 12px;background:#f8f9fa;border-left:3px solid #ffc107;margin:4px 0;border-radius:0 6px 6px 0;font-size:13px">
<div style="margin-bottom:6px;font-size:12px;color:#999">🧠 AI判定: <strong>${esc(verdict.reason)}</strong></div>
<div style="color:#333;white-space:pre-wrap;word-break:break-word">${esc(info.message)}</div>${reportBtnsHTML}</div>`
        : `<div class="ruozhi-folded" style="background:#fafafa;border-left:3px solid ${accent};padding:6px 12px;margin:4px 0;font-size:12px;color:#aaa;cursor:pointer;user-select:none;font-family:system-ui,sans-serif">
<span style="margin-right:6px">${label}</span><span style="color:#999">${esc(info.uname)}</span><span style="float:right;font-size:10px;color:#ccc">▾</span>
</div><div class="ruozhi-original" style="display:none;padding:6px 12px;background:#fafafa;border-left:3px solid #ddd;margin:0 0 4px 0;font-size:12px;color:#999">
<div style="margin-bottom:4px;font-size:11px;color:#bbb">AI判定: ${esc(verdict.reason)}</div>
<div style="color:#bbb;white-space:pre-wrap;word-break:break-word">${esc(info.message)}</div>${reportBtnsHTML}</div>`;

    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const foldElDiv = wrapper.firstElementChild as HTMLElement;
    const origElDiv = foldElDiv.nextElementSibling as HTMLElement;
    el.parentNode?.insertBefore(foldElDiv, el);
    el.parentNode?.insertBefore(origElDiv, el);
    (el as HTMLElement).style.display = "none";

    // ── 折叠条点击：展开/收起 ──
    foldElDiv.addEventListener("click", () => {
      const hidden = origElDiv.style.display === "none";
      origElDiv.style.display = hidden ? "block" : "none";
      const arrow = foldElDiv.querySelector("span:last-child");
      if (arrow) arrow.textContent = hidden ? "▴" : "▾";
    });

    // ── 举报按钮绑定 ──
    if (showReportBtn) {
      const copyBtn = origElDiv.querySelector(".ruozhi-copy-reason");
      const reportBtn = origElDiv.querySelector(".ruozhi-report-btn");

      copyBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        copyReason(verdict.reason);
      });

      reportBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerReport(el, verdict.reason);
      });
    }

    return true;
  } catch {
    return false;
  }
}

/** 直接隐藏评论元素 */
export function hideEl(el: Element): boolean {
  try {
    (el as HTMLElement).style.display = "none";
    return true;
  } catch {
    return false;
  }
}
