#!/usr/bin/env node
/**
 * Sustained-traffic simulation that bypasses wrangler dev and calls Vertex
 * directly with the SAME retry+multi-region fallback logic used in
 * src/chat.ts. This isolates the gateway's algorithmic behavior from
 * wrangler's localhost connection limits, which were the bottleneck in
 * scripts/sustained-gateway.mjs at high concurrency.
 *
 * Produces a faithful estimate of what the gateway would do in Cloudflare
 * Workers production (where there's no localhost socket exhaustion).
 *
 * Usage:
 *   node scripts/sustained-direct.mjs                     # 10 rps × 60s
 *   node scripts/sustained-direct.mjs --total 600 --duration 60
 *   node scripts/sustained-direct.mjs --rps 15 --duration 40
 *
 * Measures the final error rate AFTER retry+fallback absorbs upstream 429s.
 */

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// --- Config mirrors src/chat.ts exactly ---
const DEFAULT_CHAIN = [
  "global",
  "us-east5",
  "us-south1",
  "us-west4",
  "us-east1",
  "us-east4",
  "us-west1",
  "us-central1",
];
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2000;
const OVERALL_BUDGET_MS = 25_000;
const LONG_RETRY_THRESHOLD_SEC = 5;

function parseDevVars(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function parseArgs() {
  const out = {
    rps: null,
    duration: 60,
    total: 600,
    model: "gemini-2.5-flash",
    maxAttempts: 2,
    chain: null,
    label: "",
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rps") out.rps = parseFloat(args[++i]);
    else if (args[i] === "--duration") out.duration = parseFloat(args[++i]);
    else if (args[i] === "--total") out.total = parseInt(args[++i], 10);
    else if (args[i] === "--model") out.model = args[++i];
    else if (args[i] === "--max-attempts") out.maxAttempts = parseInt(args[++i], 10);
    else if (args[i] === "--chain") out.chain = args[++i].split(",").map((s) => s.trim());
    else if (args[i] === "--label") out.label = args[++i];
  }
  if (out.rps == null) out.rps = out.total / out.duration;
  if (out.chain == null) out.chain = DEFAULT_CHAIN;
  return out;
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

// --- Retry + fallback (inlined port of src/chat.ts fetchGeminiWithFallback) ---

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredBackoffMs(attempt) {
  const cap = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * Math.pow(2, attempt));
  return Math.random() * cap;
}

function parseRetryInfoSeconds(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const errObj = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    const details = errObj?.details;
    if (!Array.isArray(details)) return null;
    for (const d of details) {
      if (typeof d?.["@type"] === "string" && d["@type"].includes("RetryInfo") && typeof d.retryDelay === "string") {
        const m = d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
        if (m) return parseFloat(m[1]);
      }
    }
  } catch { /* ignore */ }
  return null;
}

function buildGeminiUrl(projectId, region, model) {
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
}

async function fetchWithFallback({ projectId, model, token, requestBody, chain, maxAttempts }) {
  const startedAt = Date.now();
  const attemptLog = [];
  const regions = [...chain];
  const MAX_ATTEMPTS_PER_REGION = maxAttempts;

  let lastStatus = 0;
  let lastBody = null;

  outer: for (const region of regions) {
    if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
      attemptLog.push(`${region}:budget`);
      break;
    }
    const url = buildGeminiUrl(projectId, region, model);

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_REGION; attempt++) {
      if (Date.now() - startedAt > OVERALL_BUDGET_MS) break outer;
      if (attempt > 0) await sleep(jitteredBackoffMs(attempt - 1));

      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: requestBody,
        });
      } catch (err) {
        attemptLog.push(`${region}#${attempt}:net`);
        continue;
      }

      if (res.ok) {
        attemptLog.push(`${region}#${attempt}:ok`);
        // Drain body so connection can be reused
        await res.json().catch(() => null);
        return { ok: true, region, attemptLog, status: 200 };
      }

      const bodyText = await res.text();
      lastStatus = res.status;
      lastBody = bodyText;
      attemptLog.push(`${region}#${attempt}:${res.status}`);

      if (!RETRYABLE_STATUS.has(res.status)) {
        return { ok: false, region, attemptLog, status: res.status, body: bodyText };
      }

      const retryAfterSec = parseRetryInfoSeconds(bodyText);
      if (retryAfterSec != null && retryAfterSec > LONG_RETRY_THRESHOLD_SEC) {
        attemptLog.push(`${region}:skip(${retryAfterSec}s)`);
        continue outer;
      }
      if (retryAfterSec != null && retryAfterSec > 0) await sleep(retryAfterSec * 1000);
    }
  }
  return { ok: false, region: "none", attemptLog, status: lastStatus || 502, body: lastBody };
}

// --- Runner ---

