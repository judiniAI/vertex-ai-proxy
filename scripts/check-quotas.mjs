#!/usr/bin/env node
/**
 * Reports Vertex AI quota limits and recent usage for the project configured
 * in .dev.vars. Uses the same service account as the gateway, so the active
 * gcloud session is irrelevant.
 *
 * Usage:
 *   node scripts/check-quotas.mjs
 *   node scripts/check-quotas.mjs --model gemini-2.5-pro
 *   node scripts/check-quotas.mjs --json
 *
 * Data sources:
 *   1. Service Usage v1beta1  consumerQuotaMetrics  → effective limits per region/model
 *   2. Cloud Monitoring v3    timeSeries            → live usage rate, last 10 min
 *
 * The service account in .dev.vars must have:
 *   - roles/serviceusage.serviceUsageConsumer  (quota read)
 *   - roles/monitoring.viewer                  (timeseries read)
 */

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Metrics worth surfacing for Gemini base models. Includes both per-region and
// global tracks because projects pinned to VERTEX_REGION=global use the
// global_* variants exclusively.
const QUOTA_METRICS = [
  // Per-region (used when VERTEX_REGION is a specific location like us-central1)
  "aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model",
  "aiplatform.googleapis.com/generate_content_input_tokens_per_minute_per_project_per_base_model",
  // Global endpoint (used when VERTEX_REGION=global)
  "aiplatform.googleapis.com/global_generate_content_requests_per_minute_per_project_per_base_model",
  "aiplatform.googleapis.com/global_generate_content_input_tokens_per_minute_per_base_model",
  // Bidirectional / live audio
  "aiplatform.googleapis.com/bidi_gen_concurrent_reqs_per_project_per_base_model",
  // Generic prediction (covers some model families)
  "aiplatform.googleapis.com/online_prediction_requests_per_base_model",
];

