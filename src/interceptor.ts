// ============================================================
// interceptor.ts - 纯 DOM 扫描器
// ============================================================
import type {
  FilterConfig,
  BiliReply,
  ReplyContext,
  AccumulatedStats,
  BlacklistRecord,
} from "./types";
import { addMarkedComment, getAllMarkedComments, removeMarkedComment } from "./db";
import { filterLocal, filterAI } from "./filter";

const TAG = "[comment-block]";

// 全局统计
const blockStats: AccumulatedStats = {
  totalFiltered: 0,
  totalScanned: 0,
  apiCalls: 0,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  lastUpdate: 0,
  recentFiltered: [],
};
// 暴露到全局
if (typeof window !== "undefined") {
  (window as any).__comment_block_stats = blockStats;
}

// 延迟导入ui模块的updateStats避免循环依赖
let updateStats: (s: AccumulatedStats) => void = () => {};
export function setUpdateStats(fn: (s: AccumulatedStats) => void): void {
  updateStats = fn;
}

let currentContext: ReplyContext = { oid: 0, videoTitle: "", videoDesc: "" };
let getConfig = (): FilterConfig => {
  try {
    const raw = GM_getValue("comment-block-config", "");
    if (raw) return JSON.parse(raw);
  } catch {
    /* */
  }
  return {
    apiKey: "",
    apiKeys: {
      deepseek: "",
      mimo: "",
      custom: "",
    },
    provider: "deepseek",
    apiEndpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    prompt: "",
    foldMode: true,
    localOnly: false,
    enableAI: true,
    pricePerMToken: 1.1,
    darkMode: "auto",
  };
};
export function refreshConfig(cfg: FilterConfig): void {
  getConfig = () => cfg;
}
export function updateContext(ctx: Partial<ReplyContext>): void {
  if (ctx.oid) currentContext.oid = ctx.oid;
  if (ctx.videoTitle) currentContext.videoTitle = ctx.videoTitle;
  if (ctx.videoDesc) currentContext.videoDesc = ctx.videoDesc;
}

export function extractVideoInfo(): void {
  // 获取视频标题 - B站现在的页面结构
  const titleEl =
    document.querySelector("h1.video-title") ??
    document.querySelector(".video-info-title .tit") ??
    document.querySelector("[data-title]");
  if (titleEl) {
    currentContext.videoTitle =
      (titleEl as HTMLElement).dataset?.title ??
      titleEl.getAttribute("data-title") ??
      titleEl.getAttribute("title") ??
      titleEl.textContent?.trim() ??
      "";
  }

  // 获取视频简介
  const descEl =
    document.querySelector("#v_desc .desc-info-text") ??
    document.querySelector(".desc-info-text") ??
    document.querySelector(".basic-desc-info");
  if (descEl) {
    const t = descEl.textContent?.trim() ?? "";
    currentContext.videoDesc = t === "-" ? "" : t;
  }

  // 从 bili-comments 组件获取 oid
  const bc = document.querySelector("bili-comments");
  if (bc) {
    const p = bc.getAttribute("data-params");
    if (p) {
      const pts = p.split(",");
      if (pts.length >= 2) currentContext.oid = parseInt(pts[1]) || 0;
    }
  }

  // 从 __INITIAL_STATE__ 获取 aid
  if (!currentContext.oid) {
    try {
      for (const s of document.querySelectorAll("script")) {
        const m = (s.textContent ?? "").match(
          /window\.__INITIAL_STATE__\s*=\s*(\{.+?\});/,
        );
        if (m) {
          const data = JSON.parse(m[1]);
          const aid = data?.videoData?.aid ?? data?.aid;
          if (aid) {
            currentContext.oid = aid;
            break;
          }
        }
      }
    } catch {
      /* */
    }
  }

  // 从URL提取BV号 -> 可以后续用于API查询
  if (!currentContext.oid) {
    const bvMatch = location.pathname.match(/\/video\/(BV\w+)/);
  }
}

// ==================== 全页面诊断 ====================

