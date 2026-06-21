// ============================================================
// types.ts - 全局类型定义
// ============================================================

/** B站评论API返回的评论数据 */
export interface BiliReply {
  rpid: number;
  oid: number;
  mid: number;
  root: number;
  parent: number;
  count: number;
  rcount: number;
  like: number;
  ctime: number;
  content: {
    message: string;
    jump_url?: Record<string, unknown>;
    [key: string]: unknown;
  };
  member: {
    mid: string;
    uname: string;
    avatar: string;
    [key: string]: unknown;
  };
  replies?: BiliReply[] | null;
  [key: string]: unknown;
}

/** B站评论API响应 */
export interface BiliReplyResponse {
  code: number;
  message: string;
  data?: {
    replies: BiliReply[];
    page: {
      num: number;
      size: number;
      count: number;
    };
    top?: {
      upper?: BiliReply | null;
      admin?: BiliReply | null;
    };
  };
}

/** AI服务提供商预设 */
export interface AIProvider {
  name: string;
  apiEndpoint: string;
  models: string[];
}

/** 预设AI服务提供商 */
export const AI_PROVIDERS: AIProvider[] = [
  {
    name: "DeepSeek",
    apiEndpoint: "https://api.deepseek.com/chat/completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    name: "Mimo (小米)",
    apiEndpoint: "https://api.xiaomimimo.com/v1/chat/completions",
    models: ["MiMo-7B-RL", "mimo-v2.5"],
  },
];

/** 用户自定义过滤规则 */
export interface FilterConfig {
  apiKey: string;
  /** 各提供商独立保存的 API Key */
  apiKeys: {
    deepseek: string;
    mimo: string;
    custom: string;
  };
  /** AI服务提供商: "deepseek" | "mimo" | "custom" */
  provider: "deepseek" | "mimo" | "custom";
  apiEndpoint: string;
  model: string;
  prompt: string;
  /** 是否开启折叠模式(而非完全隐藏) */
  foldMode: boolean;
  /** 纯本地模式: 禁用AI，只使用关键词和黑名单 */
  localOnly: boolean;
  /** 是否启用AI过滤 */
  enableAI: boolean;
  /** 自定义token单价 (元/百万token) */
  pricePerMToken: number;
  /** 深色模式: "light" | "dark" | "auto" */
  darkMode: "light" | "dark" | "auto";
}

/** AI判定结果: 单条评论的违规判定 */
export interface AIVerdict {
  rpid: number;
  mid: number;
  violation: boolean;
  reason: string;
}

/** AI批处理返回 */
export interface AIBatchResult {
  verdicts: AIVerdict[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 被屏蔽的评论记录 */
export interface FilteredComment {
  id: number;
  uname: string;
  message: string;
  reason: string;
  timestamp: number;
  /** 用户反馈: "like"=点赞, "dislike"=点踩, null=无反馈 */
  feedback?: "like" | "dislike" | null;
}

/** 误判记录（用于AI学习） */
export interface FalsePositive {
  id: number;
  uname: string;
  message: string;
  reason: string;
  originalReason: string;
  timestamp: number;
}

/** 累计统计 */
export interface AccumulatedStats {
  totalFiltered: number;
  totalScanned: number;
  apiCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  lastUpdate: number;
  /** 最近被屏蔽的评论 (最多保留50条) */
  recentFiltered: FilteredComment[];
}

/** 黑名单记录 */
export interface BlacklistRecord {
  uid?: number;
  mid: number;
  uname: string;
  rpid: number;
  message: string;
  reason: string;
  videoTitle: string;
  videoUrl: string;
  timestamp: number;
  /** 来源: auto=AI自动, manual=用户手动 */
  source: "auto" | "manual";
}

/** 评论缓存条目 (LRU) */
export interface CacheEntry {
  hash: string;
  violation: boolean;
  reason: string;
  timestamp: number;
}

/** 拦截到的评论请求上下文 */
export interface ReplyContext {
  oid: number;
  videoTitle: string;
  videoDesc: string;
}

/** 用户标记的不想看的评论 */
export interface MarkedComment {
  id: number;
  uname: string;
  message: string;
  reason: string;
  timestamp: number;
  /** 是否已被AI学习 */
  learned?: boolean;
}

/** AI学习生成的过滤规则 */
export interface AIRule {
  id: number;
  /** 规则内容（正则表达式或关键词） */
  pattern: string;
  /** 是否为正则 */
  isRegex: boolean;
  /** 规则描述 */
  description: string;
  /** 匹配的评论列表（仅备注，不参与屏蔽） */
  matchedComments: string[];
  /** 创建时间 */
  createdAt: number;
  /** 最后学习时间 */
  lastLearnedAt: number;
  /** 基于多少条样本学习 */
  sampleCount: number;
}

/** 关键词屏蔽规则 */
export interface KeywordRule {
  id: number;
  /** 关键词或正则表达式 */
  pattern: string;
  /** 是否为正则表达式 */
  isRegex: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** 备注 */
  note: string;
  /** 创建时间 */
  timestamp: number;
}

/** 默认配置 */
export const DEFAULT_CONFIG: FilterConfig = {
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
  enableAI: false,
  pricePerMToken: 1.1,
  darkMode: "auto",
};
