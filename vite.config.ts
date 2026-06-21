import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "哔哩哔哩评论区屏蔽",
        namespace: "bilibili-comment-block",
        version: "1.0.0",
        description: "AI驱动的B站评论过滤器，支持关键词屏蔽、黑名单、深色模式",
        match: ["*://www.bilibili.com/video/*", "*://www.bilibili.com/list*"],
        grant: ["GM_getValue", "GM_setValue", "GM_deleteValue", "unsafeWindow"],
        license: "MIT",
      },
      build: {
        fileName: "bilibili-comment-block.user.js",
        autoGrant: true,
      },
    }),
  ],
});
