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

const TAG = "[ruozhi-filter]";

function buildSystemPrompt(config: FilterConfig, ctx: ReplyContext): string {
  return `你是一个评论净化判官。你的任务是严格根据用户的过滤规则，判断每条评论是否违规。

## 判定标准
用户的过滤规则：${config.prompt}

违规判定维度：
- **性别对立**：将某一性别标签化、污名化，煽动敌视/仇恨（如"女人都拜金""男人都好色"）
- **人身攻击**：针对个人的侮辱、谩骂、诅咒
- **引战/煽动**：故意挑起争端，使用极端化言论
- **低文化水平煽动**：以偏概全、简化认知、传播刻板印象的明显反智言论
- **仇恨言论**：涉及种族、地域、性别、性取向等的歧视性言论

## 上下文
视频标题：${ctx.videoTitle}
视频简介：${ctx.videoDesc.slice(0, 500)}

## 输出要求
返回一个JSON对象，格式如下（不要包含任何markdown标记，只输出纯JSON）：
{
  "verdicts": [
    { "rpid": 123, "mid": 456, "violation": true, "reason": "煽动性别对立", "severity": "high" }
  ]
}

- severity 可选值: "none", "low", "medium", "high", "block"
- 只返回违规的评论（violation=true），没有违规则返回空数组`;
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
): Promise<AIBatchResult> {
  if (!config.apiKey || replies.length === 0) return { verdicts: [] };

  const systemPrompt = buildSystemPrompt(config, ctx);
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