async function callOnce(projectId, model, token, counter, chain, maxAttempts) {
  counter.inflight++;
  if (counter.inflight > counter.peak) counter.peak = counter.inflight;

  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "Reply in exactly 4 words" }] }],
    generationConfig: { maxOutputTokens: 20, temperature: 0 },
  });

  const t0 = Date.now();
  try {
    const r = await fetchWithFallback({ projectId, model, token, requestBody, chain, maxAttempts });
    return { ...r, latencyMs: Date.now() - t0 };
  } finally {
    counter.inflight--;
  }
}

async function main() {
  const { rps, duration, total, model, maxAttempts, chain, label } = parseArgs();
  const env = parseDevVars(resolve(repoRoot, ".dev.vars"));
  const projectId = env.VERTEX_PROJECT_ID;
  const saJson = env.VERTEX_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) {
    console.error("Missing VERTEX_PROJECT_ID or VERTEX_SERVICE_ACCOUNT_JSON in .dev.vars");
    process.exit(1);
  }

  const targetTotal = total || Math.round(rps * duration);
  const intervalMs = 1000 / rps;

  if (label) console.error(`=== ${label} ===`);
  console.error(`Sustained test (direct to Vertex, with retry+fallback logic from src/chat.ts)`);
  console.error(`  model=${model}  rps=${rps.toFixed(2)}  duration=${duration}s  total=${targetTotal}`);
  console.error(`  arrival interval=${intervalMs.toFixed(0)}ms (Poisson-jittered)`);
  console.error(`  max attempts per region: ${maxAttempts}`);
  console.error(`  fallback chain (${chain.length}): ${chain.join(" → ")}\n`);

  const token = await getAccessToken(saJson);

  const counter = { inflight: 0, peak: 0 };
  const promises = [];
  const startAt = Date.now();

  for (let i = 0; i < targetTotal; i++) {
    const jitter = -Math.log(1 - Math.random()) * intervalMs;
    const targetAt = startAt + i * intervalMs + (jitter - intervalMs) * 0.3;
    const waitMs = Math.max(0, targetAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);

    promises.push(callOnce(projectId, model, token, counter, chain, maxAttempts));

    if ((i + 1) % Math.max(1, Math.round(targetTotal / 10)) === 0) {
      const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
      process.stderr.write(`  fired ${i + 1}/${targetTotal} at ${elapsed}s  inflight=${counter.inflight}  peak=${counter.peak}\n`);
    }
  }

  const firedAt = Date.now();
  process.stderr.write(`\nAll fired in ${((firedAt - startAt) / 1000).toFixed(1)}s. Awaiting completion…\n`);
  const results = await Promise.all(promises);
  const finishedAt = Date.now();

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const byRegion = {};
  for (const r of ok) byRegion[r.region] = (byRegion[r.region] ?? 0) + 1;

  // Count how many ok requests needed fallback (region != "global")
  const firstTry = ok.filter((r) => r.attemptLog[0] === "global#0:ok").length;
  const afterRetryOrFallback = ok.length - firstTry;

  // Count total attempts across all requests to measure DSQ pressure
  const totalAttempts = results.reduce((s, r) => s + r.attemptLog.length, 0);

  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  const mean = latencies.length ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length) : 0;

  const wallSec = ((finishedAt - startAt) / 1000).toFixed(1);
  const actualRps = (targetTotal / ((firedAt - startAt) / 1000)).toFixed(2);
  const errRate = ((failed.length / targetTotal) * 100).toFixed(2);

  console.log(`\n=== Results ===`);
  console.log(`Wall time:               ${wallSec}s`);
  console.log(`Actual send rate:        ${actualRps} rps`);
  console.log(`Peak concurrency:        ${counter.peak}`);
  console.log(`Total requests:          ${targetTotal}`);
  console.log(`Success:                 ${ok.length}  (${((ok.length / targetTotal) * 100).toFixed(2)}%)`);
  console.log(`Failed (final):          ${failed.length}  (${errRate}%)`);
  console.log(`\nDSQ absorption:`);
  console.log(`  Succeeded first try:   ${firstTry}  (${((firstTry / targetTotal) * 100).toFixed(1)}%)`);
  console.log(`  Succeeded via retry/fallback: ${afterRetryOrFallback}  (${((afterRetryOrFallback / targetTotal) * 100).toFixed(1)}%)`);
  console.log(`  Total upstream attempts: ${totalAttempts}  (avg ${(totalAttempts / targetTotal).toFixed(2)} per request)`);
  console.log(`\nLatency (successful only):`);
  console.log(`  mean=${mean}ms  p50=${pct(0.5)}ms  p95=${pct(0.95)}ms  p99=${pct(0.99)}ms`);
  console.log(`\nSuccess by region:`);
  for (const [r, n] of Object.entries(byRegion).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(14)} ${n}  (${((n / ok.length) * 100).toFixed(1)}%)`);
  }
  if (failed.length > 0) {
    console.log(`\nFinal error samples (first 3):`);
    for (const r of failed.slice(0, 3)) {
      console.log(`  status=${r.status}  attempts=${r.attemptLog.join(",")}`);
    }
  }
  console.log(`\nComparison with baseline: today you see ~3% error rate.`);
  console.log(`With retry+fallback: ${errRate}% error rate.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
