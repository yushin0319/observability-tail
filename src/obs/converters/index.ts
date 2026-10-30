/**
 * POST /obs-from/{name} の name → 変換関数。
 * 名前は Map で引く (オブジェクトだと "constructor" 等のプロトタイプのキーに当たる)。
 */
import type { ObsNotifyPayload } from "../obsNotifyPayload";
import { capGrafanaAlerts, convertGrafana } from "./grafana";
import { convertHealthchecks } from "./healthchecks";
import { convertNetdata } from "./netdata";
import { convertSentry } from "./sentry";

export type Converter = (body: unknown) => ObsNotifyPayload[];

export interface Adapter {
  /** 失敗の記録に出すステップ名 (n8n のノード名) */
  step: string;
  convert: Converter;
  /** 変換前に件数を切り詰める (切り捨てた件数を返す) */
  cap?: (body: unknown) => { body: unknown; dropped: number };
}

export const CONVERTERS: ReadonlyMap<string, Adapter> = new Map<string, Adapter>([
  ["sentry", { step: "ConvertSentry", convert: convertSentry }],
  ["healthchecks", { step: "ConvertHealthchecks", convert: convertHealthchecks }],
  [
    "grafana",
    { step: "ConvertGrafana", convert: convertGrafana, cap: (b) => capGrafanaAlerts(b) },
  ],
  ["netdata", { step: "ConvertNetdata", convert: convertNetdata }],
]);
