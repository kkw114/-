// ==UserScript==
// @name         哔哩哔哩评论区屏蔽
// @namespace    bilibili-comment-block
// @version      1.0.0
// @author       monkey
// @description  AI驱动的B站评论过滤器，支持关键词屏蔽、黑名单、深色模式
// @license      MIT
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/list*
// @grant        GM_deleteValue
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  var _a;
  const AI_PROVIDERS = [
    {
      name: "DeepSeek",
      apiEndpoint: "https://api.deepseek.com/chat/completions",
      models: ["deepseek-chat", "deepseek-reasoner"]
    },
    {
      name: "Mimo (小米)",
      apiEndpoint: "https://api.xiaomimimo.com/v1/chat/completions",
      models: ["MiMo-7B-RL", "mimo-v2.5"]
    }
  ];
  const DEFAULT_CONFIG = {
    apiKey: "",
    apiKeys: {
      deepseek: "",
      mimo: "",
      custom: ""
    },
    provider: "deepseek",
    apiEndpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    prompt: "",
    foldMode: true,
    localOnly: false,
    enableAI: false,
    pricePerMToken: 1.1,
    darkMode: "auto"
  };
  const TAG$2 = "[comment-block]";
  function buildSystemPrompt(config, ctx) {
    return `你是一个评论净化判官。你的任务是根据用户的过滤规则，判断每条评论是否违规。

## 过滤规则
${config.prompt || "无"}

## 上下文
视频标题：${ctx.videoTitle}
视频简介：${ctx.videoDesc.slice(0, 500)}

## 输出要求
返回一个JSON对象，格式如下（不要包含任何markdown标记，只输出纯JSON）：
{
  "verdicts": [
    { "rpid": 123, "mid": 456, "violation": true, "reason": "违规原因" }
  ]
}

- 只返回违规的评论(violation=true)，没有违规则返回空数组`;
  }
  function buildUserMessage(replies) {
    const comments = replies.map((r) => ({
      rpid: r.rpid,
      mid: r.mid,
      uname: r.member.uname,
      content: r.content.message
    }));
    return JSON.stringify(comments, null, 2);
  }
  async function batchJudge(config, replies, ctx, extraPrompt) {
    var _a2, _b, _c;
    if (!config.apiKey || replies.length === 0) return { verdicts: [] };
    const systemPrompt = buildSystemPrompt(config, ctx) + (extraPrompt || "");
    const userMessage = buildUserMessage(replies);
    const fetchStart = Date.now();
    const fetcher = typeof unsafeWindow !== "undefined" ? unsafeWindow.fetch : window.fetch;
    try {
      const response = await fetcher(config.apiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ],
          temperature: 0.1,
          max_tokens: 4096,
          response_format: { type: "json_object" }
        })
      });
      console.log(
        TAG$2,
        `📡 API HTTP ${response.status}, ${Date.now() - fetchStart}ms`
      );
      if (!response.ok) {
        const errText = await response.text();
        console.error(TAG$2, `❌ API ${response.status}:`, errText.slice(0, 200));
        throw new Error(`DeepSeek API error ${response.status}`);
      }
      const data = await response.json();
      const content = (_c = (_b = (_a2 = data.choices) == null ? void 0 : _a2[0]) == null ? void 0 : _b.message) == null ? void 0 : _c.content;
      const usage = data.usage;
      if (!content) {
        console.warn(TAG$2, "⚠️ AI 返回空内容");
        return { verdicts: [], usage };
      }
      try {
        let jsonStr = content.trim();
        if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
        if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
        if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
        jsonStr = jsonStr.trim();
        const parsed = JSON.parse(jsonStr);
        return { verdicts: parsed.verdicts ?? [], usage };
      } catch (e) {
        console.error(TAG$2, "❌ AI 返回解析失败:", e);
        return { verdicts: [], usage };
      }
    } catch (err) {
      console.error(TAG$2, "❌ 网络请求失败:", err);
      throw err;
    }
  }
  async function testAPIConnection(config) {
    try {
      const fetcher = typeof unsafeWindow !== "undefined" ? unsafeWindow.fetch : window.fetch;
      const response = await fetcher(config.apiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5
        })
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async function fetchModels(apiEndpoint, apiKey) {
    try {
      const fetcher = typeof unsafeWindow !== "undefined" ? unsafeWindow.fetch : window.fetch;
      const modelsEndpoint = apiEndpoint.replace(/\/chat\/completions$/, "/models");
      const response = await fetcher(modelsEndpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      });
      if (!response.ok) return [];
      const data = await response.json();
      if ((data == null ? void 0 : data.data) && Array.isArray(data.data)) {
        return data.data.map((m) => m.id).filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }
  async function learnFromMarked(config, markedComments, existingAIRules, likeComments, dislikeComments) {
    var _a2, _b, _c;
    if (!config.apiKey || markedComments.length === 0 && (!likeComments || likeComments.length === 0) && (!dislikeComments || dislikeComments.length === 0)) return { rules: [], aiPrompt: "" };
    const fetcher = typeof unsafeWindow !== "undefined" ? unsafeWindow.fetch : window.fetch;
    const cleanMessage = (msg) => msg.replace(/\[\[.*?\]\]/g, "").replace(/\[.*?\]/g, "").trim();
    const samples = markedComments.map((c, i) => `${i + 1}. "${cleanMessage(c.message)}" (用户原因: ${c.reason || "未说明"})`).join("\n");
    const existingRulesText = existingAIRules.length > 0 ? `
已有的AI规则（请分析后合并/优化/删除，给出最终版本）：
${existingAIRules.map((r, i) => `${i + 1}. [${r.isRegex ? "正则" : "关键词"}] ${r.pattern} - ${r.description}`).join("\n")}` : "";
    let feedbackText = "";
    if (likeComments && likeComments.length > 0) {
      feedbackText += `
用户对这些评论的屏蔽效果满意：
${likeComments.map((c, i) => `${i + 1}. "${cleanMessage(c.message)}" (屏蔽原因: ${c.rule})`).join("\n")}`;
    }
    if (dislikeComments && dislikeComments.length > 0) {
      feedbackText += `
用户表示以下评论被规则误判：
${dislikeComments.map((c, i) => `${i + 1}. "${cleanMessage(c.message)}" (屏蔽原因: ${c.rule})`).join("\n")}`;
    }
    const prompt2 = `你是一个评论过滤规则生成器。用户标记了一些不想看的评论，请分析这些评论的共同特征，分类生成正则表达式、关键词规则，并生成一段AI提示词。

用户标记的评论：
${samples}
${existingRulesText}
${feedbackText}

请返回JSON格式：
{
  "regexRules": [
    {"pattern": "正则表达式", "description": "规则描述", "matchedComments": ["匹配到的评论1", "匹配到的评论2"]}
  ],
  "keywordRules": [
    {"pattern": "关键词", "description": "规则描述", "matchedComments": ["匹配到的评论1", "匹配到的评论2"]}
  ],
  "aiPrompt": "一段总结性的提示词，描述这些评论的共同特征，用于AI判断屏蔽"
}

要求：
1. 正则和关键词必须分开返回，不要混在一起
2. 正则表达式用于匹配模式特征（如重复字符、特定格式）
3. 关键词用于匹配具体词汇
4. 忽略表情符号（如[大哭]、[笑哭]等方括号内的表情），不要基于表情生成规则
5. matchedComments 必须填写用户标记评论的原文（去掉表情后），不要写"评论xx"，最多2条
6. 合并/优化已有规则，给出最终版本
7. aiPrompt 要总结所有标记评论的共同特征，是一段完整的描述
8. 返回纯JSON，不要markdown标记`;
    try {
      const response = await fetcher(config.apiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: prompt2 }],
          temperature: 0.3,
          max_tokens: 2048,
          response_format: { type: "json_object" }
        })
      });
      if (!response.ok) return { rules: [], aiPrompt: "" };
      const data = await response.json();
      const content = (_c = (_b = (_a2 = data.choices) == null ? void 0 : _a2[0]) == null ? void 0 : _b.message) == null ? void 0 : _c.content;
      if (!content) return { rules: [], aiPrompt: "" };
      let jsonStr = content.trim();
      if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
      if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
      if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
      const parsed = JSON.parse(jsonStr.trim());
      const regexRules = (parsed.regexRules ?? []).map((r) => ({ ...r, isRegex: true }));
      const keywordRules = (parsed.keywordRules ?? []).map((r) => ({ ...r, isRegex: false }));
      const rules = (parsed.rules ?? []).concat(regexRules, keywordRules);
      const aiPrompt = (parsed.aiPrompt ?? "") + "\n只有一个表情的表情符号的（如[[doge]]）";
      return {
        rules,
        aiPrompt
      };
    } catch {
      return { rules: [], aiPrompt: "" };
    }
  }
  const instanceOfAny = (object, constructors) => constructors.some((c) => object instanceof c);
  let idbProxyableTypes;
  let cursorAdvanceMethods;
  function getIdbProxyableTypes() {
    return idbProxyableTypes || (idbProxyableTypes = [
      IDBDatabase,
      IDBObjectStore,
      IDBIndex,
      IDBCursor,
      IDBTransaction
    ]);
  }
  function getCursorAdvanceMethods() {
    return cursorAdvanceMethods || (cursorAdvanceMethods = [
      IDBCursor.prototype.advance,
      IDBCursor.prototype.continue,
      IDBCursor.prototype.continuePrimaryKey
    ]);
  }
  const transactionDoneMap = /* @__PURE__ */ new WeakMap();
  const transformCache = /* @__PURE__ */ new WeakMap();
  const reverseTransformCache = /* @__PURE__ */ new WeakMap();
  function promisifyRequest(request) {
    const promise = new Promise((resolve, reject) => {
      const unlisten = () => {
        request.removeEventListener("success", success);
        request.removeEventListener("error", error);
      };
      const success = () => {
        resolve(wrap(request.result));
        unlisten();
      };
      const error = () => {
        reject(request.error);
        unlisten();
      };
      request.addEventListener("success", success);
      request.addEventListener("error", error);
    });
    reverseTransformCache.set(promise, request);
    return promise;
  }
  function cacheDonePromiseForTransaction(tx) {
    if (transactionDoneMap.has(tx))
      return;
    const done = new Promise((resolve, reject) => {
      const unlisten = () => {
        tx.removeEventListener("complete", complete);
        tx.removeEventListener("error", error);
        tx.removeEventListener("abort", error);
      };
      const complete = () => {
        resolve();
        unlisten();
      };
      const error = () => {
        reject(tx.error || new DOMException("AbortError", "AbortError"));
        unlisten();
      };
      tx.addEventListener("complete", complete);
      tx.addEventListener("error", error);
      tx.addEventListener("abort", error);
    });
    transactionDoneMap.set(tx, done);
  }
  let idbProxyTraps = {
    get(target, prop, receiver) {
      if (target instanceof IDBTransaction) {
        if (prop === "done")
          return transactionDoneMap.get(target);
        if (prop === "store") {
          return receiver.objectStoreNames[1] ? void 0 : receiver.objectStore(receiver.objectStoreNames[0]);
        }
      }
      return wrap(target[prop]);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has(target, prop) {
      if (target instanceof IDBTransaction && (prop === "done" || prop === "store")) {
        return true;
      }
      return prop in target;
    }
  };
  function replaceTraps(callback) {
    idbProxyTraps = callback(idbProxyTraps);
  }
  function wrapFunction(func) {
    if (getCursorAdvanceMethods().includes(func)) {
      return function(...args) {
        func.apply(unwrap(this), args);
        return wrap(this.request);
      };
    }
    return function(...args) {
      return wrap(func.apply(unwrap(this), args));
    };
  }
  function transformCachableValue(value) {
    if (typeof value === "function")
      return wrapFunction(value);
    if (value instanceof IDBTransaction)
      cacheDonePromiseForTransaction(value);
    if (instanceOfAny(value, getIdbProxyableTypes()))
      return new Proxy(value, idbProxyTraps);
    return value;
  }
  function wrap(value) {
    if (value instanceof IDBRequest)
      return promisifyRequest(value);
    if (transformCache.has(value))
      return transformCache.get(value);
    const newValue = transformCachableValue(value);
    if (newValue !== value) {
      transformCache.set(value, newValue);
      reverseTransformCache.set(newValue, value);
    }
    return newValue;
  }
  const unwrap = (value) => reverseTransformCache.get(value);
  function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
    const request = indexedDB.open(name, version);
    const openPromise = wrap(request);
    if (upgrade) {
      request.addEventListener("upgradeneeded", (event) => {
        upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
      });
    }
    if (blocked) {
      request.addEventListener("blocked", (event) => blocked(
        // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
        event.oldVersion,
        event.newVersion,
        event
      ));
    }
    openPromise.then((db) => {
      if (terminated)
        db.addEventListener("close", () => terminated());
      if (blocking) {
        db.addEventListener("versionchange", (event) => blocking(event.oldVersion, event.newVersion, event));
      }
    }).catch(() => {
    });
    return openPromise;
  }
  const readMethods = ["get", "getKey", "getAll", "getAllKeys", "count"];
  const writeMethods = ["put", "add", "delete", "clear"];
  const cachedMethods = /* @__PURE__ */ new Map();
  function getMethod(target, prop) {
    if (!(target instanceof IDBDatabase && !(prop in target) && typeof prop === "string")) {
      return;
    }
    if (cachedMethods.get(prop))
      return cachedMethods.get(prop);
    const targetFuncName = prop.replace(/FromIndex$/, "");
    const useIndex = prop !== targetFuncName;
    const isWrite = writeMethods.includes(targetFuncName);
    if (
      // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
      !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) || !(isWrite || readMethods.includes(targetFuncName))
    ) {
      return;
    }
    const method = async function(storeName, ...args) {
      const tx = this.transaction(storeName, isWrite ? "readwrite" : "readonly");
      let target2 = tx.store;
      if (useIndex)
        target2 = target2.index(args.shift());
      return (await Promise.all([
        target2[targetFuncName](...args),
        isWrite && tx.done
      ]))[0];
    };
    cachedMethods.set(prop, method);
    return method;
  }
  replaceTraps((oldTraps) => ({
    ...oldTraps,
    get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
    has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop)
  }));
  const advanceMethodProps = ["continue", "continuePrimaryKey", "advance"];
  const methodMap = {};
  const advanceResults = /* @__PURE__ */ new WeakMap();
  const ittrProxiedCursorToOriginalProxy = /* @__PURE__ */ new WeakMap();
  const cursorIteratorTraps = {
    get(target, prop) {
      if (!advanceMethodProps.includes(prop))
        return target[prop];
      let cachedFunc = methodMap[prop];
      if (!cachedFunc) {
        cachedFunc = methodMap[prop] = function(...args) {
          advanceResults.set(this, ittrProxiedCursorToOriginalProxy.get(this)[prop](...args));
        };
      }
      return cachedFunc;
    }
  };
  async function* iterate(...args) {
    let cursor = this;
    if (!(cursor instanceof IDBCursor)) {
      cursor = await cursor.openCursor(...args);
    }
    if (!cursor)
      return;
    cursor = cursor;
    const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
    ittrProxiedCursorToOriginalProxy.set(proxiedCursor, cursor);
    reverseTransformCache.set(proxiedCursor, unwrap(cursor));
    while (cursor) {
      yield proxiedCursor;
      cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
      advanceResults.delete(proxiedCursor);
    }
  }
  function isIteratorProp(target, prop) {
    return prop === Symbol.asyncIterator && instanceOfAny(target, [IDBIndex, IDBObjectStore, IDBCursor]) || prop === "iterate" && instanceOfAny(target, [IDBIndex, IDBObjectStore]);
  }
  replaceTraps((oldTraps) => ({
    ...oldTraps,
    get(target, prop, receiver) {
      if (isIteratorProp(target, prop))
        return iterate;
      return oldTraps.get(target, prop, receiver);
    },
    has(target, prop) {
      return isIteratorProp(target, prop) || oldTraps.has(target, prop);
    }
  }));
  const DB_NAME = "bilibili-comment-block-db";
  const DB_VERSION = 6;
  let dbPromise = null;
  function getDB() {
    if (!dbPromise) {
      dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            if (!db.objectStoreNames.contains("blacklist")) {
              const bl = db.createObjectStore("blacklist", { keyPath: "mid" });
              bl.createIndex("timestamp", "timestamp");
            }
          }
          if (oldVersion < 2) {
            if (db.objectStoreNames.contains("blacklist")) {
              db.deleteObjectStore("blacklist");
            }
            const bl = db.createObjectStore("blacklist", { keyPath: "uid" });
            bl.createIndex("timestamp", "timestamp");
          }
          if (oldVersion < 4) {
            if (!db.objectStoreNames.contains("keywords")) {
              const kw = db.createObjectStore("keywords", { keyPath: "id" });
              kw.createIndex("timestamp", "timestamp");
            }
          }
          if (oldVersion < 5) {
            if (!db.objectStoreNames.contains("marked")) {
              const mk = db.createObjectStore("marked", { keyPath: "id" });
              mk.createIndex("timestamp", "timestamp");
            }
            if (!db.objectStoreNames.contains("aiRules")) {
              const ar = db.createObjectStore("aiRules", { keyPath: "id" });
              ar.createIndex("createdAt", "createdAt");
            }
          }
          if (oldVersion < 6) {
            if (!db.objectStoreNames.contains("falsePositives")) {
              const fp = db.createObjectStore("falsePositives", { keyPath: "id" });
              fp.createIndex("timestamp", "timestamp");
            }
          }
          if (!db.objectStoreNames.contains("cache")) {
            const c = db.createObjectStore("cache", { keyPath: "hash" });
            c.createIndex("timestamp", "timestamp");
          }
        }
      });
    }
    return dbPromise;
  }
  function strHash$1(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) + h + s.charCodeAt(i) & 2147483647;
    }
    return h;
  }
  function commentHash(message, mid) {
    const input = `${mid}:${message.trim().slice(0, 200)}`;
    return strHash$1(input).toString(16);
  }
  async function getAllKeywords() {
    const db = await getDB();
    return db.getAll("keywords");
  }
  async function addKeyword(rule) {
    const db = await getDB();
    await db.put("keywords", rule);
  }
  async function updateKeyword(rule) {
    const db = await getDB();
    await db.put("keywords", rule);
  }
  async function removeKeyword(id) {
    const db = await getDB();
    await db.delete("keywords", id);
  }
  async function clearKeywords() {
    const db = await getDB();
    await db.clear("keywords");
  }
  async function getCache(hash) {
    const db = await getDB();
    const entry = await db.get("cache", hash);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1e3) {
      await db.delete("cache", hash);
      return null;
    }
    return entry;
  }
  async function setCache(entry) {
    const db = await getDB();
    await db.put("cache", entry);
  }
  async function clearCache() {
    const db = await getDB();
    await db.clear("cache");
  }
  async function pruneCache() {
    const db = await getDB();
    const all = await db.getAll("cache");
    all.sort((a, b) => b.timestamp - a.timestamp);
    const keep = all.slice(0, 5e3);
    const keepHashes = new Set(keep.map((e) => e.hash));
    const toDelete = all.filter((e) => !keepHashes.has(e.hash));
    const tx = db.transaction("cache", "readwrite");
    for (const entry of toDelete) {
      await tx.store.delete(entry.hash);
    }
    await tx.done;
  }
  const MAX_MARKED = 1e3;
  let markedIdCounter = Date.now();
  async function addMarkedComment(comment) {
    const db = await getDB();
    await db.put("marked", { ...comment, id: markedIdCounter++ });
    const all = await db.getAll("marked");
    if (all.length > MAX_MARKED) {
      all.sort((a, b) => a.timestamp - b.timestamp);
      const toDelete = all.slice(0, all.length - MAX_MARKED);
      const tx = db.transaction("marked", "readwrite");
      for (const item of toDelete) {
        await tx.store.delete(item.id);
      }
      await tx.done;
    }
  }
  async function getAllMarkedComments() {
    const db = await getDB();
    const all = await db.getAll("marked");
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }
  async function markCommentsAsLearned(ids) {
    const db = await getDB();
    const tx = db.transaction("marked", "readwrite");
    for (const id of ids) {
      const item = await tx.store.get(id);
      if (item) {
        item.learned = true;
        await tx.store.put(item);
      }
    }
    await tx.done;
  }
  async function removeMarkedComment(id) {
    const db = await getDB();
    await db.delete("marked", id);
  }
  async function clearMarkedComments() {
    const db = await getDB();
    await db.clear("marked");
  }
  let aiRuleIdCounter = Date.now();
  async function addAIRule(rule) {
    const db = await getDB();
    await db.put("aiRules", { ...rule, id: aiRuleIdCounter++ });
  }
  async function getAllAIRules() {
    const db = await getDB();
    return db.getAll("aiRules");
  }
  async function removeAIRule(id) {
    const db = await getDB();
    await db.delete("aiRules", id);
  }
  async function clearAIRules() {
    const db = await getDB();
    await db.clear("aiRules");
  }
  function contrastText(bg) {
    const hex = bg.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? "#1a1a1a" : "#ffffff";
  }
  function escapeAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
  let keywordIdCounter = Date.now();
  function nextKeywordId() {
    return keywordIdCounter++;
  }
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
    success: "#2e7d32"
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
    success: "#66bb6a"
  };
  let isDarkMode$1 = false;
  function systemPrefersDark() {
    var _a2;
    return ((_a2 = window.matchMedia) == null ? void 0 : _a2.call(window, "(prefers-color-scheme: dark)").matches) ?? false;
  }
  function resolveDarkMode(mode) {
    if (mode === "dark") return true;
    if (mode === "light") return false;
    return systemPrefersDark();
  }
  function getColors(config) {
    isDarkMode$1 = resolveDarkMode(config.darkMode);
    return isDarkMode$1 ? DARK_COLORS : LIGHT_COLORS;
  }
  (_a = window.matchMedia) == null ? void 0 : _a.call(window, "(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((currentConfig == null ? void 0 : currentConfig.darkMode) === "auto") {
      applyTheme(currentConfig);
    }
  });
  let currentConfig = null;
  function applyTheme(config) {
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
  let panelVisible = false;
  let panelRoot = null;
  let fabBadge = null;
  let currentStats = null;
  let COLORS = { ...LIGHT_COLORS };
  function loadConfig() {
    try {
      const raw = GM_getValue("comment-block-config", "");
      if (raw) {
        const config2 = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
        COLORS = getColors(config2);
        return config2;
      }
    } catch {
    }
    const config = { ...DEFAULT_CONFIG };
    COLORS = getColors(config);
    return config;
  }
  function saveConfig(config) {
    GM_setValue("comment-block-config", JSON.stringify(config));
    COLORS = getColors(config);
  }
  function setStatsRef(stats) {
    currentStats = stats;
    updateFabBadge();
    updateStatsPanel();
  }
  function updateFabBadge() {
    if (fabBadge && currentStats) {
      const count = currentStats.totalFiltered;
      fabBadge.textContent = count > 0 ? String(count) : "R";
    }
  }
  function injectUI(config, onConfigChange) {
    COLORS = getColors(config);
    injectFloatingButton(config, onConfigChange);
    window.addEventListener("cb-comment-marked", () => {
      if (panelRoot && panelVisible) {
        const aiTab = panelRoot.querySelector("#cb-tab-ai");
        if (aiTab && aiTab.style.display !== "none") {
          refreshAIPanel(panelRoot);
        }
      }
    });
  }
  function injectFloatingButton(config, onConfigChange) {
    const btn = document.createElement("div");
    btn.id = "cb-fab";
    btn.title = "哔哩哔哩评论区屏蔽 - 设置";
    Object.assign(btn.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "99999",
      width: "40px",
      height: "40px",
      borderRadius: "50%",
      background: COLORS.accent,
      color: contrastText(COLORS.accent),
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "12px",
      fontWeight: "600",
      fontFamily: "system-ui, -apple-system, sans-serif",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      transition: "all 0.15s ease",
      userSelect: "none"
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
  function toggleSettingsPanel(config, onConfigChange) {
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
  function buildSettingsPanel(config, onConfigChange) {
    const root = document.createElement("div");
    root.id = "cb-panel";
    Object.assign(root.style, {
      position: "fixed",
      bottom: "70px",
      right: "20px",
      width: "360px",
      height: "520px",
      background: COLORS.bg,
      border: `1px solid ${COLORS.border}`,
      borderRadius: "8px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.1)",
      zIndex: "99998",
      display: "none",
      overflow: "hidden",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "13px",
      color: COLORS.text
    });
    root.innerHTML = buildPanelHTML(config);
    document.body.appendChild(root);
    bindPanelEvents(root, config, onConfigChange);
    return root;
  }
  function buildPanelHTML(config) {
    var _a2;
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
      <input id="cb-apikey" type="password" value="${escapeAttr(((_a2 = config.apiKeys) == null ? void 0 : _a2[config.provider]) ?? config.apiKey)}" placeholder="sk-xxxxxxxx" autocomplete="off"
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
          <input id="cb-enable-ai-prompt" type="checkbox" ${config.enableAIPrompt ? "checked" : ""} style="accent-color:${COLORS.accent}">
          启用 AI 学习提示词
        </label>
      </div>
      <div id="cb-ai-prompt-section" style="margin-bottom:14px;display:${config.enableAIPrompt ? "block" : "none"}">
        <label style="font-size:11px;color:${COLORS.textSecondary};display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">AI 学习提示词</label>
        <textarea id="cb-ai-prompt" rows="2"
          style="width:100%;padding:8px 10px;border:1px solid ${COLORS.border};border-radius:4px;font-size:12px;box-sizing:border-box;background:${COLORS.bg};color:${COLORS.text};outline:none;font-family:inherit;resize:none;overflow:hidden;min-height:40px">${escapeHtml(config.aiLearnedPrompt || "")}</textarea>
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
  function bindPanelEvents(root, config, onConfigChange) {
    var _a2, _b, _c, _d, _e;
    const tabs = root.querySelectorAll(".cb-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", async () => {
        tabs.forEach((t2) => {
          t2.style.color = COLORS.textMuted;
          t2.style.borderBottomColor = "transparent";
        });
        const t = tab;
        t.style.color = COLORS.text;
        t.style.borderBottomColor = COLORS.text;
        const tabName = t.dataset.tab;
        const panels = ["settings", "ai", "keywords", "stats"];
        for (const p of panels) {
          const el = root.querySelector(`#cb-tab-${p}`);
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
    root.querySelectorAll(".cb-theme-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const theme = btn.dataset.theme;
        if (!theme) return;
        config.darkMode = theme;
        COLORS = getColors(config);
        saveConfig(config);
        onConfigChange(config);
        root.innerHTML = buildPanelHTML(config);
        bindPanelEvents(root, config, onConfigChange);
        applyTheme(config);
      });
    });
    const localOnlyEl = root.querySelector("#cb-local-only");
    if (localOnlyEl) {
      localOnlyEl.addEventListener("change", () => {
        config.localOnly = localOnlyEl.checked;
        const aiSettings = root.querySelector("#cb-ai-settings");
        if (aiSettings) {
          aiSettings.style.opacity = config.localOnly ? "0.4" : "1";
          aiSettings.style.pointerEvents = config.localOnly ? "none" : "auto";
        }
        saveConfig(config);
        onConfigChange(config);
        window.dispatchEvent(new CustomEvent("cb-config-changed"));
      });
    }
    const enableAiEl = root.querySelector("#cb-enable-ai");
    if (enableAiEl) {
      enableAiEl.addEventListener("change", () => {
        const promptSection = root.querySelector("#cb-prompt-section");
        if (promptSection) {
          promptSection.style.display = enableAiEl.checked ? "block" : "none";
        }
      });
    }
    const enableAiPromptEl = root.querySelector("#cb-enable-ai-prompt");
    if (enableAiPromptEl) {
      enableAiPromptEl.addEventListener("change", () => {
        const aiPromptSection = root.querySelector("#cb-ai-prompt-section");
        if (aiPromptSection) {
          aiPromptSection.style.display = enableAiPromptEl.checked ? "block" : "none";
        }
      });
    }
    root.querySelectorAll(".cb-provider-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        var _a3;
        const provider = btn.dataset.provider;
        const endpoint = btn.dataset.endpoint;
        if (!provider) return;
        const currentKeyInput = root.querySelector("#cb-apikey");
        if (currentKeyInput && config.apiKeys) {
          config.apiKeys[config.provider] = currentKeyInput.value;
        }
        config.provider = provider;
        if (endpoint) config.apiEndpoint = endpoint;
        root.querySelectorAll(".cb-provider-btn").forEach((b) => {
          const el = b;
          const isActive = el.dataset.provider === provider;
          el.style.background = isActive ? COLORS.text : COLORS.bg;
          el.style.color = isActive ? contrastText(COLORS.text) : COLORS.text;
          el.style.borderColor = isActive ? COLORS.text : COLORS.border;
        });
        const newKeyInput = root.querySelector("#cb-apikey");
        if (newKeyInput && config.apiKeys) {
          newKeyInput.value = config.apiKeys[provider] ?? "";
        }
        const endpointRow = (_a3 = root.querySelector("#cb-endpoint")) == null ? void 0 : _a3.closest("div");
        if (endpointRow) {
          endpointRow.style.display = provider === "custom" ? "block" : "none";
        }
      });
    });
    (_a2 = root.querySelector("#cb-fetch-models")) == null ? void 0 : _a2.addEventListener("click", async () => {
      var _a3, _b2;
      const apiKey = (_a3 = root.querySelector("#cb-apikey")) == null ? void 0 : _a3.value;
      const endpoint = config.provider === "custom" ? (_b2 = root.querySelector("#cb-endpoint")) == null ? void 0 : _b2.value : config.apiEndpoint;
      if (!apiKey) {
        showStatus(root, "请先填写 API Key", COLORS.danger);
        return;
      }
      showStatus(root, "获取模型列表...", COLORS.textMuted);
      const models = await fetchModels(endpoint, apiKey);
      if (models.length === 0) {
        showStatus(root, "未获取到模型列表", COLORS.textMuted);
        return;
      }
      showStatus(root, `获取到 ${models.length} 个模型`, COLORS.success);
      const selectEl = root.querySelector("#cb-model-select");
      const listEl = root.querySelector("#cb-model-list");
      if (selectEl && listEl) {
        selectEl.innerHTML = models.map(
          (m) => `<option value="${m}" ${m === config.model ? "selected" : ""}>${m}</option>`
        ).join("");
        listEl.style.display = "block";
      }
    });
    (_b = root.querySelector("#cb-model-select")) == null ? void 0 : _b.addEventListener("change", (e) => {
      const model = e.target.value;
      const modelInput = root.querySelector("#cb-model");
      if (modelInput) modelInput.value = model;
    });
    const promptEl = root.querySelector("#cb-prompt");
    if (promptEl) {
      const autoResize = () => {
        promptEl.style.height = "auto";
        promptEl.style.height = promptEl.scrollHeight + "px";
      };
      promptEl.addEventListener("input", autoResize);
      setTimeout(autoResize, 0);
    }
    const aiPromptEl = root.querySelector("#cb-ai-prompt");
    if (aiPromptEl) {
      const autoResizeAi = () => {
        aiPromptEl.style.height = "0";
        aiPromptEl.style.height = Math.max(40, aiPromptEl.scrollHeight) + "px";
      };
      aiPromptEl.addEventListener("input", autoResizeAi);
      setTimeout(autoResizeAi, 10);
      setTimeout(autoResizeAi, 100);
    }
    (_c = root.querySelector("#cb-save")) == null ? void 0 : _c.addEventListener("click", () => {
      var _a3, _b2, _c2, _d2, _e2, _f, _g, _h, _i, _j;
      const currentApiKey = ((_a3 = root.querySelector("#cb-apikey")) == null ? void 0 : _a3.value) ?? "";
      const apiKeys = config.apiKeys ? { ...config.apiKeys } : { deepseek: "", mimo: "", custom: "" };
      apiKeys[config.provider] = currentApiKey;
      const aiPromptValue = ((_b2 = root.querySelector("#cb-ai-prompt")) == null ? void 0 : _b2.value) ?? config.aiLearnedPrompt ?? "";
      const enableAIPromptValue = ((_c2 = root.querySelector("#cb-enable-ai-prompt")) == null ? void 0 : _c2.checked) ?? false;
      const newConfig = {
        ...config,
        apiKey: currentApiKey,
        apiKeys,
        apiEndpoint: config.provider === "custom" ? ((_d2 = root.querySelector("#cb-endpoint")) == null ? void 0 : _d2.value) ?? config.apiEndpoint : config.apiEndpoint,
        model: ((_e2 = root.querySelector("#cb-model")) == null ? void 0 : _e2.value) ?? config.model,
        prompt: ((_f = root.querySelector("#cb-prompt")) == null ? void 0 : _f.value) ?? config.prompt,
        localOnly: ((_g = root.querySelector("#cb-local-only")) == null ? void 0 : _g.checked) ?? false,
        enableAI: config.localOnly ? false : ((_h = root.querySelector("#cb-enable-ai")) == null ? void 0 : _h.checked) ?? true,
        foldMode: ((_i = root.querySelector("#cb-fold-mode")) == null ? void 0 : _i.checked) ?? true,
        pricePerMToken: parseFloat(((_j = root.querySelector("#cb-price")) == null ? void 0 : _j.value) || "1.1") || 1.1
      };
      newConfig.enableAIPrompt = enableAIPromptValue;
      newConfig.aiLearnedPrompt = aiPromptValue;
      saveConfig(newConfig);
      onConfigChange(newConfig);
      showStatus(root, "已保存", COLORS.success);
    });
    (_d = root.querySelector("#cb-test")) == null ? void 0 : _d.addEventListener("click", async () => {
      var _a3;
      const apiKey = (_a3 = root.querySelector("#cb-apikey")) == null ? void 0 : _a3.value;
      if (!apiKey) {
        showStatus(root, "请先填写 API Key", COLORS.danger);
        return;
      }
      showStatus(root, "测试中...", COLORS.textMuted);
      const ok = await testAPIConnection({ ...config, apiKey });
      showStatus(root, ok ? "连接成功" : "连接失败", ok ? COLORS.success : COLORS.danger);
    });
    (_e = root.querySelector("#cb-clear-cache")) == null ? void 0 : _e.addEventListener("click", async () => {
      await clearCache();
      showStatus(root, "缓存已清除", COLORS.success);
    });
  }
  function showStatus(root, msg, color) {
    const el = root.querySelector("#cb-status");
    if (el) {
      el.textContent = msg;
      el.style.color = color;
    }
  }
  async function refreshAIPanel(root) {
    var _a2, _b, _c, _d, _e, _f;
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
    container.querySelectorAll(".cb-mark-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = parseInt(btn.dataset.id ?? "0");
        if (id) {
          await removeMarkedComment(id);
          refreshAIPanel(root);
        }
      });
    });
    container.querySelectorAll(".cb-learned-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = parseInt(btn.dataset.id ?? "0");
        if (id) {
          await removeMarkedComment(id);
          refreshAIPanel(root);
        }
      });
    });
    container.querySelectorAll(".cb-rule-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = parseInt(btn.dataset.id ?? "0");
        if (id) {
          await removeAIRule(id);
          refreshAIPanel(root);
        }
      });
    });
    (_a2 = container.querySelector("#cb-ai-learn")) == null ? void 0 : _a2.addEventListener("click", async () => {
      const learnBtn = container.querySelector("#cb-ai-learn");
      const aiStatusEl = container.querySelector("#cb-ai-status");
      const rulesListEl = container.querySelector("#cb-ai-rules-list");
      if (learnBtn) {
        learnBtn.textContent = "学习中...";
        learnBtn.disabled = true;
        learnBtn.style.opacity = "0.6";
        learnBtn.style.cursor = "not-allowed";
      }
      if (aiStatusEl) {
        aiStatusEl.textContent = "正在向AI发送请求...";
        aiStatusEl.style.color = COLORS.textMuted;
      }
      if (rulesListEl) {
        rulesListEl.innerHTML = `<div style="padding:12px;text-align:center;color:${COLORS.textMuted};font-size:11px">等待AI返回结果...</div>`;
      }
      const allMarked = await getAllMarkedComments();
      const unlearned2 = allMarked.filter((m) => !m.learned);
      const allAIRules = await getAllAIRules();
      const samplesForAI = allMarked.map((m) => ({ message: m.message, reason: m.reason }));
      const likeComments = ((currentStats == null ? void 0 : currentStats.recentFiltered) ?? []).filter((r) => r.feedback === "like").map((r) => ({ message: r.message, reason: r.reason, rule: r.reason }));
      const dislikeComments = ((currentStats == null ? void 0 : currentStats.recentFiltered) ?? []).filter((r) => r.feedback === "dislike").map((r) => ({ message: r.message, reason: r.reason, rule: r.reason }));
      if (samplesForAI.length < 3 && likeComments.length === 0 && dislikeComments.length === 0) {
        if (aiStatusEl) {
          aiStatusEl.textContent = "至少需要3条标记评论或点赞点踩才能学习";
          aiStatusEl.style.color = COLORS.danger;
        }
        if (learnBtn) {
          learnBtn.textContent = "开始学习";
          learnBtn.disabled = false;
          learnBtn.style.opacity = "1";
          learnBtn.style.cursor = "pointer";
        }
        return;
      }
      const raw = GM_getValue("comment-block-config", "");
      const config = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
      if (!config.apiKey) {
        if (aiStatusEl) {
          aiStatusEl.textContent = "请先配置 API Key";
          aiStatusEl.style.color = COLORS.danger;
        }
        if (learnBtn) {
          learnBtn.textContent = "开始学习";
          learnBtn.disabled = false;
          learnBtn.style.opacity = "1";
          learnBtn.style.cursor = "pointer";
        }
        return;
      }
      try {
        await clearAIRules();
        const existingAIRulesData = allAIRules.map((r) => ({ pattern: r.pattern, isRegex: r.isRegex, description: r.description }));
        const result = await learnFromMarked(config, samplesForAI, existingAIRulesData, likeComments, dislikeComments);
        if (result.rules.length === 0 && !result.aiPrompt) {
          if (aiStatusEl) {
            aiStatusEl.textContent = "未生成新规则";
            aiStatusEl.style.color = COLORS.textMuted;
          }
          return;
        }
        for (const r of result.rules) {
          await addAIRule({
            pattern: r.pattern,
            isRegex: r.isRegex,
            description: r.description,
            matchedComments: r.matchedComments || [],
            createdAt: Date.now(),
            lastLearnedAt: Date.now(),
            sampleCount: samplesForAI.length
          });
        }
        if (result.aiPrompt) {
          config.aiLearnedPrompt = result.aiPrompt;
          GM_setValue("comment-block-config", JSON.stringify(config));
        }
        const unlearnedIds = unlearned2.map((m) => m.id);
        if (unlearnedIds.length > 0) {
          await markCommentsAsLearned(unlearnedIds);
        }
        if (currentStats) {
          for (const item of currentStats.recentFiltered) {
            if (item.feedback) {
              item.feedback = null;
            }
          }
        }
        if (aiStatusEl) {
          aiStatusEl.textContent = `学习完成，生成 ${result.rules.length} 条规则${result.aiPrompt ? " + 提示词" : ""}`;
          aiStatusEl.style.color = COLORS.success;
        }
        refreshAIPanel(root);
      } catch (err) {
        if (aiStatusEl) {
          aiStatusEl.textContent = "学习失败: " + err.message;
          aiStatusEl.style.color = COLORS.danger;
        }
        if (learnBtn) {
          learnBtn.textContent = "开始学习";
          learnBtn.disabled = false;
          learnBtn.style.opacity = "1";
          learnBtn.style.cursor = "pointer";
        }
      }
    });
    (_b = container.querySelector("#cb-mark-clear")) == null ? void 0 : _b.addEventListener("click", async () => {
      if (!confirm("确定要清空所有标记评论吗？")) return;
      await clearMarkedComments();
      refreshAIPanel(root);
    });
    (_c = container.querySelector("#cb-rule-clear")) == null ? void 0 : _c.addEventListener("click", async () => {
      if (!confirm("确定要清空所有AI规则吗？")) return;
      await clearAIRules();
      refreshAIPanel(root);
    });
    (_d = container.querySelector("#cb-mark-export")) == null ? void 0 : _d.addEventListener("click", async () => {
      const marks = await getAllMarkedComments();
      const json = JSON.stringify(marks, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cb-marked-comments-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus(container, "已导出", COLORS.success);
    });
    (_e = container.querySelector("#cb-mark-import")) == null ? void 0 : _e.addEventListener("click", () => {
      const fileInput = container.querySelector("#cb-mark-file");
      if (fileInput) fileInput.click();
    });
    (_f = container.querySelector("#cb-mark-file")) == null ? void 0 : _f.addEventListener("change", async (e) => {
      var _a3;
      const file = (_a3 = e.target.files) == null ? void 0 : _a3[0];
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
              timestamp: item.timestamp || Date.now()
            });
            count++;
          }
        }
        showStatus(container, `已导入 ${count} 条`, COLORS.success);
        refreshAIPanel(root);
      } catch {
        showStatus(container, "导入失败: JSON 格式错误", COLORS.danger);
      }
    });
  }
  async function refreshKeywordsPanel(root) {
    var _a2, _b, _c, _d;
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
    const kwInput = container.querySelector("#cb-kw-input");
    const kwRegex = container.querySelector("#cb-kw-regex");
    const addBtn = container.querySelector("#cb-kw-add");
    addBtn == null ? void 0 : addBtn.addEventListener("click", async () => {
      const pattern = kwInput.value.trim();
      if (!pattern) return;
      const rule = {
        id: nextKeywordId(),
        pattern,
        isRegex: kwRegex.checked,
        enabled: true,
        note: "",
        timestamp: Date.now()
      };
      await addKeyword(rule);
      kwInput.value = "";
      kwRegex.checked = false;
      refreshKeywordsPanel(root);
    });
    kwInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn == null ? void 0 : addBtn.click();
    });
    (_a2 = container.querySelector("#cb-kw-export")) == null ? void 0 : _a2.addEventListener("click", async () => {
      const rules2 = await getAllKeywords();
      const json = JSON.stringify(rules2, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cb-keywords-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus(root, "已导出", COLORS.success);
    });
    (_b = container.querySelector("#cb-kw-import")) == null ? void 0 : _b.addEventListener("click", () => {
      const fileInput = container.querySelector("#cb-kw-file");
      if (fileInput) fileInput.click();
    });
    (_c = container.querySelector("#cb-kw-file")) == null ? void 0 : _c.addEventListener("change", async (e) => {
      var _a3;
      const file = (_a3 = e.target.files) == null ? void 0 : _a3[0];
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
              timestamp: item.timestamp || Date.now()
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
    (_d = container.querySelector("#cb-kw-clear")) == null ? void 0 : _d.addEventListener("click", async () => {
      if (!confirm("确定要清空所有关键词规则吗？")) return;
      await clearKeywords();
      refreshKeywordsPanel(root);
    });
    bindKeywordEvents(container, root);
  }
  function buildKeywordItem(r) {
    const patternDisplay = r.isRegex ? `/${escapeHtml(r.pattern)}/` : escapeHtml(r.pattern);
    const typeLabel = r.isRegex ? "正则" : "关键词";
    r.enabled ? COLORS.success : COLORS.textMuted;
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
  function bindKeywordEvents(container, root) {
    container.querySelectorAll(".cb-kw-toggle").forEach((toggle) => {
      toggle.addEventListener("change", async () => {
        const id = parseInt(toggle.dataset.id ?? "0");
        const rules = await getAllKeywords();
        const rule = rules.find((r) => r.id === id);
        if (rule) {
          rule.enabled = toggle.checked;
          await updateKeyword(rule);
          refreshKeywordsPanel(root);
        }
      });
    });
    container.querySelectorAll(".cb-kw-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id ?? "0");
        if (id) {
          await removeKeyword(id);
          const item = btn.closest(".cb-kw-item");
          if (item) item.remove();
          const summaryEl = container.querySelector("details[open] summary") ?? container.querySelector("details summary");
          if (summaryEl) {
            const count = container.querySelectorAll(".cb-kw-item").length;
            summaryEl.textContent = `自定义关键词 (${count})`;
          }
        }
      });
    });
    container.querySelectorAll(".cb-ai-rule-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        var _a2;
        e.stopPropagation();
        const id = parseInt(btn.dataset.id ?? "0");
        if (id) {
          await removeAIRule(id);
          const item = btn.closest(".cb-ai-rule-item") ?? ((_a2 = btn.parentElement) == null ? void 0 : _a2.parentElement);
          if (item) item.remove();
          const summaryEl = container.querySelector("details[open] summary") ?? container.querySelector("details summary");
          if (summaryEl) {
            const count = container.querySelectorAll(".cb-ai-rule-item, [data-id]").length - 1;
            summaryEl.textContent = `AI 自动生成 (${Math.max(0, count)})`;
          }
        }
      });
    });
  }
  function updateStatsPanel() {
    const contentEl = document.querySelector("#cb-stats-content");
    if (!contentEl || !currentStats) return;
    const s = currentStats;
    const tokensPerK = (s.totalTokens / 1e3).toFixed(1);
    let price = 1.1;
    try {
      const cfg = JSON.parse(GM_getValue("comment-block-config", "{}"));
      price = cfg.pricePerMToken ?? 1.1;
    } catch {
    }
    const costEst = (s.totalTokens / 1e6 * price).toFixed(4);
    const recentList = s.recentFiltered ?? [];
    let recentHTML = "";
    if (recentList.length > 0) {
      const userList = recentList.filter((r) => r.reason.includes("包含关键词") || r.reason.includes("匹配正则"));
      const aiRuleList = recentList.filter((r) => r.reason.includes("AI规则"));
      const descList = recentList.filter((r) => r.reason.includes("简介复读"));
      const aiList = recentList.filter((r) => !r.reason.includes("包含关键词") && !r.reason.includes("匹配正则") && !r.reason.includes("AI规则") && !r.reason.includes("简介复读") && !r.reason.includes("缓存") && !r.reason.includes("已标记"));
      const markedList = recentList.filter((r) => r.reason.includes("已标记"));
      const cacheList = recentList.filter((r) => r.reason.includes("缓存"));
      const renderGroup = (title, items, color, showActions = false) => {
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
      ¥${price}/1M tokens · prompt ${(s.promptTokens / 1e3).toFixed(1)}K · completion ${(s.completionTokens / 1e3).toFixed(1)}K
    </div>
    ${recentHTML}
  `;
    const costSetting = contentEl.querySelector("#cb-cost-setting");
    if (costSetting) {
      costSetting.addEventListener("dblclick", () => {
        const newPrice = prompt("设置 Token 单价 (元/百万)", String(price));
        if (newPrice !== null) {
          const parsed = parseFloat(newPrice);
          if (!isNaN(parsed) && parsed >= 0) {
            const raw = GM_getValue("comment-block-config", "{}");
            const config = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
            config.pricePerMToken = parsed;
            GM_setValue("comment-block-config", JSON.stringify(config));
            updateStatsPanel();
          }
        }
      });
    }
    bindFeedbackEvents(contentEl);
  }
  async function bindFeedbackEvents(container) {
    container.querySelectorAll(".cb-feedback-like").forEach((btn) => {
      btn.addEventListener("click", async () => {
        var _a2;
        const el = btn;
        const id = parseFloat(el.dataset.id ?? "0");
        if (currentStats) {
          const item = currentStats.recentFiltered.find((r) => r.id === id);
          if (item) {
            item.feedback = "like";
          }
        }
        el.textContent = "已标记";
        el.style.color = COLORS.success;
        el.style.borderColor = COLORS.success;
        el.style.cursor = "default";
        el.disabled = true;
        const dislikeBtn = (_a2 = el.parentElement) == null ? void 0 : _a2.querySelector(".cb-feedback-dislike");
        if (dislikeBtn) dislikeBtn.style.display = "none";
      });
    });
    container.querySelectorAll(".cb-feedback-dislike").forEach((btn) => {
      btn.addEventListener("click", async () => {
        var _a2;
        const el = btn;
        const id = parseFloat(el.dataset.id ?? "0");
        if (currentStats) {
          const item = currentStats.recentFiltered.find((r) => r.id === id);
          if (item) {
            item.feedback = "dislike";
          }
        }
        el.textContent = "已标记";
        el.style.color = COLORS.danger;
        el.style.borderColor = COLORS.danger;
        el.style.cursor = "default";
        el.disabled = true;
        const likeBtn = (_a2 = el.parentElement) == null ? void 0 : _a2.querySelector(".cb-feedback-like");
        if (likeBtn) likeBtn.style.display = "none";
      });
    });
  }
  const TAG$1 = "[comment-block]";
  function matchKeyword(text, rules) {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      try {
        if (rule.isRegex) {
          const regex = new RegExp(rule.pattern, "i");
          if (regex.test(text)) {
            return rule.note || `匹配正则: ${rule.pattern}`;
          }
        } else {
          if (text.toLowerCase().includes(rule.pattern.toLowerCase())) {
            return rule.note || `包含关键词: ${rule.pattern}`;
          }
        }
      } catch {
      }
    }
    return null;
  }
  async function filterLocal(config, replies, ctx, stats) {
    var _a2;
    const violations = /* @__PURE__ */ new Map();
    let newBlacklistEntries = 0;
    const needAICheck = [];
    if (replies.length === 0) return { violations, newBlacklistEntries, needAICheck };
    const afterDesc = [];
    const desc = ((_a2 = ctx.videoDesc) == null ? void 0 : _a2.trim().toLowerCase()) || "";
    for (const reply of replies) {
      const msg = reply.content.message.trim().toLowerCase();
      if (desc && desc.length > 10 && (msg === desc || desc.includes(msg) || msg.includes(desc))) {
        violations.set(reply.rpid, { reason: "[简介复读] 评论与视频简介相同" });
        if (stats) stats.totalFiltered++;
      } else {
        afterDesc.push(reply);
      }
    }
    const keywords = await getAllKeywords();
    const afterKeyword = [];
    for (const reply of afterDesc) {
      const match = matchKeyword(reply.content.message, keywords);
      if (match) {
        violations.set(reply.rpid, { reason: match });
        if (stats) stats.totalFiltered++;
      } else {
        afterKeyword.push(reply);
      }
    }
    const aiRules = await getAllAIRules();
    const afterAIRules = [];
    for (const reply of afterKeyword) {
      const match = matchAIRule(reply.content.message, aiRules);
      if (match) {
        violations.set(reply.rpid, { reason: `[AI规则] ${match}` });
        if (stats) stats.totalFiltered++;
      } else {
        afterAIRules.push(reply);
      }
    }
    for (const reply of afterAIRules) {
      const hash = commentHash(reply.content.message, reply.mid);
      const cached = await getCache(hash);
      if (cached && cached.violation) {
        violations.set(reply.rpid, { reason: `[缓存] ${cached.reason}` });
        if (stats) stats.totalFiltered++;
        continue;
      }
      if (config.enableAI && !config.localOnly) {
        needAICheck.push(reply);
      }
    }
    if (stats) stats.lastUpdate = Date.now();
    return { violations, newBlacklistEntries, needAICheck };
  }
  function matchAIRule(text, rules) {
    for (const rule of rules) {
      try {
        if (rule.isRegex) {
          const regex = new RegExp(rule.pattern, "i");
          if (regex.test(text)) return rule.description;
        } else {
          if (text.toLowerCase().includes(rule.pattern.toLowerCase())) {
            return rule.description;
          }
        }
      } catch {
      }
    }
    return null;
  }
  async function filterAI(config, replies, ctx, stats) {
    const violations = /* @__PURE__ */ new Map();
    if (replies.length === 0 || config.localOnly || !config.apiKey || !config.enableAI) return violations;
    const aiLearnedPrompt = config.enableAIPrompt && config.aiLearnedPrompt ? "\n\n额外过滤规则：" + config.aiLearnedPrompt : "";
    try {
      const result = await batchJudge(config, replies, ctx, aiLearnedPrompt);
      if (stats && result.usage) {
        stats.totalTokens += result.usage.total_tokens ?? 0;
        stats.promptTokens += result.usage.prompt_tokens ?? 0;
        stats.completionTokens += result.usage.completion_tokens ?? 0;
        stats.apiCalls++;
      }
      for (const v of result.verdicts) {
        const reply = replies.find((r) => r.rpid === v.rpid);
        if (reply) {
          const hash = commentHash(reply.content.message, reply.mid);
          await setCache({
            hash,
            violation: v.violation,
            reason: v.reason,
            timestamp: Date.now()
          });
        }
        if (v.violation) {
          violations.set(v.rpid, { reason: v.reason });
          if (stats) stats.totalFiltered++;
        }
      }
    } catch (err) {
      console.error(TAG$1, "AI判定失败:", err);
    }
    if (stats) stats.lastUpdate = Date.now();
    return violations;
  }
  const TAG = "[comment-block]";
  const blockStats = {
    totalFiltered: 0,
    totalScanned: 0,
    apiCalls: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    lastUpdate: 0,
    recentFiltered: []
  };
  if (typeof window !== "undefined") {
    window.__comment_block_stats = blockStats;
  }
  let updateStats = () => {
  };
  function setUpdateStats(fn) {
    updateStats = fn;
  }
  let currentContext = { oid: 0, videoTitle: "", videoDesc: "" };
  let getConfig = () => {
    try {
      const raw = GM_getValue("comment-block-config", "");
      if (raw) return JSON.parse(raw);
    } catch {
    }
    return {
      apiKey: "",
      apiKeys: {
        deepseek: "",
        mimo: "",
        custom: ""
      },
      provider: "deepseek",
      apiEndpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-chat",
      prompt: "",
      foldMode: true,
      localOnly: false,
      enableAI: true,
      pricePerMToken: 1.1,
      darkMode: "auto"
    };
  };
  function refreshConfig(cfg) {
    getConfig = () => cfg;
  }
  function updateContext(ctx) {
    if (ctx.oid) currentContext.oid = ctx.oid;
    if (ctx.videoTitle) currentContext.videoTitle = ctx.videoTitle;
    if (ctx.videoDesc) currentContext.videoDesc = ctx.videoDesc;
  }
  function extractVideoInfo() {
    var _a2, _b, _c, _d;
    const titleEl = document.querySelector("h1.video-title") ?? document.querySelector(".video-info-title .tit") ?? document.querySelector("[data-title]");
    if (titleEl) {
      currentContext.videoTitle = ((_a2 = titleEl.dataset) == null ? void 0 : _a2.title) ?? titleEl.getAttribute("data-title") ?? titleEl.getAttribute("title") ?? ((_b = titleEl.textContent) == null ? void 0 : _b.trim()) ?? "";
    }
    const descEl = document.querySelector("#v_desc .desc-info-text") ?? document.querySelector(".desc-info-text") ?? document.querySelector(".basic-desc-info");
    if (descEl) {
      const t = ((_c = descEl.textContent) == null ? void 0 : _c.trim()) ?? "";
      currentContext.videoDesc = t === "-" ? "" : t;
    }
    const bc = document.querySelector("bili-comments");
    if (bc) {
      const p = bc.getAttribute("data-params");
      if (p) {
        const pts = p.split(",");
        if (pts.length >= 2) currentContext.oid = parseInt(pts[1]) || 0;
      }
    }
    if (!currentContext.oid) {
      try {
        for (const s of document.querySelectorAll("script")) {
          const m = (s.textContent ?? "").match(
            /window\.__INITIAL_STATE__\s*=\s*(\{.+?\});/
          );
          if (m) {
            const data = JSON.parse(m[1]);
            const aid = ((_d = data == null ? void 0 : data.videoData) == null ? void 0 : _d.aid) ?? (data == null ? void 0 : data.aid);
            if (aid) {
              currentContext.oid = aid;
              break;
            }
          }
        }
      } catch {
      }
    }
    if (!currentContext.oid) {
      location.pathname.match(/\/video\/(BV\w+)/);
    }
  }
  function fullPageDiagnostic() {
    var _a2, _b;
    console.log(TAG, "══════ 诊断 ══════");
    const bc = document.querySelector("bili-comments");
    console.log(
      TAG,
      `📦 bili-comments: ${bc ? "✅ shadowRoot=" + !!bc.shadowRoot + " children=" + bc.children.length : "❌ 未找到"}`
    );
    const containerSelectors = [
      "#comment",
      "#commentapp",
      ".comment-container",
      ".reply-list",
      ".bb-comment",
      "[class*='comment']",
      "[class*='reply']",
      "[id*='comment']",
      "[id*='reply']"
    ];
    for (const sel of containerSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0 && els.length < 200) {
        const first = els[0];
        const id = first.id ? `#${first.id}` : "(无id)";
        const cls = first.className ? "." + first.className.split(" ").slice(0, 3).join(".") : "(无class)";
        console.log(
          TAG,
          `  📌 "${sel}" → ${els.length}个 ${first.tagName.toLowerCase()}${id}${cls}`
        );
      }
    }
    if (bc && bc.shadowRoot) {
      const sr = bc.shadowRoot;
      const allNodes = sr.querySelectorAll("*");
      console.log(TAG, `🔬 ShadowRoot 总节点: ${allNodes.length}`);
      const tagCounts = /* @__PURE__ */ new Map();
      allNodes.forEach((n) => {
        const t = n.tagName.toLowerCase();
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      });
      console.log(
        TAG,
        `  标签分布: ${[...tagCounts.entries()].map(([k, v]) => `${k}x${v}`).join(", ")}`
      );
      const itemChecks = [
        "[data-rpid]",
        ".reply-item",
        ".comment-item",
        ".reply-wrap",
        ".con",
        "bb-comment"
      ];
      for (const sel of itemChecks) {
        const count = sr.querySelectorAll(sel).length;
        console.log(TAG, `  🎯 "${sel}" → ${count}个`);
      }
      console.log(TAG, "📋 ShadowRoot 直接子元素:");
      for (const child of sr.children) {
        const tag = child.tagName.toLowerCase();
        const id = child.id ? `#${child.id}` : "";
        const cls = child.className ? "." + child.className.split(" ").slice(0, 3).join(".") : "";
        const text = ((_a2 = child.innerText) == null ? void 0 : _a2.slice(0, 60)) ?? "";
        const childCount = child.querySelectorAll("*").length;
        console.log(
          TAG,
          `  <${tag}${id}${cls}> 子元素:${childCount} text:"${text}"`
        );
        if (childCount > 0 && childCount <= 30) {
          for (const c2 of child.children) {
            const t2 = c2.tagName.toLowerCase();
            const id2 = c2.id ? `#${c2.id}` : "";
            const cls2 = c2.className ? "." + c2.className.split(" ").slice(0, 2).join(".") : "";
            const txt2 = ((_b = c2.innerText) == null ? void 0 : _b.slice(0, 50)) ?? "";
            const dataAttrs = c2 instanceof HTMLElement ? c2.getAttributeNames().filter((a) => a.startsWith("data-")).join(", ") : "";
            console.log(
              TAG,
              `    <${t2}${id2}${cls2}>${dataAttrs ? " [" + dataAttrs + "]" : ""} "${txt2}"`
            );
          }
        }
      }
    }
    const mainSections = [
      "#reply",
      "#danmakuBox",
      ".player-auxiliary",
      ".video-info-container",
      ".video-data",
      "section"
    ];
    console.log(TAG, "📐 页面结构:");
    for (const sel of mainSections) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) console.log(TAG, `  ${sel}: ${els.length}个`);
    }
    console.log(TAG, "══════ 完成 ══════");
  }
  function inspectShadowRoot() {
    const bc = document.querySelector("bili-comments");
    if (!bc || !bc.shadowRoot) {
      console.log(TAG, "❌ bili-comments 或其 shadowRoot 未找到");
      return;
    }
    const sr = bc.shadowRoot;
    console.log(TAG, "══════ ShadowRoot 完整探查 ══════");
    console.log(TAG, `总节点数: ${sr.querySelectorAll("*").length}`);
    console.log(TAG, `直接子元素数: ${sr.children.length}`);
    function dump(el, depth = 0) {
      var _a2, _b;
      if (depth > 4) return;
      const indent = "  ".repeat(depth);
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = el.className ? "." + el.className.split(" ").slice(0, 3).join(".") : "";
      const attrs = el instanceof HTMLElement ? el.getAttributeNames().filter((a) => a !== "class" && a !== "id").map((a) => `${a}="${el.getAttribute(a)}"`.slice(0, 60)).join(" ") : "";
      const text = ((_b = (_a2 = el.innerText) == null ? void 0 : _a2.slice(0, 80)) == null ? void 0 : _b.replace(/\n/g, " ")) ?? "";
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
  let pendingBatch = [];
  let batchTimer = null;
  const scannedRpids = /* @__PURE__ */ new Set();
  function getCommentRoot() {
    const bc = document.querySelector("bili-comments");
    if (bc && bc.shadowRoot) return bc.shadowRoot;
    if (bc) return bc;
    const containerSelectors = [
      "#comment",
      "#commentapp",
      ".comment-container",
      ".reply-list",
      ".bb-comment"
    ];
    for (const sel of containerSelectors) {
      const el = document.querySelector(sel);
      if (el && el.querySelectorAll("*").length > 5) return el;
    }
    return null;
  }
  function findCommentElements(root) {
    var _a2;
    let items = root.querySelectorAll("bili-comment-thread-renderer");
    if (items.length > 0) return items;
    items = root.querySelectorAll("[data-rpid]");
    if (items.length > 0) return items;
    items = root.querySelectorAll(
      ".reply-item, .comment-item, .comment-list > div, .reply-wrap, bb-comment"
    );
    if (items.length > 0) return items;
    const divs = root.querySelectorAll("div");
    if (divs.length > 500) return [];
    const candidates = [];
    for (const d of divs) {
      if (candidates.length >= 100) break;
      const childCount = d.querySelectorAll("*").length;
      if (childCount < 3 || childCount > 80) continue;
      const t = ((_a2 = d.innerText) == null ? void 0 : _a2.trim()) ?? "";
      if (t.length < 30 || t.length > 5e3) continue;
      if (!t.includes("回复") || !t.includes("举报")) continue;
      candidates.push(d);
    }
    return candidates;
  }
  function scanPage() {
    const root = getCommentRoot();
    if (!root) return;
    const items = findCommentElements(root);
    if (items.length === 0) return;
    let found = 0;
    items.forEach((el) => {
      const info = extractComment(el);
      if (!info) return;
      injectMarkButton(el, info);
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
  const dislikeMonitored = /* @__PURE__ */ new WeakSet();
  const dislikeState = /* @__PURE__ */ new WeakMap();
  function monitorDislikeButton(el, info) {
    if (dislikeMonitored.has(el)) return;
    dislikeMonitored.add(el);
    const elShadow = el.shadowRoot ?? el;
    function tryMonitor() {
      try {
        const renderer = elShadow.querySelector("bili-comment-renderer");
        if (!(renderer == null ? void 0 : renderer.shadowRoot)) return false;
        const actionBtns = renderer.shadowRoot.querySelector("bili-comment-action-buttons-renderer");
        if (!(actionBtns == null ? void 0 : actionBtns.shadowRoot)) return false;
        const dislike = actionBtns.shadowRoot.querySelector("#dislike button");
        if (!dislike) return false;
        if (dislike.dataset.cbMonitored) return true;
        dislike.dataset.cbMonitored = "1";
        dislike.addEventListener("click", async () => {
          try {
            const wasDisliked = dislikeState.get(dislike) ?? false;
            if (wasDisliked) {
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
              await addMarkedComment({
                uname: info.uname,
                message: info.message,
                reason: "[踩]",
                timestamp: Date.now()
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
    setTimeout(() => observer.disconnect(), 5e3);
  }
  const markButtonInjected = /* @__PURE__ */ new WeakSet();
  function injectMarkButton(el, info) {
    if (markButtonInjected.has(el)) return;
    markButtonInjected.add(el);
    const elShadow = el.shadowRoot ?? el;
    function tryInject() {
      try {
        const renderer = elShadow.querySelector("bili-comment-renderer");
        if (!(renderer == null ? void 0 : renderer.shadowRoot)) return false;
        const actionBtns = renderer.shadowRoot.querySelector("bili-comment-action-buttons-renderer");
        if (!(actionBtns == null ? void 0 : actionBtns.shadowRoot)) return false;
        const more = actionBtns.shadowRoot.querySelector("#more");
        if (!more) return false;
        const menu = more.querySelector("bili-comment-menu");
        if (!(menu == null ? void 0 : menu.shadowRoot)) return false;
        const ul = menu.shadowRoot.querySelector("ul#options");
        if (!ul) return false;
        if (ul.querySelector(".cb-mark-item")) return true;
        const li = document.createElement("li");
        li.className = "cb-mark-item";
        li.textContent = "标记不想看 (脚本)";
        li.style.cursor = "pointer";
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
              timestamp: Date.now()
            });
            console.log(TAG, "已标记评论: " + info.uname);
            window.dispatchEvent(new CustomEvent("cb-comment-marked"));
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
    if (tryInject()) return;
    const observer = new MutationObserver(() => {
      if (tryInject()) observer.disconnect();
    });
    observer.observe(elShadow, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 5e3);
  }
  function extractComment(el) {
    var _a2;
    try {
      let deepInnerText = function(root) {
        var _a3, _b;
        let text = "";
        for (const child of root.children) {
          const el2 = child;
          const tag2 = el2.tagName.toLowerCase();
          if (tag2 === "style") continue;
          if (el2.id === "location") continue;
          if (el2.id === "replies" || el2.id === "reply-container" || tag2 === "bili-comment-reply-list" || tag2 === "bili-comments") continue;
          if (el2.id === "user-avatar" || tag2 === "bili-avatar" || tag2 === "bili-user-avatar") continue;
          if (el2.id === "pictures") {
            imgCount += el2.querySelectorAll("img").length;
            if (el2.shadowRoot) imgCount += el2.shadowRoot.querySelectorAll("img").length;
            continue;
          }
          if (tag2 === "img") {
            const alt = (_a3 = el2.getAttribute("alt")) == null ? void 0 : _a3.trim();
            if (alt && !alt.startsWith("//") && alt.length < 20) {
              text += `[${alt}]`;
            }
            continue;
          }
          if (el2.shadowRoot) {
            text += deepInnerText(el2.shadowRoot) + "\n";
          } else if (el2.children.length > 0) {
            text += deepInnerText(el2) + "\n";
          } else {
            const t = (_b = el2.innerText) == null ? void 0 : _b.trim();
            if (t) text += t + "\n";
          }
        }
        return text;
      }, findRpid = function(root) {
        const el2 = root.querySelector("[data-rpid]");
        if (el2) return el2.getAttribute("data-rpid");
        for (const child of root.children) {
          const c = child;
          if (c.shadowRoot) {
            const r = findRpid(c.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      }, findMid = function(root) {
        const el2 = root.querySelector("[data-mid], [data-uid]");
        if (el2) return el2.getAttribute("data-mid") ?? el2.getAttribute("data-uid");
        for (const child of root.children) {
          const c = child;
          if (c.shadowRoot) {
            const r = findMid(c.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      };
      const tag = el.tagName.toLowerCase();
      let imgCount = 0;
      let fullText = "";
      if (el.shadowRoot) {
        fullText = deepInnerText(el.shadowRoot).trim();
      }
      if (!fullText) {
        fullText = ((_a2 = el.innerText) == null ? void 0 : _a2.trim()) ?? "";
      }
      fullText = fullText.replace(/共\d+条回复/g, "").replace(/拉黑用户\s*\(脚本\)/g, "").replace(/标记不想看\s*\(脚本\)/g, "").replace(/硬核会员举报/g, "").replace(/回复\s*举报/g, "").replace(/举报/g, "").replace(/点赞/g, "").replace(/\d+\s*踩/g, "").replace(/展开\s*收起/g, "").replace(/复制评论链接/g, "").replace(/记笔记/g, "").replace(/CD\.\s*/g, "").trim();
      if (imgCount > 0) {
        fullText = `${fullText} [${imgCount}张图片]`;
      }
      if (fullText.length < 3) return null;
      let rpid = 0;
      const rpidStr = el.getAttribute("data-rpid") ?? (el.shadowRoot ? findRpid(el.shadowRoot) : null);
      if (rpidStr) rpid = parseInt(rpidStr);
      if (!rpid) {
        const hashInput = `${tag}:${fullText.slice(0, 300)}`;
        rpid = strHash(hashInput);
      }
      let mid = 0;
      const midStr = el.getAttribute("data-mid") ?? el.getAttribute("data-uid") ?? (el.shadowRoot ? findMid(el.shadowRoot) : null);
      if (midStr) mid = parseInt(midStr) || 0;
      const lines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);
      const contentLines = lines.filter((l) => {
        if (IGNORE_TEXTS.has(l)) return false;
        if (isUIText(l)) return false;
        return true;
      });
      if (contentLines.length === 0) return null;
      const uname = contentLines.find(
        (l) => l.length >= 2 && l.length <= 20 && !/^\d/.test(l) && !l.includes("·") && !l.includes("分钟") && !l.includes("小时") && !l.includes("刚刚") && !l.includes("昨天") && !l.includes("共") && !l.includes("条回复") && !l.includes("拉黑用户") && !l.includes("脚本") && !l.includes("举报") && !l.includes("回复") && !l.includes("点赞") && !l.includes("踩") && !l.includes("收起") && !l.includes("展开") && !l.includes("查看") && !l.includes("复制") && !l.includes("黑名单")
      ) ?? "未知用户";
      const msgParts = contentLines.filter(
        (l) => l !== uname || contentLines.filter((x) => x === l).length > 1
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
  const IGNORE_TEXTS = /* @__PURE__ */ new Set([
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
    "记笔记"
  ]);
  function isUIText(s) {
    if (/^(\d+|[\d.]+[万亿]?|\d+:\d+|\d+楼|#\d+)$/.test(s)) return true;
    if (/^\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}$/.test(s)) return true;
    if (/^(刚刚|\d+分钟前|\d+小时前|昨天|\d+天前)$/.test(s)) return true;
    if (/^共\d+条回复$/.test(s)) return true;
    if (/^(LV\d+|CD|\d{6})$/.test(s)) return true;
    return false;
  }
  function strHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) + h + s.charCodeAt(i) & 2147483647;
    }
    return h;
  }
  let isFlushing = false;
  async function flushBatch() {
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
    const replies = batch.map((p) => ({
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
      member: { mid: String(p.mid), uname: p.uname, avatar: "" }
    }));
    try {
      const localResult = await filterLocal(config, replies, currentContext, blockStats);
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
              feedback: null
            });
            if (blockStats.recentFiltered.length > 50) {
              blockStats.recentFiltered.pop();
            }
          }
        }
        try {
          updateStats(blockStats);
        } catch {
        }
      }
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
                feedback: null
              });
              if (blockStats.recentFiltered.length > 50) {
                blockStats.recentFiltered.pop();
              }
            }
          }
          try {
            updateStats(blockStats);
          } catch {
          }
        }
      }
    } catch (err) {
      console.error(TAG, "AI失败:", err);
    } finally {
      isFlushing = false;
    }
  }
  function isDarkMode() {
    var _a2, _b;
    try {
      const raw = GM_getValue("comment-block-config", "");
      if (raw) {
        const config = JSON.parse(raw);
        if (config.darkMode === "dark") return true;
        if (config.darkMode === "light") return false;
        return ((_a2 = window.matchMedia) == null ? void 0 : _a2.call(window, "(prefers-color-scheme: dark)").matches) ?? false;
      }
    } catch {
    }
    return ((_b = window.matchMedia) == null ? void 0 : _b.call(window, "(prefers-color-scheme: dark)").matches) ?? false;
  }
  function foldEl(el, info, verdict) {
    var _a2, _b;
    try {
      const dark = isDarkMode();
      const warningBg = dark ? "#3a2a1a" : "#fff3e0";
      const warning = dark ? "#ffb74d" : "#f57c00";
      const origBg = dark ? "#2a2a2a" : "#f5f5f5";
      const textColor = dark ? "#e0e0e0" : "#1a1a1a";
      const mutedColor = dark ? "#999" : "#666";
      const html = `<div class="cb-folded" style="background:${warningBg};border:1px solid ${warning};border-radius:4px;padding:8px 12px;margin:4px 0;font-size:12px;color:${textColor};cursor:pointer;user-select:none;font-family:system-ui,-apple-system,sans-serif">
<span style="margin-right:6px;color:${warning}">●</span><span style="font-weight:500">${esc(info.uname)}</span><span style="margin:0 6px;color:${dark ? "#555" : "#e0e0e0"}">|</span><span style="color:${mutedColor}">${esc(verdict.reason)}</span><span style="float:right;font-size:10px;color:${dark ? "#777" : "#999"}">▼</span>
</div><div class="cb-original" style="display:none;padding:8px 12px;background:${origBg};border-left:3px solid ${warning};margin:4px 0;border-radius:0 4px 4px 0;font-size:12px">
<div style="margin-bottom:4px;font-size:10px;color:${dark ? "#888" : "#999"}">AI 判定: <strong>${esc(verdict.reason)}</strong></div>
<div style="color:${textColor};white-space:pre-wrap;word-break:break-word">${esc(info.message)}</div></div>`;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const foldElDiv = wrapper.firstElementChild;
      const origElDiv = foldElDiv.nextElementSibling;
      (_a2 = el.parentNode) == null ? void 0 : _a2.insertBefore(foldElDiv, el);
      (_b = el.parentNode) == null ? void 0 : _b.insertBefore(origElDiv, el);
      el.style.display = "none";
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
  function hideEl(el) {
    try {
      const htmlEl = el;
      htmlEl.style.transition = "height 0.2s, margin 0.2s, padding 0.2s, opacity 0.2s";
      htmlEl.style.overflow = "hidden";
      htmlEl.style.height = htmlEl.offsetHeight + "px";
      htmlEl.offsetHeight;
      htmlEl.style.height = "0";
      htmlEl.style.margin = "0";
      htmlEl.style.padding = "0";
      htmlEl.style.opacity = "0";
      setTimeout(() => {
        htmlEl.style.display = "none";
      }, 200);
      return true;
    } catch {
      return false;
    }
  }
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function watchNewComments() {
    const root = getCommentRoot();
    if (!root) {
      setTimeout(() => watchNewComments(), 3e3);
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
    observer.observe(root, {
      childList: true,
      subtree: true
    });
    console.log(TAG, "👁️ MutationObserver 已绑定到评论根节点");
  }
  function watchScrollLoading() {
    let scrollTimer = null;
    window.addEventListener(
      "scroll",
      () => {
        if (scrollTimer) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          scanPage();
          if (pendingBatch.length >= 10) flushBatch();
        }, 300);
      },
      { passive: true }
    );
  }
  function startDOMScanner() {
    setTimeout(() => scanPage(), 500);
    setTimeout(() => scanPage(), 1500);
    setTimeout(() => scanPage(), 3e3);
    setInterval(() => {
      scanPage();
      if (pendingBatch.length >= 10) flushBatch();
    }, 2e3);
    setTimeout(() => watchNewComments(), 300);
    watchScrollLoading();
    window.addEventListener("cb-config-changed", () => {
      console.log(TAG, "配置变化，重新扫描");
      scannedRpids.clear();
      setTimeout(() => scanPage(), 100);
    });
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
    const uw = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    uw.__comment_block_diag = () => {
      fullPageDiagnostic();
      scanPage();
    };
    uw.__comment_block_scan = () => scanPage();
    uw.__comment_block_flush = () => flushBatch();
    uw.__comment_block_inspect = () => inspectShadowRoot();
    uw.__comment_block_debug_menu = () => {
      const bc = document.querySelector("bili-comments");
      if (!(bc == null ? void 0 : bc.shadowRoot)) {
        console.log(TAG, "未找到 bili-comments shadowRoot");
        return;
      }
      const sr = bc.shadowRoot;
      const threads = sr.querySelectorAll("bili-comment-thread-renderer");
      console.log(TAG, `找到 ${threads.length} 个评论线程`);
      threads.forEach((t, i) => {
        if (i > 0) return;
        console.log(TAG, `--- 评论 ${i} ---`);
        const tsr = t.shadowRoot;
        if (!tsr) return;
        const renderer = tsr.querySelector("bili-comment-renderer");
        if (!(renderer == null ? void 0 : renderer.shadowRoot)) return;
        const actionBtns = renderer.shadowRoot.querySelector("bili-comment-action-buttons-renderer");
        if (!(actionBtns == null ? void 0 : actionBtns.shadowRoot)) return;
        const asr = actionBtns.shadowRoot;
        const more = asr.querySelector("#more");
        if (!more) return;
        console.log(TAG, "  #more 内部:");
        for (const child of more.children) {
          const tag = child.tagName.toLowerCase();
          console.log(TAG, `    <${tag}>`);
        }
        const menu = more.querySelector("bili-comment-menu");
        if (!menu) {
          console.log(TAG, "    无 bili-comment-menu");
          return;
        }
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
  async function main() {
    let config = loadConfig();
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
        if (newUrl !== lastUrl) {
          lastUrl = newUrl;
          window.dispatchEvent(new CustomEvent("cb-video-changed"));
        }
        updateContext({
          videoTitle: document.title.replace(/[ _-]哔哩哔哩.*$/, "")
        });
      }).observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }
    injectUI(config, (newConfig) => {
      config = newConfig;
      refreshConfig(config);
    });
    setUpdateStats((s) => {
      setStatsRef(s);
    });
    setInterval(
      () => {
        pruneCache().catch(() => {
        });
      },
      60 * 60 * 1e3
    );
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", main);
  else main();

})();