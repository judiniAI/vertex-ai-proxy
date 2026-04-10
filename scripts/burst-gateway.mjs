#!/usr/bin/env node
/**
 * End-to-end burst test against the local gateway (wrangler dev) to verify
 * retry+fallback behavior. Fires N concurrent requests, reports per-request
 * status and X-Vertex-Region-Used header so we can see the fallback chain
 * absorbing DSQ 429s.
 *
 * Usage:
 *   node scripts/burst-gateway.mjs              # burst 30
 *   node scripts/burst-gateway.mjs --burst 80
 *   GATEWAY_URL=http://localhost:8787 node scripts/burst-gateway.mjs
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
  const out = { burst: 30 };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--burst") out.burst = parseInt(args[++i], 10);
  }
  return out;
}

async function callOnce(apiKey) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
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
        errMsg = (j?.error?.message ?? "").slice(0, 80);
      } catch {
        errMsg = "<unparseable>";
      }
    } else {
      await res.json().catch(() => null);
    }
    return { status: res.status, latencyMs, regionUsed, errMsg };
  } catch (err) {
    return { status: 0, latencyMs: Date.now() - t0, regionUsed: "?", errMsg: err.message };
  }
}

async function main() {
  const { burst } = parseArgs();
  const env = parseDevVars(resolve(repoRoot, ".dev.vars"));
  const apiKey = env.API_KEY;
  if (!apiKey) {
    console.error("API_KEY not found in .dev.vars");
    process.exit(1);
  }

  console.error(`Burst test vs ${GATEWAY_URL}  burst=${burst}  model=gemini-2.5-flash`);
  console.error("Firing concurrent requests…\n");

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: burst }, () => callOnce(apiKey)));
  const wallMs = Date.now() - t0;

  const ok = results.filter((r) => r.status === 200);
  const r429 = results.filter((r) => r.status === 429);
  const other = results.filter((r) => r.status !== 200 && r.status !== 429);

  const byRegion = results.reduce((acc, r) => {
    if (r.status === 200) acc[r.regionUsed] = (acc[r.regionUsed] ?? 0) + 1;
    return acc;
  }, {});

  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))] ?? 0;

  console.log(`\nResults: sent=${burst}  ok=${ok.length}  429=${r429.length}  other=${other.length}  wall=${wallMs}ms`);
  console.log(`Latency:  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms`);
  console.log(`Success by region: ${JSON.stringify(byRegion)}`);
  if (other.length > 0) {
    console.log(`\nOther errors (first 3):`);
    for (const r of other.slice(0, 3)) {
      console.log(`  status=${r.status}  ${r.errMsg}`);
    }
  }
  if (r429.length > 0) {
    console.log(`\n429 samples (first 3):`);
    for (const r of r429.slice(0, 3)) {
      console.log(`  ${r.errMsg}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