function fullPageDiagnostic(): void {
  console.log(TAG, "══════ 诊断 ══════");

  // 1. 寻找 bili-comments web component
  const bc = document.querySelector("bili-comments");
  console.log(
    TAG,
    `📦 bili-comments: ${bc ? "✅ shadowRoot=" + !!bc.shadowRoot + " children=" + bc.children.length : "❌ 未找到"}`,
  );

  // 2. 寻找各种可能的评论区容器选择器
  const containerSelectors = [
    "#comment",
    "#commentapp",
    ".comment-container",
    ".reply-list",
    ".bb-comment",
    "[class*='comment']",
    "[class*='reply']",
    "[id*='comment']",
    "[id*='reply']",
  ];
  for (const sel of containerSelectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0 && els.length < 200) {
      const first = els[0];
      const id = first.id ? `#${first.id}` : "(无id)";
      const cls = (first as Element).className
        ? "." + (first as Element).className.split(" ").slice(0, 3).join(".")
        : "(无class)";
      console.log(
        TAG,
        `  📌 "${sel}" → ${els.length}个 ${(first as Element).tagName.toLowerCase()}${id}${cls}`,
      );
    }
  }

  // 3. 🔍 ShadowRoot 深度探查
  if (bc && bc.shadowRoot) {
    const sr = bc.shadowRoot;
    const allNodes = sr.querySelectorAll("*");
    console.log(TAG, `🔬 ShadowRoot 总节点: ${allNodes.length}`);

    // 统计标签类型
    const tagCounts = new Map<string, number>();
    allNodes.forEach((n) => {
      const t = n.tagName.toLowerCase();
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    });
    console.log(
      TAG,
      `  标签分布: ${[...tagCounts.entries()].map(([k, v]) => `${k}x${v}`).join(", ")}`,
    );

    // 查找评论项
    const itemChecks = [
      "[data-rpid]",
      ".reply-item",
      ".comment-item",
      ".reply-wrap",
      ".con",
      "bb-comment",
    ];
    for (const sel of itemChecks) {
      const count = sr.querySelectorAll(sel).length;
      console.log(TAG, `  🎯 "${sel}" → ${count}个`);
    }

    // 打印 ShadowRoot 第一层子元素结构
    console.log(TAG, "📋 ShadowRoot 直接子元素:");
    for (const child of sr.children) {
      const tag = child.tagName.toLowerCase();
      const id = child.id ? `#${child.id}` : "";
      const cls = child.className
        ? "." + child.className.split(" ").slice(0, 3).join(".")
        : "";
      const text = (child as HTMLElement).innerText?.slice(0, 60) ?? "";
      const childCount = child.querySelectorAll("*").length;
      console.log(
        TAG,
        `  <${tag}${id}${cls}> 子元素:${childCount} text:"${text}"`,
      );

      // 如果子元素少，继续展开一层
      if (childCount > 0 && childCount <= 30) {
        for (const c2 of child.children) {
          const t2 = c2.tagName.toLowerCase();
          const id2 = c2.id ? `#${c2.id}` : "";
          const cls2 = c2.className
            ? "." + c2.className.split(" ").slice(0, 2).join(".")
            : "";
          const txt2 = (c2 as HTMLElement).innerText?.slice(0, 50) ?? "";
          // 检查 data-* 属性
          const dataAttrs =
            c2 instanceof HTMLElement
              ? c2
                  .getAttributeNames()
                  .filter((a) => a.startsWith("data-"))
                  .join(", ")
              : "";
          console.log(
            TAG,
            `    <${t2}${id2}${cls2}>${dataAttrs ? " [" + dataAttrs + "]" : ""} "${txt2}"`,
          );
        }
      }
    }
  }

  // 4. 页面主要结构
  const mainSections = [
    "#reply",
    "#danmakuBox",
    ".player-auxiliary",
    ".video-info-container",
    ".video-data",
    "section",
  ];
  console.log(TAG, "📐 页面结构:");
  for (const sel of mainSections) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) console.log(TAG, `  ${sel}: ${els.length}个`);
  }

  console.log(TAG, "══════ 完成 ══════");
}

/** 手动探查函数：调用后滚动到评论区加载评论，再执行此函数 */
function inspectShadowRoot(): void {
  const bc = document.querySelector("bili-comments");
  if (!bc || !bc.shadowRoot) {
    console.log(TAG, "❌ bili-comments 或其 shadowRoot 未找到");
    return;
  }
  const sr = bc.shadowRoot;
  console.log(TAG, "══════ ShadowRoot 完整探查 ══════");
  console.log(TAG, `总节点数: ${sr.querySelectorAll("*").length}`);
  console.log(TAG, `直接子元素数: ${sr.children.length}`);

  // 递归打印结构
  function dump(el: Element, depth: number = 0): void {
    if (depth > 4) return;
    const indent = "  ".repeat(depth);
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className
      ? "." + el.className.split(" ").slice(0, 3).join(".")
      : "";
    const attrs =
      el instanceof HTMLElement
        ? el
            .getAttributeNames()
            .filter((a) => a !== "class" && a !== "id")
            .map((a) => `${a}="${el.getAttribute(a)}"`.slice(0, 60))
            .join(" ")
        : "";
    const text =
      (el as HTMLElement).innerText?.slice(0, 80)?.replace(/\n/g, " ") ?? "";
    console.log(TAG, `${indent}<${tag}${id}${cls}> ${attrs} "${text}"`);
    if (el.children.length <= 4) {
      for (const c of el.children) dump(c, depth + 1);
    } else if (depth < 3) {
      console.log(TAG, `${indent}  ... ${el.children.length}个子元素，取前4个`);
      for (let i = 0; i < Math.min(4, el.children.length); i++) {
        dump(el.children[i], depth + 1);
      }
    }
  }

  for (const child of sr.children) {
    dump(child, 0);
  }
  console.log(TAG, "══════ 探查完成 ══════");
}

