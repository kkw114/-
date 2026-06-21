// ============================================================
// db.ts - IndexedDB 封装: 黑名单 & LRU缓存 & 关键词 & AI学习 & 误判
// ============================================================
import { openDB, type IDBPDatabase } from "idb";
import type { BlacklistRecord, CacheEntry, KeywordRule, MarkedComment, AIRule, FalsePositive } from "./types";

const DB_NAME = "bilibili-comment-block-db";
const DB_VERSION = 6;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
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
        if (oldVersion < 3) {
          // v3: source 字段
        }
        if (oldVersion < 4) {
          // v4: 添加关键词库
          if (!db.objectStoreNames.contains("keywords")) {
            const kw = db.createObjectStore("keywords", { keyPath: "id" });
            kw.createIndex("timestamp", "timestamp");
          }
        }
        if (oldVersion < 5) {
          // v5: 添加标记评论和AI规则
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
          // v6: 添加误判记录
          if (!db.objectStoreNames.contains("falsePositives")) {
            const fp = db.createObjectStore("falsePositives", { keyPath: "id" });
            fp.createIndex("timestamp", "timestamp");
          }
        }
        if (!db.objectStoreNames.contains("cache")) {
          const c = db.createObjectStore("cache", { keyPath: "hash" });
          c.createIndex("timestamp", "timestamp");
        }
      },
    });
  }
  return dbPromise;
}

// ---------- 工具 ----------

function strHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
  }
  return h;
}

export function blacklistKey(uname: string): number {
  return strHash(uname.trim());
}

export function commentHash(message: string, mid: number): string {
  const input = `${mid}:${message.trim().slice(0, 200)}`;
  return strHash(input).toString(16);
}

// ---------- 黑名单操作 ----------

export async function isBlacklisted(mid: number, uname: string): Promise<BlacklistRecord | null> {
  const db = await getDB();
  const key = mid > 0 ? mid : blacklistKey(uname);
  const record = await db.get("blacklist", key);
  return record ?? null;
}

export async function addToBlacklist(record: BlacklistRecord): Promise<void> {
  const db = await getDB();
  const uid = blacklistKey(record.uname);
  await db.put("blacklist", { ...record, uid });
}

export async function getAllBlacklist(): Promise<BlacklistRecord[]> {
  const db = await getDB();
  return db.getAll("blacklist");
}

export async function removeFromBlacklist(uid: number): Promise<void> {
  const db = await getDB();
  await db.delete("blacklist", uid);
}

export async function clearBlacklist(): Promise<void> {
  const db = await getDB();
  await db.clear("blacklist");
}

// ---------- 关键词操作 ----------

export async function getAllKeywords(): Promise<KeywordRule[]> {
  const db = await getDB();
  return db.getAll("keywords");
}

export async function addKeyword(rule: KeywordRule): Promise<void> {
  const db = await getDB();
  await db.put("keywords", rule);
}

export async function updateKeyword(rule: KeywordRule): Promise<void> {
  const db = await getDB();
  await db.put("keywords", rule);
}

export async function removeKeyword(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("keywords", id);
}

export async function clearKeywords(): Promise<void> {
  const db = await getDB();
  await db.clear("keywords");
}

export async function importKeywords(rules: KeywordRule[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("keywords", "readwrite");
  for (const rule of rules) {
    await tx.store.put(rule);
  }
  await tx.done;
}

// ---------- LRU 缓存操作 ----------

export async function getCache(hash: string): Promise<CacheEntry | null> {
  const db = await getDB();
  const entry = await db.get("cache", hash);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) {
    await db.delete("cache", hash);
    return null;
  }
  return entry;
}

export async function setCache(entry: CacheEntry): Promise<void> {
  const db = await getDB();
  await db.put("cache", entry);
}

export async function clearCache(): Promise<void> {
  const db = await getDB();
  await db.clear("cache");
}

export async function pruneCache(): Promise<void> {
  const db = await getDB();
  const all = await db.getAll("cache");
  all.sort((a, b) => b.timestamp - a.timestamp);
  const keep = all.slice(0, 5000);
  const keepHashes = new Set(keep.map((e) => e.hash));
  const toDelete = all.filter((e) => !keepHashes.has(e.hash));
  const tx = db.transaction("cache", "readwrite");
  for (const entry of toDelete) {
    await tx.store.delete(entry.hash);
  }
  await tx.done;
}

// ---------- 标记评论操作 ----------

const MAX_MARKED = 1000;
let markedIdCounter = Date.now();

export async function addMarkedComment(comment: Omit<MarkedComment, "id">): Promise<void> {
  const db = await getDB();
  await db.put("marked", { ...comment, id: markedIdCounter++ });
  // 超过上限时删除最旧的
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

export async function getAllMarkedComments(): Promise<MarkedComment[]> {
  const db = await getDB();
  const all = await db.getAll("marked");
  // 按时间倒序，新的在前面
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

/** 获取未学习的标记评论 */
export async function getUnlearnedMarkedComments(): Promise<MarkedComment[]> {
  const all = await getAllMarkedComments();
  return all.filter((c) => !c.learned);
}

/** 标记评论为已学习 */
export async function markCommentsAsLearned(ids: number[]): Promise<void> {
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

export async function removeMarkedComment(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("marked", id);
}

export async function clearMarkedComments(): Promise<void> {
  const db = await getDB();
  await db.clear("marked");
}

export async function getMarkedCount(): Promise<number> {
  const db = await getDB();
  return db.count("marked");
}

// ---------- AI 规则操作 ----------

let aiRuleIdCounter = Date.now();

export async function addAIRule(rule: Omit<AIRule, "id">): Promise<void> {
  const db = await getDB();
  await db.put("aiRules", { ...rule, id: aiRuleIdCounter++ });
}

export async function getAllAIRules(): Promise<AIRule[]> {
  const db = await getDB();
  return db.getAll("aiRules");
}

export async function updateAIRule(rule: AIRule): Promise<void> {
  const db = await getDB();
  await db.put("aiRules", rule);
}

export async function removeAIRule(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("aiRules", id);
}

export async function clearAIRules(): Promise<void> {
  const db = await getDB();
  await db.clear("aiRules");
}

// ---------- 误判记录操作 ----------

let falsePositiveIdCounter = Date.now();

export async function addFalsePositive(record: Omit<FalsePositive, "id">): Promise<void> {
  const db = await getDB();
  await db.put("falsePositives", { ...record, id: falsePositiveIdCounter++ });
}

export async function getAllFalsePositives(): Promise<FalsePositive[]> {
  const db = await getDB();
  return db.getAll("falsePositives");
}

export async function removeFalsePositive(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("falsePositives", id);
}

export async function clearFalsePositives(): Promise<void> {
  const db = await getDB();
  await db.clear("falsePositives");
}
