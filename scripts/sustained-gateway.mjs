#!/usr/bin/env node
/**
 * Sustained-traffic simulation against the local gateway to reproduce
 * production load patterns. Unlike burst-gateway.mjs (fires N concurrently
 * in one shot), this fires requests at a target RPS over a duration window
 * with Poisson-like arrivals so concurrency peaks emerge naturally.
 *
 * Default models a real-world profile:
 *   600 requests over 60s  (10 RPS sustained)
 *   natural peak concurrency ~40-60 based on latency distribution
 *   measures final error rate AFTER gateway retry+fallback
 *
 * Usage:
 *   node scripts/sustained-gateway.mjs                    # 10 rps × 60s
 *   node scripts/sustained-gateway.mjs --rps 15 --duration 60
 *   node scripts/sustained-gateway.mjs --total 600 --duration 60
 *
 * The script observes peak concurrency live and prints it alongside the
 * standard success/error/latency/region breakdown.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8787";

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
  const out = { rps: null, duration: 60, total: 600, model: "gemini-2.5-flash" };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rps") out.rps = parseFloat(args[++i]);
    else if (args[i] === "--duration") out.duration = parseFloat(args[++i]);
    else if (args[i] === "--total") out.total = parseInt(args[++i], 10);
    else if (args[i] === "--model") out.model = args[++i];
  }
  // Derive rps from total/duration if not set explicitly
  if (out.rps == null) out.rps = out.total / out.duration;
  return out;
}

async function callOnce(apiKey, model, counter) {
  counter.inflight++;
  if (counter.inflight > counter.peak) counter.peak = counter.inflight;

  const t0 = Date.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply in exactly 4 words" }],
        max_tokens: 20,
        temperature: 0,
      }),
    });
    const latencyMs = Date.now() - t0;
    const regionUsed = res.headers.get("x-vertex-region-used") ?? "?";
    let errMsg = "";
    if (!res.ok) {
      try {
        const j = await res.json();
        errMsg = (j?.error?.message ?? "").slice(0, 120);
      } catch {
        errMsg = "<unparseable>";
      }
    } else {
      await res.json().catch(() => null);
    }
    return { status: res.status, latencyMs, regionUsed, errMsg };
  } catch (err) {
    return {
      status: 0,
      latencyMs: Date.now() - t0,
      regionUsed: "?",
      errMsg: err.message,
    };
  } finally {
    counter.inflight--;
  }
}

async function main() {
  const { rps, duration, total, model } = parseArgs();
  const env = parseDevVars(resolve(repoRoot, ".dev.vars"));
  const apiKey = env.API_KEY;
  if (!apiKey) {
    console.error("API_KEY not found in .dev.vars");
    process.exit(1);
  }

  const targetTotal = total || Math.round(rps * duration);
  const intervalMs = 1000 / rps;

  console.error(`Sustained test vs ${GATEWAY_URL}`);
  console.error(`  model=${model}  rps=${rps.toFixed(2)}  duration=${duration}s  total=${targetTotal}`);
  console.error(`  arrival interval=${intervalMs.toFixed(0)}ms (Poisson-jittered)`);
  console.error(`  expected peak concurrency depends on response latency\n`);

  const counter = { inflight: 0, peak: 0 };
  const promises = [];
  const startAt = Date.now();

  for (let i = 0; i < targetTotal; i++) {
    // Poisson-ish: exponential interarrival with mean = intervalMs
    const jitter = -Math.log(1 - Math.random()) * intervalMs;
    const targetAt = startAt + i * intervalMs + (jitter - intervalMs) * 0.3;
    const waitMs = Math.max(0, targetAt - Date.now());
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    // Fire without awaiting — concurrency builds naturally
    promises.push(callOnce(apiKey, model, counter));

    // Progress every 10%
    if ((i + 1) % Math.max(1, Math.round(targetTotal / 10)) === 0) {
      const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
      process.stderr.write(
        `  fired ${i + 1}/${targetTotal} at ${elapsed}s  inflight=${counter.inflight}  peak=${counter.peak}\n`
      );
    }
  }

  const firedAt = Date.now();
  process.stderr.write(`\nAll ${targetTotal} fired in ${((firedAt - startAt) / 1000).toFixed(1)}s. Awaiting completion…\n`);

  const results = await Promise.all(promises);
  const finishedAt = Date.now();

  const ok = results.filter((r) => r.status === 200);
  const r429 = results.filter((r) => r.status === 429);
  const other = results.filter((r) => r.status !== 200 && r.status !== 429);

  const byRegion = results.reduce((acc, r) => {
    if (r.status === 200) acc[r.regionUsed] = (acc[r.regionUsed] ?? 0) + 1;
    return acc;
  }, {});

  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  const mean = latencies.length ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length) : 0;

  const wallSec = ((finishedAt - startAt) / 1000).toFixed(1);
  const actualRps = (targetTotal / ((firedAt - startAt) / 1000)).toFixed(2);

  console.log(`\n=== Results ===`);
  console.log(`Wall time:          ${wallSec}s`);
  console.log(`Actual send rate:   ${actualRps} rps`);
  console.log(`Peak concurrency:   ${counter.peak}`);
  console.log(`Sent:               ${targetTotal}`);
  console.log(`Success (200):      ${ok.length}  (${((ok.length / targetTotal) * 100).toFixed(1)}%)`);
  console.log(`Rate-limited (429): ${r429.length}  (${((r429.length / targetTotal) * 100).toFixed(1)}%)`);
  console.log(`Other errors:       ${other.length}  (${((other.length / targetTotal) * 100).toFixed(1)}%)`);
  console.log(`\nLatency (successful only):`);
  console.log(`  mean=${mean}ms  p50=${pct(0.5)}ms  p95=${pct(0.95)}ms  p99=${pct(0.99)}ms`);
  console.log(`\nSuccess by region:`);
  for (const [r, n] of Object.entries(byRegion).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(14)} ${n}  (${((n / ok.length) * 100).toFixed(1)}%)`);
  }
  if (r429.length > 0) {
    console.log(`\n429 samples (first 3):`);
    for (const r of r429.slice(0, 3)) console.log(`  ${r.errMsg}`);
  }
  if (other.length > 0) {
    console.log(`\nOther error samples (first 3):`);
    for (const r of other.slice(0, 3)) console.log(`  status=${r.status}  ${r.errMsg}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