// ==================== 评论扫描 & AI判定 ====================

interface PendingComment {
  el: Element;
  rpid: number;
  mid: number;
  uname: string;
  message: string;
}
let pendingBatch: PendingComment[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
const scannedRpids = new Set<number>();

/** 已发现的评论区容器选择器(运行时学习) */
let learnedCommentContainer: string | null = null;

/**
 * 获取评论根节点
 * 优先 bili-comments Shadow DOM → bili-comments → 常用选择器 → null
 * 绝不 fallback 到 document，防止误伤页面其他元素
 */
function getCommentRoot(): ParentNode | null {
  // 1. bili-comments web component (含 Shadow DOM)
  const bc = document.querySelector("bili-comments");
  if (bc && bc.shadowRoot) return bc.shadowRoot;
  if (bc) return bc;

  // 2. 常见评论区容器选择器
  const containerSelectors = [
    "#comment",
    "#commentapp",
    ".comment-container",
    ".reply-list",
    ".bb-comment",
  ];
  for (const sel of containerSelectors) {
    const el = document.querySelector(sel);
    if (el && el.querySelectorAll("*").length > 5) return el;
  }

  // 3. 返回null = 找不到评论区，不扫描
  return null;
}

/**
 * 在指定的根节点内查找评论元素
 * 使用多种策略，从精确到启发式
 */
function findCommentElements(
  root: ParentNode,
): NodeListOf<Element> | Element[] {
  // 策略1: bili-comment-thread-renderer (B站新版评论区自定义元素)
  let items = root.querySelectorAll("bili-comment-thread-renderer");
  if (items.length > 0) return items;

  // 策略2: data-rpid
  items = root.querySelectorAll("[data-rpid]");
  if (items.length > 0) return items;

  // 策略3: 常见评论项CSS类
  items = root.querySelectorAll(
    ".reply-item, .comment-item, .comment-list > div, .reply-wrap, bb-comment",
  );
  if (items.length > 0) return items;

  // 策略4: 启发式
  const divs = root.querySelectorAll("div");
  if (divs.length > 500) return [];

  const candidates: Element[] = [];
  for (const d of divs) {
    if (candidates.length >= 100) break;
    const childCount = d.querySelectorAll("*").length;
    if (childCount < 3 || childCount > 80) continue;
    const t = (d as HTMLElement).innerText?.trim() ?? "";
    if (t.length < 30 || t.length > 5000) continue;
    if (!t.includes("回复") || !t.includes("举报")) continue;
    candidates.push(d);
  }
  return candidates;
}

function scanPage(): void {
  const root = getCommentRoot();
  if (!root) return;

  const items = findCommentElements(root);
  if (items.length === 0) return;

  let found = 0;
  items.forEach((el) => {
    const info = extractComment(el);
    if (!info) return;

    // 注入标记按钮
    injectMarkButton(el, info);

    // 监听踩按钮，自动标记
    monitorDislikeButton(el, info);

    if (scannedRpids.has(info.rpid)) return;
    scannedRpids.add(info.rpid);
    found++;
    pendingBatch.push(info);
  });

  if (found > 0) {
    if (pendingBatch.length >= 20) flushBatch();
    else if (!batchTimer) batchTimer = setTimeout(flushBatch, 300);
  }
}

// ────────── 踩按钮监控 ──────────

const dislikeMonitored = new WeakSet<Element>();
const dislikeState = new WeakMap<Element, boolean>(); // 追踪踩按钮状态

/** 监听踩按钮，点击时自动标记评论，取消时移除标记 */
function monitorDislikeButton(el: Element, info: PendingComment): void {
  if (dislikeMonitored.has(el)) return;
  dislikeMonitored.add(el);

  const elShadow = el.shadowRoot ?? el;

  function tryMonitor(): boolean {
    try {
      const renderer = elShadow.querySelector("bili-comment-renderer");
      if (!renderer?.shadowRoot) return false;

      const actionBtns = renderer.shadowRoot.querySelector("bili-comment-action-buttons-renderer");
      if (!actionBtns?.shadowRoot) return false;

      const dislike = actionBtns.shadowRoot.querySelector("#dislike button");
      if (!dislike) return false;

      // 已监控则跳过
      if ((dislike as HTMLElement).dataset.cbMonitored) return true;
      (dislike as HTMLElement).dataset.cbMonitored = "1";

      dislike.addEventListener("click", async () => {
        try {
          const wasDisliked = dislikeState.get(dislike) ?? false;

          if (wasDisliked) {
            // 取消踩：移除标记
            const allMarked = await getAllMarkedComments();
            const match = allMarked.find(
              (m) => m.uname === info.uname && m.message === info.message && m.reason === "[踩]"
            );
            if (match) {
              await removeMarkedComment(match.id);
              console.log(TAG, "取消踩→移除标记: " + info.uname);
              window.dispatchEvent(new CustomEvent("cb-comment-marked"));
            }
            dislikeState.set(dislike, false);
          } else {
            // 踩：添加标记
            await addMarkedComment({
              uname: info.uname,
              message: info.message,
              reason: "[踩]",
              timestamp: Date.now(),
            });
            console.log(TAG, "踩→标记: " + info.uname);
            window.dispatchEvent(new CustomEvent("cb-comment-marked"));
            dislikeState.set(dislike, true);
          }
        } catch (err) {
          console.error(TAG, "踩按钮操作失败:", err);
        }
      });

      return true;
    } catch {
      return false;
    }
  }

  if (tryMonitor()) return;

  const observer = new MutationObserver(() => {
    if (tryMonitor()) observer.disconnect();
  });
  observer.observe(elShadow, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 5000);
}

// ────────── 标记评论功能 ──────────

const markButtonInjected = new WeakSet<Element>();

/** 在评论元素的菜单中注入标记选项 */
function injectMarkButton(el: Element, info: PendingComment): void {
  if (markButtonInjected.has(el)) return;
  markButtonInjected.add(el);

  const elShadow = el.shadowRoot ?? el;

  function tryInject(): boolean {
    try {
      const renderer = elShadow.querySelector("bili-comment-renderer");
      if (!renderer?.shadowRoot) return false;

      const actionBtns = renderer.shadowRoot.querySelector("bili-comment-action-buttons-renderer");
      if (!actionBtns?.shadowRoot) return false;

      const more = actionBtns.shadowRoot.querySelector("#more");
      if (!more) return false;

      const menu = more.querySelector("bili-comment-menu");
      if (!menu?.shadowRoot) return false;

      const ul = menu.shadowRoot.querySelector("ul#options");
      if (!ul) return false;

      // 已注入则跳过
      if (ul.querySelector(".cb-mark-item")) return true;

      const li = document.createElement("li");
      li.className = "cb-mark-item";
      li.textContent = "标记不想看 (脚本)";
      (li as HTMLElement).style.cursor = "pointer";

      li.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const reason = prompt("请输入不想看的原因（可留空）：");
        if (reason === null) return;

        try {
          await addMarkedComment({
            uname: info.uname,
            message: info.message,
            reason: reason || "未说明",
            timestamp: Date.now(),
          });
          console.log(TAG, "已标记评论: " + info.uname);

          // 触发自定义事件通知UI更新
          window.dispatchEvent(new CustomEvent("cb-comment-marked"));

          // 折叠评论
          const config = getConfig();
          if (config.foldMode) {
            foldEl(el, info, { reason: "[已标记] " + (reason || "用户不想看") });
          } else {
            hideEl(el);
          }
        } catch (err) {
          console.error(TAG, "标记失败:", err);
        }
      });

      ul.appendChild(li);
      return true;
    } catch {
      return false;
    }
  }

  // 尝试注入
  if (tryInject()) return;

  // 监听菜单出现
  const observer = new MutationObserver(() => {
    if (tryInject()) observer.disconnect();
  });
  observer.observe(elShadow, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 5000);
}