function parseDevVars(path) {
  const text = readFileSync(path, "utf8");
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[key] = v;
  }
  return out;
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(sa.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

async function fetchQuotaLimits({ projectId, token }) {
  const url = `https://serviceusage.googleapis.com/v1beta1/projects/${projectId}/services/aiplatform.googleapis.com/consumerQuotaMetrics?pageSize=500&view=FULL`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`serviceusage error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function flattenLimits(metricsResponse, modelFilter) {
  const rows = [];
  for (const metric of metricsResponse.metrics ?? []) {
    if (!QUOTA_METRICS.includes(metric.metric)) continue;
    for (const limit of metric.consumerQuotaLimits ?? []) {
      for (const bucket of limit.quotaBuckets ?? []) {
        const dims = bucket.dimensions ?? {};
        // Only keep buckets that actually carry a base_model dimension AND a numeric limit.
        // The placeholder buckets (region-only, no limit) are aggregates we don't care about.
        if (!dims.base_model) continue;
        if (bucket.effectiveLimit === undefined && bucket.defaultLimit === undefined) continue;
        // Substring match — Vertex tracks "gemini-2.5-flash" as "gemini-2.5-flash-ga"
        if (modelFilter && !dims.base_model.includes(modelFilter)) continue;
        rows.push({
          metric: metric.metric.split("/").pop(),
          unit: metric.unit,
          region: dims.region ?? "(global)",
          model: dims.base_model,
          effectiveLimit: bucket.effectiveLimit ?? "n/a",
          defaultLimit: bucket.defaultLimit ?? "n/a",
        });
      }
    }
  }
  return rows;
}

async function fetchUsage({ projectId, token, metricFullName }) {
  const now = new Date();
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
  const filter = `metric.type="serviceruntime.googleapis.com/quota/rate/net_usage" AND metric.labels.quota_metric="${metricFullName}"`;
  const params = new URLSearchParams({
    filter,
    "interval.startTime": tenMinAgo.toISOString(),
    "interval.endTime": now.toISOString(),
    "aggregation.alignmentPeriod": "60s",
    "aggregation.perSeriesAligner": "ALIGN_RATE",
  });
  const url = `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    return { error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
  return res.json();
}

function flattenUsage(timeseriesJson) {
  const out = [];
  for (const ts of timeseriesJson.timeSeries ?? []) {
    const region = ts.metric?.labels?.location ?? ts.resource?.labels?.location ?? "?";
    const model =
      ts.metric?.labels?.base_model ??
      ts.metric?.labels?.model ??
      ts.resource?.labels?.method ??
      "?";
    const points = ts.points ?? [];
    const latest = points[0]?.value;
    const value = latest?.doubleValue ?? latest?.int64Value ?? "n/a";
    out.push({ region, model, points: points.length, latestRate: value });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const modelIdx = args.indexOf("--model");
  const modelFilter = modelIdx >= 0 ? args[modelIdx + 1] : "gemini-2.5-flash";

  const env = parseDevVars(resolve(repoRoot, ".dev.vars"));
  const projectId = env.VERTEX_PROJECT_ID;
  const saJson = env.VERTEX_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) {
    console.error("Missing VERTEX_PROJECT_ID or VERTEX_SERVICE_ACCOUNT_JSON in .dev.vars");
    process.exit(1);
  }

  if (!jsonOutput) {
    console.error(`Project: ${projectId}`);
    console.error(`Model filter: ${modelFilter || "(all)"}\n`);
  }

  const token = await getAccessToken(saJson);

  // 1. Limits
  let limitRows = [];
  let limitError = null;
  try {
    const metrics = await fetchQuotaLimits({ projectId, token });
    limitRows = flattenLimits(metrics, modelFilter);
  } catch (err) {
    limitError = err.message;
  }

  // 2. Usage
  const usageByMetric = {};
  for (const m of QUOTA_METRICS) {
    const r = await fetchUsage({ projectId, token, metricFullName: m });
    usageByMetric[m] = r.error ? { error: r.error } : { rows: flattenUsage(r) };
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        { projectId, modelFilter, limitError, limits: limitRows, usage: usageByMetric },
        null,
        2
      )
    );
    return;
  }

  // Pretty print limits
  console.log("### 1. Quota limits (effective per region × base_model)\n");
  if (limitError) {
    console.log(`  ERROR: ${limitError}`);
    console.log("  → Grant the service account 'roles/serviceusage.serviceUsageConsumer'.\n");
  } else if (limitRows.length === 0) {
    console.log(`  (no rows matched "${modelFilter}" — try a broader filter, e.g. --model gemini-2.5)\n`);
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    // Group by metric for readability
    const byMetric = {};
    for (const r of limitRows) (byMetric[r.metric] ??= []).push(r);
    for (const [metric, rows] of Object.entries(byMetric)) {
      console.log(`--- ${metric}  (unit: ${rows[0].unit})`);
      console.log(`${pad("REGION", 24)} ${pad("MODEL", 28)} ${pad("EFFECTIVE", 12)} DEFAULT`);
      rows.sort(
        (a, b) => a.model.localeCompare(b.model) || a.region.localeCompare(b.region)
      );
      for (const r of rows) {
        console.log(
          `${pad(r.region, 24)} ${pad(r.model, 28)} ${pad(r.effectiveLimit, 12)} ${r.defaultLimit}`
        );
      }
      console.log();
    }
  }

  // Pretty print usage
  console.log("\n### 2. Live usage (last 10 min, Cloud Monitoring)\n");
  for (const [metric, data] of Object.entries(usageByMetric)) {
    const short = metric.split("/").pop();
    console.log(`--- ${short}`);
    if (data.error) {
      console.log(`  ERROR: ${data.error}`);
      console.log("  → Grant the service account 'roles/monitoring.viewer'.");
    } else if (!data.rows || data.rows.length === 0) {
      console.log("  (no usage in window)");
    } else {
      for (const row of data.rows) {
        console.log(
          `  region=${row.region}  model=${row.model}  points=${row.points}  rate≈${row.latestRate}`
        );
      }
    }
    console.log();
  }

  console.log(
    `UI: https://console.cloud.google.com/iam-admin/quotas?project=${projectId}&service=aiplatform.googleapis.com`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
