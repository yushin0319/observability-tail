/**
 * n8n-server code-nodes/api-obs-notify/PrepNotify.test.ts の移植。
 * $input / $env の stub は引数 (body / discordCriticalUrl) に置き換えた。
 */
import { describe, expect, it } from "vitest";
import { ObsPayloadError, prepNotify } from "./prepNotify";

const minimalBody = {
  severity: "info",
  service: "n8n",
  subject: "test",
};

const CRITICAL_URL = "https://discord.example/webhooks/X/Y";

describe("prepNotify", () => {
  it("正常系 (info): channel / Discord / Notion payload を構築", () => {
    const out = prepNotify(minimalBody);

    expect(out.channel).toBe("obs-info");
    const discord = out.discordBody as {
      embeds: { title: string; color: number }[];
      content?: string;
    };
    expect(discord.embeds[0].title).toBe("test");
    expect(discord.embeds[0].color).toBe(0x3498db);
    expect(discord.content).toBeUndefined();

    const notion = out.notionBody;
    expect(notion.parent.database_id).toBe(
      "3552570f-e49f-80a6-9186-c1a14b7d9547",
    );
    const props = notion.properties as Record<string, any>;
    expect(props.severity.select.name).toBe("info");
    expect(props.service.select.name).toBe("n8n");
    // Discord に送っていないので送信先は記録しない
    expect(props.discord_channel).toBeUndefined();
    expect(props.subject.title[0].text.content).toBe("test");
    expect(props.timestamp.date.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("severity=warning: yellow color / channel", () => {
    const out = prepNotify({ ...minimalBody, severity: "warning" });
    expect(out.channel).toBe("obs-warning");
    const discord = out.discordBody as Record<string, any>;
    expect(discord.embeds[0].color).toBe(0xf1c40f);
    expect(discord.content).toBeUndefined();
  });

  it("severity=critical: red color / @here / channel", () => {
    const out = prepNotify({ ...minimalBody, severity: "critical" });
    expect(out.channel).toBe("obs-critical");
    const discord = out.discordBody as Record<string, any>;
    expect(discord.embeds[0].color).toBe(0xe74c3c);
    expect(discord.content).toBe("@here");
  });

  it("discordCriticalUrl が設定されていれば critical の discordUrl を返す", () => {
    const out = prepNotify(
      { ...minimalBody, severity: "critical" },
      { discordCriticalUrl: CRITICAL_URL },
    );
    expect(out.discordUrl).toBe(CRITICAL_URL);
  });

  it("critical 以外は URL 設定があっても discordUrl は空文字", () => {
    const out = prepNotify(minimalBody, { discordCriticalUrl: CRITICAL_URL });
    expect(out.discordUrl).toBe("");
  });

  it("opts を渡さなくても throw せず discordUrl は空文字", () => {
    const out = prepNotify({ ...minimalBody, severity: "critical" });
    expect(out.discordUrl).toBe("");
  });

  it("repo / summary / url / raw_payload は任意", () => {
    const out = prepNotify({
      ...minimalBody,
      severity: "warning",
      repo: "shirankedo",
      summary: "RSS 0件",
      url: "https://example.com/issue/1",
      raw_payload: { foo: "bar" },
    });

    const props = out.notionBody.properties as Record<string, any>;
    expect(props.repo.select.name).toBe("shirankedo");
    expect(props.summary.rich_text[0].text.content).toBe("RSS 0件");
    expect(props.url.url).toBe("https://example.com/issue/1");
    expect(props.raw_payload.rich_text[0].text.content).toBe(
      JSON.stringify({ foo: "bar" }),
    );

    const discord = out.discordBody as Record<string, any>;
    expect(discord.embeds[0].url).toBe("https://example.com/issue/1");
    expect(discord.embeds[0].footer.text).toContain("shirankedo");
  });

  it("raw_payload が文字列ならそのまま使う", () => {
    const out = prepNotify({ ...minimalBody, raw_payload: "raw string" });
    const props = out.notionBody.properties as Record<string, any>;
    expect(props.raw_payload.rich_text[0].text.content).toBe("raw string");
  });

  it("subject 2000 字超は Notion 側で切り詰め (256 字超は Discord 側で切り詰め)", () => {
    const long = "あ".repeat(3000);
    const out = prepNotify({ ...minimalBody, subject: long });
    const props = out.notionBody.properties as Record<string, any>;
    expect(props.subject.title[0].text.content.length).toBe(2000);
    const discord = out.discordBody as Record<string, any>;
    expect(discord.embeds[0].title.length).toBe(256);
  });

  it("summary 2000 字超は Notion 側で切り詰め (4096 字超は Discord 側で切り詰め)", () => {
    const long = "x".repeat(5000);
    const out = prepNotify({ ...minimalBody, summary: long });
    const props = out.notionBody.properties as Record<string, any>;
    expect(props.summary.rich_text[0].text.content.length).toBe(2000);
    const discord = out.discordBody as Record<string, any>;
    expect(discord.embeds[0].description.length).toBe(4096);
  });

  it("raw_payload が長文 JSON でも 2000 字に切り詰め", () => {
    const big = { data: "y".repeat(5000) };
    const out = prepNotify({ ...minimalBody, raw_payload: big });
    const props = out.notionBody.properties as Record<string, any>;
    expect(props.raw_payload.rich_text[0].text.content.length).toBe(2000);
  });

  it("severity 不正で throw", () => {
    expect(() => prepNotify({ ...minimalBody, severity: "fatal" })).toThrow(
      "severity must be one of",
    );
  });

  it("service が許可リスト外で throw", () => {
    expect(() =>
      prepNotify({ ...minimalBody, service: "unknown-service" }),
    ).toThrow("service must be one of");
  });

  it("subject 欠如で throw", () => {
    expect(() => prepNotify({ severity: "info", service: "n8n" })).toThrow(
      "subject is required",
    );
  });

  it("url が非 http(s) ($URL placeholder 等) なら Discord/Notion 共に omit", () => {
    const out = prepNotify({ ...minimalBody, url: "$URL" });
    const discord = out.discordBody as Record<string, any>;
    expect(discord.embeds[0].url).toBeUndefined();
    const props = out.notionBody.properties as Record<string, any>;
    expect(props.url).toBeUndefined();
  });

  it("url が 2000 字を超えたら Discord/Notion 共に omit (2000 字ちょうどは通す)", () => {
    const base = "https://example.com/";
    const ok = base + "a".repeat(2000 - base.length);
    const tooLong = `${ok}b`;
    const kept = prepNotify({ ...minimalBody, url: ok });
    expect((kept.notionBody.properties as Record<string, any>).url.url).toBe(ok);
    const dropped = prepNotify({ ...minimalBody, url: tooLong });
    expect((dropped.discordBody as Record<string, any>).embeds[0].url).toBeUndefined();
    expect((dropped.notionBody.properties as Record<string, any>).url).toBeUndefined();
  });

  it("url が文字列でなければ omit (配列・オブジェクトを文字列扱いしない)", () => {
    for (const url of [["https://example.com/a"], { href: "https://example.com" }, 42]) {
      const out = prepNotify({ ...minimalBody, url });
      expect((out.discordBody as Record<string, any>).embeds[0].url).toBeUndefined();
      expect((out.notionBody.properties as Record<string, any>).url).toBeUndefined();
    }
  });

  it("Discord payload は allowed_mentions で everyone (@here) だけ許す", () => {
    const out = prepNotify({ ...minimalBody, severity: "critical" });
    expect(out.discordBody.allowed_mentions).toEqual({ parse: ["everyone"] });
  });

  it("repo が許可リスト外で throw", () => {
    expect(() => prepNotify({ ...minimalBody, repo: "unknown-repo" })).toThrow(
      "repo must be one of",
    );
  });

  it("不正 payload は ObsPayloadError (HTTP 400 にする種類) で throw", () => {
    expect(() => prepNotify(null)).toThrow(ObsPayloadError);
    expect(() => prepNotify(undefined)).toThrow(ObsPayloadError);
  });

  // 即時 Discord 送信は critical のみ。warning は cron/obs-daily-digest の日次まとめ、
  // info は Notion 記録のみ（Discord 通知過多の是正）
  describe("sendDiscordNow", () => {
    const withUrl = { discordCriticalUrl: CRITICAL_URL };

    it("critical + URL 設定あり → true / Notion に送信先を記録", () => {
      const out = prepNotify({ ...minimalBody, severity: "critical" }, withUrl);
      expect(out.sendDiscordNow).toBe(true);
      const props = out.notionBody.properties as Record<string, any>;
      expect(props.discord_channel.select.name).toBe("obs-critical");
    });

    it("warning は URL 設定があっても false（日次まとめに回す）", () => {
      const out = prepNotify({ ...minimalBody, severity: "warning" }, withUrl);
      expect(out.sendDiscordNow).toBe(false);
    });

    it("info は URL 設定があっても false（Notion 記録のみ）", () => {
      const out = prepNotify({ ...minimalBody, severity: "info" }, withUrl);
      expect(out.sendDiscordNow).toBe(false);
    });

    it("critical でも URL 未設定なら false（空 URL に POST しない）", () => {
      const out = prepNotify({ ...minimalBody, severity: "critical" }, {});
      expect(out.sendDiscordNow).toBe(false);
      const props = out.notionBody.properties as Record<string, any>;
      expect(props.discord_channel).toBeUndefined();
    });
  });
});