// ────────── scanPage ──────────

/** 从 DOM 节点提取评论信息 */
function extractComment(el: Element): PendingComment | null {
  try {
    const tag = el.tagName.toLowerCase();

    // 递归获取所有嵌套 shadowRoot 的 innerText
    let imgCount = 0;
    function deepInnerText(root: ParentNode): string {
      let text = "";
      for (const child of root.children) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        // 跳过 style 标签
        if (tag === "style") continue;
        // 跳过 IP 所在地
        if (el.id === "location") continue;
        // 跳过子评论容器
        if (el.id === "replies" || el.id === "reply-container" || tag === "bili-comment-reply-list" || tag === "bili-comments") continue;
        // 跳过头像相关元素
        if (el.id === "user-avatar" || tag === "bili-avatar" || tag === "bili-user-avatar") continue;
        // 统计 #pictures 区域内的图片数量（用户上传的图）
        if (el.id === "pictures") {
          imgCount += el.querySelectorAll("img").length;
          if (el.shadowRoot) imgCount += el.shadowRoot.querySelectorAll("img").length;
          continue;
        }
        // 表情包：小图片，提取 alt 文本
        if (tag === "img") {
          const alt = el.getAttribute("alt")?.trim();
          if (alt && !alt.startsWith("//") && alt.length < 20) {
            text += `[${alt}]`;
          }
          continue;
        }
        // 如果子元素有 shadowRoot，递归进入
        if (el.shadowRoot) {
          text += deepInnerText(el.shadowRoot) + "\n";
        } else if (el.children.length > 0) {
          text += deepInnerText(el) + "\n";
        } else {
          const t = (el as HTMLElement).innerText?.trim();
          if (t) text += t + "\n";
        }
      }
      return text;
    }

    // 从元素本身或 shadowRoot 读取文本
    let fullText = "";
    if (el.shadowRoot) {
      fullText = deepInnerText(el.shadowRoot).trim();
    }
    if (!fullText) {
      fullText = (el as HTMLElement).innerText?.trim() ?? "";
    }

    // 清理UI文本
    fullText = fullText
      .replace(/共\d+条回复/g, "")
      .replace(/拉黑用户\s*\(脚本\)/g, "")
      .replace(/标记不想看\s*\(脚本\)/g, "")
      .replace(/硬核会员举报/g, "")
      .replace(/回复\s*举报/g, "")
      .replace(/举报/g, "")
      .replace(/点赞/g, "")
      .replace(/\d+\s*踩/g, "")
      .replace(/展开\s*收起/g, "")
      .replace(/复制评论链接/g, "")
      .replace(/记笔记/g, "")
      .replace(/CD\.\s*/g, "")
      .trim();

    // 图片信息加在最后
    if (imgCount > 0) {
      fullText = `${fullText} [${imgCount}张图片]`;
    }

    if (fullText.length < 3) return null;

    // 1. 提取 rpid - 递归搜索所有nested shadowRoot
    let rpid = 0;
    function findRpid(root: ParentNode): string | null {
      const el = root.querySelector("[data-rpid]");
      if (el) return el.getAttribute("data-rpid");
      for (const child of root.children) {
        const c = child as Element;
        if (c.shadowRoot) {
          const r = findRpid(c.shadowRoot);
          if (r) return r;
        }
      }
      return null;
    }
    const rpidStr =
      el.getAttribute("data-rpid") ??
      (el.shadowRoot ? findRpid(el.shadowRoot) : null);
    if (rpidStr) rpid = parseInt(rpidStr);
    // fallback: 用评论内容+用户名生成稳定hash（因为新版B站Shadow DOM不暴露data-rpid）
    if (!rpid) {
      const hashInput = `${tag}:${fullText.slice(0, 300)}`;
      rpid = strHash(hashInput);
    }

    // 2. 提取 mid
    let mid = 0;
    function findMid(root: ParentNode): string | null {
      const el = root.querySelector("[data-mid], [data-uid]");
      if (el) return el.getAttribute("data-mid") ?? el.getAttribute("data-uid");
      for (const child of root.children) {
        const c = child as Element;
        if (c.shadowRoot) {
          const r = findMid(c.shadowRoot);
          if (r) return r;
        }
      }
      return null;
    }
    const midStr =
      el.getAttribute("data-mid") ??
      el.getAttribute("data-uid") ??
      (el.shadowRoot ? findMid(el.shadowRoot) : null);
    if (midStr) mid = parseInt(midStr) || 0;

    // 3. 解析用户名和内容
    const lines = fullText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const contentLines = lines.filter((l) => {
      if (IGNORE_TEXTS.has(l)) return false;
      if (isUIText(l)) return false;
      return true;
    });

    if (contentLines.length === 0) return null;

    const uname =
      contentLines.find(
        (l) =>
          l.length >= 2 &&
          l.length <= 20 &&
          !/^\d/.test(l) &&
          !l.includes("·") &&
          !l.includes("分钟") &&
          !l.includes("小时") &&
          !l.includes("刚刚") &&
          !l.includes("昨天") &&
          !l.includes("共") &&
          !l.includes("条回复") &&
          !l.includes("拉黑用户") &&
          !l.includes("脚本") &&
          !l.includes("举报") &&
          !l.includes("回复") &&
          !l.includes("点赞") &&
          !l.includes("踩") &&
          !l.includes("收起") &&
          !l.includes("展开") &&
          !l.includes("查看") &&
          !l.includes("复制") &&
          !l.includes("黑名单"),
      ) ?? "未知用户";

    const msgParts = contentLines.filter(
      (l) => l !== uname || contentLines.filter((x) => x === l).length > 1,
    );
    let message = msgParts.join(" ");

    if (uname !== "未知用户" && message.startsWith(uname)) {
      message = message.slice(uname.length).trim();
    }

    if (!message || message.length < 2) return null;

    return { el, rpid, mid, uname, message };
  } catch (e) {
    console.warn(TAG, "  ❌ extractComment 异常:", e);
    return null;
  }
}

