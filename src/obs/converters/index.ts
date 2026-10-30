/**
 * POST /obs-from/{name} の name → 変換関数。
 * 名前は Map で引く (オブジェクトだと "constructor" 等のプロトタイプのキーに当たる)。
 */
import type { ObsNotifyPayload } from "../obsNotifyPayload";
import { convertGrafana } from "./grafana";
import { convertHealthchecks } from "./healthchecks";
import { convertNetdata } from "./netdata";
import { convertSentry } from "./sentry";

export type Converter = (body: unknown) => ObsNotifyPayload[];

export const CONVERTERS: ReadonlyMap<string, { step: string; convert: Converter }> =
  new Map([
    ["sentry", { step: "ConvertSentry", convert: convertSentry }],
    ["healthchecks", { step: "ConvertHealthchecks", convert: convertHealthchecks }],
    ["grafana", { step: "ConvertGrafana", convert: convertGrafana }],
    ["netdata", { step: "ConvertNetdata", convert: convertNetdata }],
  ]);
