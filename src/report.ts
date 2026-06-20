// ============================================================
// report.ts - 举报联动: 触发原生举报弹窗 + 复制AI理由
// ============================================================

const TAG = "[ruozhi-filter]";

/** 复制文本到剪贴板 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

/** 查找包含指定文本的元素（shadow DOM 递归） */
function findElementByText(root: ParentNode, text: string): Element | null {
  const walk = (node: ParentNode): Element | null => {
    for (const child of node.children) {
      const el = child as HTMLElement;
      const t = el.innerText?.trim() || el.textContent?.trim() || "";
      if (t === text) return el;
      if ((el as Element).shadowRoot) {
        const found = walk((el as Element).shadowRoot!);
        if (found) return found;
      }
      if (el.children.length > 0) {
        const found = walk(el);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(
    root instanceof Element ? ((root as Element).shadowRoot ?? root) : root,
  );
}

/** 显示轻量 toast */
function showToast(msg: string, duration = 2500): void {
  const toast = document.createElement("div");
  toast.textContent = msg;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "60px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.82)",
    color: "#fff",
    padding: "10px 20px",
    borderRadius: "8px",
    fontSize: "14px",
    zIndex: "999999",
    fontFamily: "system-ui, sans-serif",
    pointerEvents: "none",
    transition: "opacity 0.3s",
  });
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/** 等待条件满足（用 requestAnimationFrame 轮询） */
function waitFor(checker: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (checker()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(check);
    };
    check();
  });
}

/**
 * 触发原生举报流程
 *
 * 关键: foldEl 将原评论元素设为 display:none，此时 shadow DOM 内
 * .click() 不会触发浏览器 UI。必须临时恢复 display，等浏览器重排后再操作。
 */
export async function triggerReport(
  commentEl: Element,
  reason: string,
): Promise<{ opened: boolean; reasonCopied: boolean }> {
  // Step 0: 复制理由
  const reasonCopied = await copyToClipboard(reason);
  if (reasonCopied) {
    showToast("✅ 已复制 AI 判定理由，请粘贴到举报框 (Cmd+V)");
  }

  const el = commentEl as HTMLElement;
  const prevDisplay = el.style.display;

  // ★ 恢复可见 + 等待浏览器重排
  el.style.display = "";
  await new Promise((r) => requestAnimationFrame(r));
  // 再等一帧确保样式已经计算完毕
  await new Promise((r) => requestAnimationFrame(r));

  try {
    const sr = el.shadowRoot;
    if (!sr) {
      console.warn(TAG, "⚠️ 评论元素无 shadowRoot");
      return { opened: false, reasonCopied };
    }

    // ── 找到 "更多" 按钮 ──
    const actionBar = sr.querySelector("bili-comment-action-buttons-renderer");
    if (!actionBar || !(actionBar as HTMLElement).shadowRoot) {
      console.warn(TAG, "⚠️ 未找到 action-buttons");
      return { opened: false, reasonCopied };
    }

    const actionSR = (actionBar as HTMLElement).shadowRoot!;
    const moreBtn = actionSR.querySelector(
      "#more button",
    ) as HTMLElement | null;
    if (!moreBtn) {
      console.warn(TAG, "⚠️ 未找到「更多」按钮");
      return { opened: false, reasonCopied };
    }

    console.log(TAG, "🔍 点击「更多」按钮...");
    moreBtn.click();

    // ── 等待菜单出现 ──
    // B站菜单通过 inline style 的 CSS 变量切换:
    //   隐藏: style=""
    //   显示: style="--bili-comment-menu-display:block;"
    const menuAppeared = await waitFor(() => {
      const m = actionSR.querySelector(
        "bili-comment-menu",
      ) as HTMLElement | null;
      if (!m || !m.shadowRoot) return false;
      const style = m.getAttribute("style") || "";
      return style.includes("--bili-comment-menu-display:block");
    }, 2000);

    if (!menuAppeared) {
      console.warn(
        TAG,
        "⚠️ 菜单未显示（未检测到 --bili-comment-menu-display:block）",
      );
      return { opened: false, reasonCopied };
    }

    console.log(TAG, "✅ 菜单已显示，查找「举报」...");

    const menuEl = actionSR.querySelector("bili-comment-menu") as HTMLElement;
    const menuSR = menuEl.shadowRoot!;
    const reportLi = findElementByText(menuSR, "举报") as HTMLElement | null;
    if (!reportLi) {
      console.warn(TAG, "⚠️ 菜单中未找到「举报」");
      return { opened: false, reasonCopied };
    }

    console.log(TAG, "🔍 点击「举报」...");
    reportLi.click();

    // ── 等举报弹窗，填入理由 ──
    waitAndFillReportForm(reason);

    console.log(TAG, "✅ 已触发原生举报");
    return { opened: true, reasonCopied };
  } finally {
    // 恢复折叠状态
    el.style.display = prevDisplay;
  }
}

/** 轮询等待举报表单出现，自动填入 AI 理由 */
function waitAndFillReportForm(reason: string): void {
  const start = Date.now();
  const MAX_WAIT = 3000;

  const tryFill = () => {
    const textareas = document.querySelectorAll(
      "textarea[placeholder*='举报'], textarea[maxlength='200']",
    );

    for (const ta of textareas) {
      if ((ta as HTMLTextAreaElement).value.trim() === "") {
        (ta as HTMLTextAreaElement).value = reason.slice(0, 200);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        console.log(TAG, "✅ 已自动填写举报理由");
        return;
      }
    }

    if (Date.now() - start < MAX_WAIT) {
      setTimeout(tryFill, 300);
    }
  };

  setTimeout(tryFill, 500);
}

/** 仅复制理由到剪贴板（不触发举报） */
export async function copyReason(reason: string): Promise<boolean> {
  const ok = await copyToClipboard(reason);
  if (ok) showToast("✅ 已复制 AI 判定理由，请粘贴到举报框 (Cmd+V)");
  return ok;
}