/** 需要从评论文本中过滤掉的B站UI文本 */
const IGNORE_TEXTS = new Set([
  "回复",
  "举报",
  "硬核会员举报",
  "点赞",
  "踩",
  "收起",
  "展开",
  "·",
  ">>",
  "查看全文",
  "热评",
  "置顶",
  "UP主",
  "笔记",
  "UP主觉得很赞",
  "UP主赞过",
  "发起会话",
  "关注",
  "已关注",
  "复制评论链接",
  "加入黑名单",
  "记笔记",
]);

/** 需要过滤的时间/数字模式 */
function isUIText(s: string): boolean {
  // 纯数字/楼层/点赞数
  if (/^(\d+|[\d.]+[万亿]?|\d+:\d+|\d+楼|#\d+)$/.test(s)) return true;
  // 日期时间 "2026-02-12 15:26"
  if (/^\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}$/.test(s)) return true;
  // "刚刚" "X分钟前" "X小时前" "昨天" "X天前"
  if (/^(刚刚|\d+分钟前|\d+小时前|昨天|\d+天前)$/.test(s)) return true;
  // "共X条回复"
  if (/^共\d+条回复$/.test(s)) return true;
  // B站等级徽章 (LV0-LV6, CD等)
  if (/^(LV\d+|CD|\d{6})$/.test(s)) return true;
  return false;
}

function hashEl(el: Element): number {
  const t = (el as HTMLElement).innerText?.slice(0, 200) ?? el.tagName;
  return strHash(t);
}

/** 简单字符串hash (djb2) - 返回正整数 */
function strHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
  }
  return h;
}

