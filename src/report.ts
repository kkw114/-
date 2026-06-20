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
function findByText(root: ParentNode, text: string): Element | null {
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

/** 显示 toast */
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
 * 在 ShadowRoot 内递归查找选择器
 * （querySelector 不穿透嵌套 shadowRoot，需要用这个）
 */
function deepFind(root: ParentNode, selector: string): Element | null {
  const el = root.querySelector(selector);
  if (el) return el;
  for (const child of root.children) {
    const c = child as Element;
    if (c.shadowRoot) {
      const found = deepFind(c.shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 触发原生举报流程
 */
export async function triggerReport(
  commentEl: Element,
  reason: string,
): Promise<{ opened: boolean; reasonCopied: boolean }> {
  const reasonCopied = await copyToClipboard(reason);
  if (reasonCopied) showToast("✅ 已复制 AI 判定理由，请粘贴到举报框 (Cmd+V)");

  const el = commentEl as HTMLElement;

  // ★ 核心修复: closest() 不穿透 Shadow DOM 边界。
  //    el 如果在 bili-comment-renderer 的 shadowRoot 内部，
  //    需要用 getRootNode().host 取宿主元素。
  const rootNode = el.getRootNode();
  let renderer: HTMLElement;
  if (rootNode instanceof ShadowRoot) {
    renderer = rootNode.host as HTMLElement;
  } else {
    renderer =
      (el.closest("bili-comment-renderer") as HTMLElement) ??
      (el.closest("bili-comment-thread-renderer") as HTMLElement) ??
      el;
  }

  console.log(
    TAG,
    "🔍 评论容器:",
    renderer.tagName.toLowerCase(),
    "| shadowRoot:",
    !!renderer.shadowRoot,
    "| children:",
    renderer.shadowRoot?.children.length ?? 0,
  );

  const prevDisplay = renderer.style.display;
  renderer.style.display = "";
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));

  try {
    const sr = renderer.shadowRoot;
    if (!sr) {
      console.warn(TAG, "⚠️ 容器无 shadowRoot:", renderer.tagName);
      return { opened: false, reasonCopied };
    }

    // 用 deepFind 穿透可能嵌套的 shadowRoot
    const actionBar = deepFind(sr, "bili-comment-action-buttons-renderer");
    if (!actionBar || !(actionBar as HTMLElement).shadowRoot) {
      console.warn(TAG, "⚠️ 未找到 action-buttons");
      console.log(
        TAG,
        "  shadowRoot 子元素:",
        [...sr.children].map((c) => (c as HTMLElement).tagName.toLowerCase()),
      );
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

    console.log(TAG, "🔍 点击「更多」...");
    moreBtn.click();

    const menuAppeared = await waitFor(() => {
      const m = actionSR.querySelector(
        "bili-comment-menu",
      ) as HTMLElement | null;
      if (!m || !m.shadowRoot) return false;
      return (m.getAttribute("style") || "").includes(
        "--bili-comment-menu-display:block",
      );
    }, 2000);

    if (!menuAppeared) {
      console.warn(TAG, "⚠️ 菜单未显示");
      return { opened: false, reasonCopied };
    }

    const menuEl = actionSR.querySelector("bili-comment-menu") as HTMLElement;
    const reportLi = findByText(
      menuEl.shadowRoot!,
      "举报",
    ) as HTMLElement | null;
    if (!reportLi) {
      console.warn(TAG, "⚠️ 菜单中未找到「举报」");
      return { opened: false, reasonCopied };
    }

    console.log(TAG, "🔍 点击「举报」...");
    reportLi.click();
    waitAndFillReportForm(reason);

    console.log(TAG, "✅ 已触发原生举报");
    return { opened: true, reasonCopied };
  } finally {
    renderer.style.display = prevDisplay;
  }
}

function waitAndFillReportForm(reason: string): void {
  const start = Date.now();
  const MAX_WAIT = 4000;
  let attempts = 0;

  const tryFill = () => {
    attempts++;
    const popup = document.querySelector("bili-comments-popup");
    if (!popup) {
      if (Date.now() - start < MAX_WAIT) setTimeout(tryFill, 200);
      return;
    }

    const form = popup.querySelector("bili-comment-report-form");
    if (!form || !(form as HTMLElement).shadowRoot) {
      if (Date.now() - start < MAX_WAIT) setTimeout(tryFill, 200);
      return;
    }

    const formSR = (form as HTMLElement).shadowRoot!;

    if (attempts <= 2) {
      const allOptions = formSR.querySelectorAll("#option");
      for (const opt of allOptions) {
        const nameEl = opt.querySelector("#option-name");
        if (nameEl && (nameEl as HTMLElement).innerText?.includes("引战")) {
          const radio = opt.querySelector("bili-radio");
          if (radio && (radio as HTMLElement).shadowRoot) {
            const inputSpan = (radio as HTMLElement).shadowRoot!.querySelector(
              "#input",
            ) as HTMLElement | null;
            if (inputSpan) {
              inputSpan.click();
              console.log(TAG, "✅ 已选中「引战、不友善言论」");
              break;
            }
          }
          const input = opt.querySelector(
            'input[type="radio"][value="4"]',
          ) as HTMLElement | null;
          if (input) {
            input.click();
            break;
          }
        }
      }
      setTimeout(tryFill, 300);
      return;
    }

    const textarea = formSR.querySelector(
      "textarea[maxlength='200']",
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = reason.slice(0, 200);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      console.log(TAG, "✅ 已自动填写举报理由");
      return;
    }

    if (Date.now() - start < MAX_WAIT) setTimeout(tryFill, 300);
  };

  setTimeout(tryFill, 600);
}

export async function copyReason(reason: string): Promise<boolean> {
  const ok = await copyToClipboard(reason);
  if (ok) showToast("✅ 已复制 AI 判定理由，请粘贴到举报框 (Cmd+V)");
  return ok;
}
