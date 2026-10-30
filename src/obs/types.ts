/**
 * 観測性イベント受付 (obs-notify / obs-from-*) で共有する型。
 */

/** JSON オブジェクト (n8n の IDataObject 相当) */
export type JsonObject = Record<string, unknown>;

/**
 * Queue に積む再送メッセージ。Notion ページのプロパティだけを持ち、
 * 書き込み先 (観測性 DB) は consumer が付ける。
 */
export interface ObsRetryMessage {
  properties: JsonObject;
  /** ログで見分けるための subject (先頭 200 文字) */
  subject: string;
}

/** 受付処理が使う secret / binding */
export interface ObsEnv {
  /** POST /obs-notify の X-Webhook-Secret と照合する */
  WEBHOOK_SECRET?: string;
  /** POST /obs-from/{healthchecks|grafana|netdata} の X-Adapter-Token と照合する */
  ADAPTER_TOKEN?: string;
  /** POST /obs-from/sentry のパス末尾または X-Adapter-Token と照合する (Sentry 専用) */
  SENTRY_ADAPTER_TOKEN?: string;
  /** Notion integration token (観測性 DB への書き込み権限) */
  NOTION_TOKEN?: string;
  /** critical を即時に送る Discord webhook URL */
  DISCORD_CRITICAL_URL?: string;
  /** Notion 書き込みに失敗したイベントの再送キュー (未作成なら undefined) */
  OBS_RETRY_QUEUE?: Queue<ObsRetryMessage>;
  /** 同じ critical を 60 秒以内に Discord へ 2 度送らないための記録 (tail の重複抑制と共用) */
  DEDUP_KV?: KVNamespace;
}