let isFlushing = false;

async function flushBatch(): Promise<void> {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (pendingBatch.length === 0 || isFlushing) return;
  isFlushing = true;

  const batch = pendingBatch.splice(0);

  console.log(TAG, `处理 ${batch.length} 条评论`);

  const config = getConfig();
  if (!currentContext.videoTitle) extractVideoInfo();

  const replies: BiliReply[] = batch.map((p) => ({
    rpid: p.rpid,
    oid: currentContext.oid,
    mid: p.mid,
    root: 0,
    parent: 0,
    count: 0,
    rcount: 0,
    like: 0,
    ctime: 0,
    content: { message: p.message },
    member: { mid: String(p.mid), uname: p.uname, avatar: "" },
  }));

  try {
    // 第一阶段：本地快速过滤（立即执行）
    const localResult = await filterLocal(config, replies, currentContext, blockStats);

    // 立即处理本地过滤结果
    if (localResult.violations.size > 0) {
      console.log(TAG, `本地过滤: ${localResult.violations.size} 条`);
      for (const [rpid, v] of localResult.violations) {
        const p = batch.find((x) => x.rpid === rpid);
        if (!p) continue;
        if (config.foldMode ? foldEl(p.el, p, v) : hideEl(p.el)) {
          blockStats.recentFiltered.unshift({
            id: Date.now() + Math.random(),
            uname: p.uname,
            message: p.message,
            reason: v.reason,
            timestamp: Date.now(),
            feedback: null,
          });
          if (blockStats.recentFiltered.length > 50) {
            blockStats.recentFiltered.pop();
          }
        }
      }
      try { updateStats(blockStats); } catch {}
    }

    // 第二阶段：AI异步过滤（如果有需要）
    if (localResult.needAICheck.length > 0) {
      console.log(TAG, `AI判定: ${localResult.needAICheck.length} 条`);
      const aiViolations = await filterAI(config, localResult.needAICheck, currentContext, blockStats);

      if (aiViolations.size > 0) {
        console.log(TAG, `AI过滤: ${aiViolations.size} 条`);
        for (const [rpid, v] of aiViolations) {
          const p = batch.find((x) => x.rpid === rpid);
          if (!p) continue;
          if (config.foldMode ? foldEl(p.el, p, v) : hideEl(p.el)) {
            blockStats.recentFiltered.unshift({
              id: Date.now() + Math.random(),
              uname: p.uname,
              message: p.message,
              reason: v.reason,
              timestamp: Date.now(),
              feedback: null,
            });
            if (blockStats.recentFiltered.length > 50) {
              blockStats.recentFiltered.pop();
            }
          }
        }
        try { updateStats(blockStats); } catch {}
      }
    }
  } catch (err) {
    console.error(TAG, "AI失败:", err);
  } finally {
    isFlushing = false;
  }
}

