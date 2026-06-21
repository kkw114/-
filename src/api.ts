// ============================================================
// api.ts - DeepSeek API 通信层
// ============================================================
import type {
  FilterConfig,
  BiliReply,
  AIVerdict,
  AIBatchResult,
  ReplyContext,
} from "./types";

const TAG = "[comment-block]";

function buildSystemPrompt(config: FilterConfig, ctx: ReplyContext): string {
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

function buildUserMessage(replies: BiliReply[]): string {
  const comments = replies.map((r) => ({
    rpid: r.rpid,
    mid: r.mid,
    uname: r.member.uname,
    content: r.content.message,
  }));
  return JSON.stringify(comments, null, 2);
}

/** 调用 DeepSeek API 批量判定 */
export async function batchJudge(
  config: FilterConfig,
  replies: BiliReply[],
  ctx: ReplyContext,
  extraPrompt?: string,
): Promise<AIBatchResult> {
  if (!config.apiKey || replies.length === 0) return { verdicts: [] };

  const systemPrompt = buildSystemPrompt(config, ctx) + (extraPrompt || "");
  const userMessage = buildUserMessage(replies);

  const fetchStart = Date.now();

  // ★ 使用原生 fetch 的引用，避免被自己的拦截器干扰
  // 注意：由于我们在 interceptor.ts 中覆盖了 window.fetch，
  // 但 DeepSeek API URL 不匹配 B站 pattern，所以不会被拦截。
  // 但如果要绝对安全，可以用 unsafeWindow.fetch
  const fetcher: typeof fetch = (
    typeof unsafeWindow !== "undefined" ? unsafeWindow.fetch : window.fetch
  ) as typeof fetch;

  try {
    const response = await fetcher(config.apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      }),
    });

    console.log(
      TAG,
      `📡 API HTTP ${response.status}, ${Date.now() - fetchStart}ms`,
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(TAG, `❌ API ${response.status}:`, errText.slice(0, 200));
      throw new Error(`DeepSeek API error ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const usage = data.usage;

    if (!content) {
      console.warn(TAG, "⚠️ AI 返回空内容");
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
      console.error(TAG, "❌ AI 返回解析失败:", e);
      return { verdicts: [], usage };
    }
  } catch (err) {
    console.error(TAG, "❌ 网络请求失败:", err);
    throw err;
  }
}

/** 测试API连通性 */
export async function testAPIConnection(
  config: FilterConfig,
): Promise<boolean> {
  try {
    const fetcher: typeof fetch = (
      typeof unsafeWindow !== "undefined" ? unsafeWindow.fetch : window.fetch
    ) as typeof fetch;
    const response = await fetcher(config.apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 获取模型列表 */
export async function fetchModels(
  apiEndpoint: string,
  apiKey: string,
): Promise<string[]> {
  try {
    const fetcher: typeof fetch = (
      typeof unsafeWindow !== "undefined" ? unsafeWindow.fetch : window.fetch
    ) as typeof fetch;

    // 将 /chat/completions 替换为 /models
    const modelsEndpoint = apiEndpoint.replace(/\/chat\/completions$/, "/models");

    const response = await fetcher(modelsEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) return [];

    const data = await response.json();
    // 兼容 OpenAI 格式: { data: [{ id: "model-name" }, ...] }
    if (data?.data && Array.isArray(data.data)) {
      return data.data.map((m: { id: string }) => m.id).filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

/** AI学习：根据标记评论生成过滤规则和AI提示词 */
export async function learnFromMarked(
  config: FilterConfig,
  markedComments: { message: string; reason: string }[],
  existingAIRules: { pattern: string; isRegex: boolean; description: string }[],
  likeComments?: { message: string; reason: string; rule: string }[],
  dislikeComments?: { message: string; reason: string; rule: string }[],
): Promise<{ rules: { pattern: string; isRegex: boolean; description: string; matchedComments: string[] }[]; aiPrompt: string }> {
  if (!config.apiKey || (markedComments.length === 0 && (!likeComments || likeComments.length === 0) && (!dislikeComments || dislikeComments.length === 0))) return { rules: [], aiPrompt: "" };

  const fetcher: typeof fetch = (
    typeof unsafeWindow !== "undefined" ? unsafeWindow.fetch : window.fetch
  ) as typeof fetch;

  // 去掉表情符号后用于训练
  const cleanMessage = (msg: string) => msg.replace(/\[\[.*?\]\]/g, "").replace(/\[.*?\]/g, "").trim();
  const samples = markedComments.map((c, i) => `${i + 1}. "${cleanMessage(c.message)}" (用户原因: ${c.reason || "未说明"})`).join("\n");
  const existingRulesText = existingAIRules.length > 0 
    ? `\n已有的AI规则（请分析后合并/优化/删除，给出最终版本）：\n${existingAIRules.map((r, i) => `${i + 1}. [${r.isRegex ? "正则" : "关键词"}] ${r.pattern} - ${r.description}`).join("\n")}` 
    : "";

  // 构建点赞点踩评论文本
  let feedbackText = "";
  if (likeComments && likeComments.length > 0) {
    feedbackText += `\n用户对这些评论的屏蔽效果满意：\n${likeComments.map((c, i) => `${i + 1}. "${cleanMessage(c.message)}" (屏蔽原因: ${c.rule})`).join("\n")}`;
  }
  if (dislikeComments && dislikeComments.length > 0) {
    feedbackText += `\n用户表示以下评论被规则误判：\n${dislikeComments.map((c, i) => `${i + 1}. "${cleanMessage(c.message)}" (屏蔽原因: ${c.rule})`).join("\n")}`;
  }

  const prompt = `你是一个评论过滤规则生成器。用户标记了一些不想看的评论，请分析这些评论的共同特征，分类生成正则表达式、关键词规则，并生成一段AI提示词。

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
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) return { rules: [], aiPrompt: "" };

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { rules: [], aiPrompt: "" };

    let jsonStr = content.trim();
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);

    const parsed = JSON.parse(jsonStr.trim());
    
    // 合并正则和关键词规则
    const regexRules = (parsed.regexRules ?? []).map((r: any) => ({ ...r, isRegex: true }));
    const keywordRules = (parsed.keywordRules ?? []).map((r: any) => ({ ...r, isRegex: false }));
    const rules = (parsed.rules ?? []).concat(regexRules, keywordRules);
    
    // AI提示词后加表情过滤规则
    const aiPrompt = (parsed.aiPrompt ?? "") + "\n只有一个表情的表情符号的（如[[doge]]）";
    
    return {
      rules,
      aiPrompt,
    };
  } catch {
    return { rules: [], aiPrompt: "" };
  }
}
