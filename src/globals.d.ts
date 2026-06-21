// ============================================================
// globals.d.ts - 声明 Tampermonkey/Violentmonkey API
// ============================================================

declare function GM_getValue(key: string, defaultValue?: string): string;
declare function GM_setValue(key: string, value: string): void;
declare function GM_deleteValue(key: string): void;
declare const unsafeWindow: Window & typeof globalThis;