/** 获取当前深色模式状态 */
function isDarkMode(): boolean {
  try {
    const raw = GM_getValue("comment-block-config", "");
    if (raw) {
      const config = JSON.parse(raw);
      if (config.darkMode === "dark") return true;
      if (config.darkMode === "light") return false;
      // auto: 跟随系统
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    }
  } catch {}
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function foldEl(
  el: Element,
  info: PendingComment,
  verdict: { reason: string },
): boolean {
  try {
    const dark = isDarkMode();
    const warningBg = dark ? "#3a2a1a" : "#fff3e0";
    const warning = dark ? "#ffb74d" : "#f57c00";
    const origBg = dark ? "#2a2a2a" : "#f5f5f5";
    const textColor = dark ? "#e0e0e0" : "#1a1a1a";
    const mutedColor = dark ? "#999" : "#666";

    const html = `<div class="cb-folded" style="background:${warningBg};border:1px solid ${warning};border-radius:4px;padding:8px 12px;margin:4px 0;font-size:12px;color:${textColor};cursor:pointer;user-select:none;font-family:system-ui,-apple-system,sans-serif">
<span style="margin-right:6px;color:${warning}">●</span><span style="font-weight:500">${esc(info.uname)}</span><span style="margin:0 6px;color:${dark ? '#555' : '#e0e0e0'}">|</span><span style="color:${mutedColor}">${esc(verdict.reason)}</span><span style="float:right;font-size:10px;color:${dark ? '#777' : '#999'}">▼</span>
</div><div class="cb-original" style="display:none;padding:8px 12px;background:${origBg};border-left:3px solid ${warning};margin:4px 0;border-radius:0 4px 4px 0;font-size:12px">
<div style="margin-bottom:4px;font-size:10px;color:${dark ? '#888' : '#999'}">AI 判定: <strong>${esc(verdict.reason)}</strong></div>
<div style="color:${textColor};white-space:pre-wrap;word-break:break-word">${esc(info.message)}</div></div>`;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const foldElDiv = wrapper.firstElementChild as HTMLElement;
    const origElDiv = foldElDiv.nextElementSibling as HTMLElement;
    el.parentNode?.insertBefore(foldElDiv, el);
    el.parentNode?.insertBefore(origElDiv, el);
    (el as HTMLElement).style.display = "none";
    foldElDiv.addEventListener("click", () => {
      const hidden = origElDiv.style.display === "none";
      origElDiv.style.display = hidden ? "block" : "none";
      const spanEl = foldElDiv.querySelector("span:last-child");
      if (spanEl) spanEl.textContent = hidden ? "▲" : "▼";
    });
    return true;
  } catch {
    return false;
  }
}

function hideEl(el: Element): boolean {
  try {
    const htmlEl = el as HTMLElement;
    // 使用高度过渡来减少抖动
    htmlEl.style.transition = "height 0.2s, margin 0.2s, padding 0.2s, opacity 0.2s";
    htmlEl.style.overflow = "hidden";
    htmlEl.style.height = htmlEl.offsetHeight + "px";
    // 强制重排
    htmlEl.offsetHeight;
    // 设置最终状态
    htmlEl.style.height = "0";
    htmlEl.style.margin = "0";
    htmlEl.style.padding = "0";
    htmlEl.style.opacity = "0";
    // 过渡完成后设置 display: none
    setTimeout(() => {
      htmlEl.style.display = "none";
    }, 200);
    return true;
  } catch {
    return false;
  }
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ==================== MutationObserver: 监听新评论加载 ====================

function watchNewComments(): void {
  const root = getCommentRoot();
  if (!root) {
    setTimeout(() => watchNewComments(), 3000);
    return;
  }

  const observer = new MutationObserver(() => {
    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        scanPage();
        batchTimer = null;
      }, 200);
    }
  });

  observer.observe(root as unknown as Node, {
    childList: true,
    subtree: true,
  });
  console.log(TAG, "👁️ MutationObserver 已绑定到评论根节点");
}

