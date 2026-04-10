#!/usr/bin/env node
/**
 * Stress-test Vertex AI regions for gemini-2.5-flash to surface 429 rates
 * and latency distribution under concurrent load. Mirrors a real burst by
 * firing N parallel requests per region, then reports:
 *
 *   - success / 429 / other error counts
 *   - p50 / p95 / p99 latency (successful requests only)
 *   - error rate %
 *
 * Regions are tested sequentially with a cooldown between them so that
 * DSQ pressure from one region does not leak into the next measurement.
 *
 * Usage:
 *   node scripts/stress-regions.mjs
 *   node scripts/stress-regions.mjs --burst 50 --cooldown 3000
 *   node scripts/stress-regions.mjs --model gemini-2.5-pro --burst 20
 *   node scripts/stress-regions.mjs --json > report.json
 *
 * Flags:
 *   --burst N        concurrent requests per region (default: 30)
 *   --cooldown MS    pause between regions in ms     (default: 2000)
 *   --model ID       model to probe                  (default: gemini-2.5-flash)
 *   --regions CSV    comma-separated region list to override defaults
 *   --json           emit machine-readable JSON
 */

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const DEFAULT_REGIONS = [
  "global",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west4",
];

// Small but non-trivial prompt so we exercise real token counting, not a
// one-character no-op that hits a hot path.
const PROMPT =
  "Reply with a single short sentence summarizing the color of the sky on a clear day.";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    burst: 30,
    cooldown: 2000,
    model: "gemini-2.5-flash",
    json: false,
    regions: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--burst") out.burst = parseInt(args[++i], 10);
    else if (a === "--cooldown") out.cooldown = parseInt(args[++i], 10);
    else if (a === "--model") out.model = args[++i];
    else if (a === "--regions") out.regions = args[++i].split(",").map((s) => s.trim());
  }
  return out;
}

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
  const jwt = `${signingInput}.${base64url(signer.sign(sa.private_key))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function singleCall({ region, projectId, model, token }) {
  const host =
    region === "global"
      ? "aiplatform.googleapis.com"
      : `${region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: PROMPT }] }],
    generationConfig: { maxOutputTokens: 32, temperature: 0 },
  });

  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    const latencyMs = Date.now() - t0;
    if (res.ok) {
      // consume body so the connection can be reused
      await res.json().catch(() => null);
      return { ok: true, status: 200, latencyMs };
    }
    const text = await res.text();
    let message = "";
    try {
      const j = JSON.parse(text);
      message = (j?.error?.message ?? text).slice(0, 120);
    } catch {
      message = text.slice(0, 120);
    }
    return { ok: false, status: res.status, latencyMs, message };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - t0,
      message: `network: ${err.message}`,
    };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function stressRegion({ region, projectId, model, token, burst }) {
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: burst }, () => singleCall({ region, projectId, model, token }))
  );
  const wallMs = Date.now() - started;

  const ok = results.filter((r) => r.ok);
  const r429 = results.filter((r) => r.status === 429);
  const r503 = results.filter((r) => r.status === 503 || r.status === 504);
  const otherErr = results.filter(
    (r) => !r.ok && r.status !== 429 && r.status !== 503 && r.status !== 504
  );

  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const sampleErr = [...r429, ...r503, ...otherErr][0]?.message ?? "";

  return {
    region,
    sent: burst,
    ok: ok.length,
    r429: r429.length,
    r5xx: r503.length,
    otherErr: otherErr.length,
    errorRate: burst === 0 ? 0 : ((burst - ok.length) / burst) * 100,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    wallMs,
    sampleErr,
  };
}

async function main() {
  const { burst, cooldown, model, json: jsonOut, regions: regionsOverride } = parseArgs();
  const regionsToTest = regionsOverride ?? DEFAULT_REGIONS;
  const env = parseDevVars(resolve(repoRoot, ".dev.vars"));
  const projectId = env.VERTEX_PROJECT_ID;
  const saJson = env.VERTEX_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) {
    console.error("Missing VERTEX_PROJECT_ID or VERTEX_SERVICE_ACCOUNT_JSON in .dev.vars");
    process.exit(1);
  }

  if (!jsonOut) {
    console.error(
      `Stress test: model=${model}  burst=${burst}/region  cooldown=${cooldown}ms  project=${projectId}`
    );
    console.error(`Regions (${regionsToTest.length}): ${regionsToTest.join(", ")}\n`);
  }

  const token = await getAccessToken(saJson);

  const results = [];
  for (const region of regionsToTest) {
    if (!jsonOut) process.stderr.write(`→ ${region.padEnd(24)} `);
    const r = await stressRegion({ region, projectId, model, token, burst });
    results.push(r);
    if (!jsonOut) {
      process.stderr.write(
        `ok=${r.ok}/${r.sent}  429=${r.r429}  5xx=${r.r5xx}  err=${r.otherErr}  p95=${r.p95 ?? "-"}ms  wall=${r.wallMs}ms\n`
      );
    }
    if (region !== regionsToTest[regionsToTest.length - 1]) {
      await new Promise((r) => setTimeout(r, cooldown));
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify({ model, projectId, burst, cooldown, results }, null, 2));
    return;
  }

  // Sort by error rate asc, then p95 asc — "best region first"
  const ranked = [...results].sort(
    (a, b) => a.errorRate - b.errorRate || (a.p95 ?? 1e9) - (b.p95 ?? 1e9)
  );

  const pad = (s, n) => String(s ?? "-").padEnd(n);
  console.log("\n=== Results (ranked by error rate, then p95) ===\n");
  console.log(
    `${pad("REGION", 24)} ${pad("OK/SENT", 10)} ${pad("429", 5)} ${pad("5XX", 5)} ${pad("ERR", 5)} ${pad("ERR%", 7)} ${pad("p50", 7)} ${pad("p95", 7)} ${pad("p99", 7)} SAMPLE ERROR`
  );
  console.log("-".repeat(130));
  for (const r of ranked) {
    console.log(
      `${pad(r.region, 24)} ${pad(`${r.ok}/${r.sent}`, 10)} ${pad(r.r429, 5)} ${pad(r.r5xx, 5)} ${pad(r.otherErr, 5)} ${pad(r.errorRate.toFixed(1), 7)} ${pad(r.p50, 7)} ${pad(r.p95, 7)} ${pad(r.p99, 7)} ${r.sampleErr}`
    );
  }

  const totalSent = results.reduce((s, r) => s + r.sent, 0);
  const totalOk = results.reduce((s, r) => s + r.ok, 0);
  const total429 = results.reduce((s, r) => s + r.r429, 0);
  console.log(
    `\nTotal: sent=${totalSent}  ok=${totalOk}  429=${total429}  overall_err=${(((totalSent - totalOk) / totalSent) * 100).toFixed(1)}%`
  );
  console.log(
    `Best region now: ${ranked[0].region} (${ranked[0].errorRate.toFixed(1)}% err, p95=${ranked[0].p95}ms)`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
