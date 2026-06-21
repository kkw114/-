// ============================================================
// filter.ts - 过滤引擎: 本地快速过滤 + AI异步过滤
// ============================================================
import type {
  FilterConfig,
  BiliReply,
  KeywordRule,
  AIRule,
  ReplyContext,
  AccumulatedStats,
} from "./types";
import {
  isBlacklisted,
  getAllKeywords,
  getAllAIRules,
  getCache,
  setCache,
  commentHash,
} from "./db";
import { batchJudge } from "./api";

const TAG = "[comment-block]";

export interface FilterResult {
  violations: Map<number, { reason: string }>;
  newBlacklistEntries: number;
  /** 未被本地过滤、需要AI判定的评论 */
  needAICheck: BiliReply[];
}

/** 检查文本是否匹配关键词规则 */
function matchKeyword(text: string, rules: KeywordRule[]): string | null {
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
      // 正则语法错误，跳过
    }
  }
  return null;
}

/**
 * 第一阶段：本地快速过滤（简介复读 + 关键词 + AI规则 + 缓存）
 * 立即返回本地结果 + 需要AI判定的评论列表
 */
export async function filterLocal(
  config: FilterConfig,
  replies: BiliReply[],
  ctx: ReplyContext,
  stats?: AccumulatedStats,
): Promise<FilterResult> {
  const violations = new Map<number, { reason: string }>();
  let newBlacklistEntries = 0;
  const needAICheck: BiliReply[] = [];

  if (replies.length === 0) return { violations, newBlacklistEntries, needAICheck };

  // Step 0: 简介复读机过滤
  const afterDesc: BiliReply[] = [];
  const desc = ctx.videoDesc?.trim().toLowerCase() || "";

  for (const reply of replies) {
    const msg = reply.content.message.trim().toLowerCase();
    // 评论与简介完全相同，或简介是评论的子串（且简介长度>10）
    if (desc && desc.length > 10 && (msg === desc || desc.includes(msg) || msg.includes(desc))) {
      violations.set(reply.rpid, { reason: "[简介复读] 评论与视频简介相同" });
      if (stats) stats.totalFiltered++;
    } else {
      afterDesc.push(reply);
    }
  }

  // Step 1: 关键词过滤
  const keywords = await getAllKeywords();
  const afterKeyword: BiliReply[] = [];

  for (const reply of afterDesc) {
    const match = matchKeyword(reply.content.message, keywords);
    if (match) {
      violations.set(reply.rpid, { reason: match });
      if (stats) stats.totalFiltered++;
    } else {
      afterKeyword.push(reply);
    }
  }

  // Step 2: AI学习规则过滤（本地，不调API）
  const aiRules = await getAllAIRules();
  const afterAIRules: BiliReply[] = [];

  for (const reply of afterKeyword) {
    const match = matchAIRule(reply.content.message, aiRules);
    if (match) {
      violations.set(reply.rpid, { reason: `[AI规则] ${match}` });
      if (stats) stats.totalFiltered++;
    } else {
      afterAIRules.push(reply);
    }
  }

  // Step 3: LRU缓存
  for (const reply of afterAIRules) {
    const hash = commentHash(reply.content.message, reply.mid);
    const cached = await getCache(hash);
    if (cached && cached.violation) {
      violations.set(reply.rpid, { reason: `[缓存] ${cached.reason}` });
      if (stats) stats.totalFiltered++;
      continue;
    }

    // 需要AI判定
    if (config.enableAI && !config.localOnly) {
      needAICheck.push(reply);
    }
  }

  if (stats) stats.lastUpdate = Date.now();
  return { violations, newBlacklistEntries, needAICheck };
}

/** 检查评论是否匹配AI学习规则 */
function matchAIRule(text: string, rules: AIRule[]): string | null {
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
      // 正则语法错误，跳过
    }
  }
  return null;
}

/**
 * 第二阶段：AI异步过滤
 * 调用AI API，返回结果
 */
export async function filterAI(
  config: FilterConfig,
  replies: BiliReply[],
  ctx: ReplyContext,
  stats?: AccumulatedStats,
): Promise<Map<number, { reason: string }>> {
  const violations = new Map<number, { reason: string }>();

  if (replies.length === 0 || config.localOnly || !config.apiKey || !config.enableAI) return violations;

  // 获取AI学习的提示词（如果启用）
  const aiLearnedPrompt = (config as any).enableAIPrompt && (config as any).aiLearnedPrompt
    ? "\n\n额外过滤规则：" + (config as any).aiLearnedPrompt
    : "";

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
          timestamp: Date.now(),
        });
      }

      if (v.violation) {
        violations.set(v.rpid, { reason: v.reason });
        if (stats) stats.totalFiltered++;
      }
    }
  } catch (err) {
    console.error(TAG, "AI判定失败:", err);
  }

  if (stats) stats.lastUpdate = Date.now();
  return violations;
}