// ==================== 滚动加载检测 ====================

function watchScrollLoading(): void {
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;

  window.addEventListener(
    "scroll",
    () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scanPage();
        if (pendingBatch.length >= 10) flushBatch();
      }, 300);
    },
    { passive: true },
  );
}

// ==================== 启动 ====================

export function startDOMScanner(): void {
  // 初始扫描 - 立即 + 快速重试
  setTimeout(() => scanPage(), 500);
  setTimeout(() => scanPage(), 1500);
  setTimeout(() => scanPage(), 3000);

  // 周期性扫描 (每2秒)
  setInterval(() => {
    scanPage();
    if (pendingBatch.length >= 10) flushBatch();
  }, 2000);

  // 监听DOM变化 - 立即触发
  setTimeout(() => watchNewComments(), 300);

  // 监听滚动加载
  watchScrollLoading();

  // 监听配置变化（纯本地模式切换）
  window.addEventListener("cb-config-changed", () => {
    console.log(TAG, "配置变化，重新扫描");
    // 清除已扫描记录，重新扫描所有评论
    scannedRpids.clear();
    setTimeout(() => scanPage(), 100);
  });

  // 监听视频切换，清空统计记录
  window.addEventListener("cb-video-changed", () => {
    console.log(TAG, "视频切换，清空统计记录");
    blockStats.recentFiltered = [];
    blockStats.totalFiltered = 0;
    blockStats.apiCalls = 0;
    blockStats.totalTokens = 0;
    blockStats.promptTokens = 0;
    blockStats.completionTokens = 0;
    scannedRpids.clear();
    setTimeout(() => scanPage(), 500);
  });

  // 暴露调试接口
  const uw =
    typeof unsafeWindow !== "undefined" ? unsafeWindow : (window as any);
  uw.__comment_block_diag = () => {
    fullPageDiagnostic();
    scanPage();
  };
  uw.__comment_block_scan = () => scanPage();
  uw.__comment_block_flush = () => flushBatch();
  uw.__comment_block_inspect = () => inspectShadowRoot();

  // 调试：检查评论菜单结构
  uw.__comment_block_debug_menu = () => {
    const bc = document.querySelector("bili-comments");
    if (!bc?.shadowRoot) { console.log(TAG, "未找到 bili-comments shadowRoot"); return; }
    const sr = bc.shadowRoot;
    const threads = sr.querySelectorAll("bili-comment-thread-renderer");
    console.log(TAG, `找到 ${threads.length} 个评论线程`);
    threads.forEach((t, i) => {
      if (i > 0) return;
      console.log(TAG, `--- 评论 ${i} ---`);
      const tsr = t.shadowRoot;
      if (!tsr) return;
      const renderer = tsr.querySelector("bili-comment-renderer");
      if (!renderer?.shadowRoot) return;
      const actionBtns = renderer.shadowRoot.querySelector("bili-comment-action-buttons-renderer");
      if (!actionBtns?.shadowRoot) return;
      const asr = actionBtns.shadowRoot;
      const more = asr.querySelector("#more");
      if (!more) return;
      console.log(TAG, "  #more 内部:");
      for (const child of more.children) {
        const tag = child.tagName.toLowerCase();
        console.log(TAG, `    <${tag}>`);
      }
      const menu = more.querySelector("bili-comment-menu");
      if (!menu) { console.log(TAG, "    无 bili-comment-menu"); return; }
      console.log(TAG, "    menu.shadowRoot:", !!menu.shadowRoot);
      if (menu.shadowRoot) {
        console.log(TAG, "    menu.shadowRoot 子元素:");
        for (const child of menu.shadowRoot.children) {
          const tag = child.tagName.toLowerCase();
          const id = child.id ? `#${child.id}` : "";
          console.log(TAG, `      <${tag}${id}>`);
        }
        const ul = menu.shadowRoot.querySelector("ul#options");
        if (ul) {
          console.log(TAG, "      ul#options 内容:", ul.innerHTML.slice(0, 500));
        } else {
          console.log(TAG, "      无 ul#options，查找所有 ul:");
          const uls = menu.shadowRoot.querySelectorAll("ul");
          console.log(TAG, `      找到 ${uls.length} 个 ul`);
          uls.forEach((u, j) => {
            console.log(TAG, `        ul[${j}]: id=${u.id}, 内容=${u.innerHTML.slice(0, 200)}`);
          });
        }
      }
    });
  };
}
