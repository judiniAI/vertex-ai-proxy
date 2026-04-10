#!/usr/bin/env node
/**
 * Probes Vertex AI region availability for a given Gemini model.
 *
 * Usage:
 *   node scripts/check-region-availability.mjs [model] [--json]
 *
 * Defaults:
 *   model = gemini-2.5-flash
 *
 * Reads VERTEX_PROJECT_ID and VERTEX_SERVICE_ACCOUNT_JSON from .dev.vars
 * (same source the gateway uses). Output: per-region HTTP status, latency,
 * and a short reason. Exit code is 0 even if some regions fail — the
 * report is the deliverable.
 */

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Americas regions where gemini-2.5-flash is confirmed available,
// plus the global multi-region endpoint.
const REGIONS = [
  "global",
  // US
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west4",
  // Canada
  "northamerica-northeast1",
  // South America
  "southamerica-east1",
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
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
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
  const data = await res.json();
  return data.access_token;
}

async function probeRegion({ region, projectId, model, token }) {
  const host =
    region === "global"
      ? "aiplatform.googleapis.com"
      : `${region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "ping" }] }],
    generationConfig: { maxOutputTokens: 1 },
  });

  const started = Date.now();
  let status = 0;
  let detail = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    status = res.status;
    if (!res.ok) {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message?.slice(0, 140) ?? text.slice(0, 140);
      } catch {
        detail = text.slice(0, 140);
      }
    } else {
      detail = "ok";
    }
  } catch (err) {
    detail = `network: ${err.message}`;
  }
  const latencyMs = Date.now() - started;

  let verdict;
  if (status === 200) verdict = "AVAILABLE";
  else if (status === 404) verdict = "NOT_SUPPORTED";
  else if (status === 403) verdict = "FORBIDDEN";
  else if (status === 429) verdict = "QUOTA_EXCEEDED";
  else verdict = "ERROR";

  return { region, status, verdict, latencyMs, detail };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const model = args.find((a) => !a.startsWith("--")) ?? "gemini-2.5-flash";

  const envPath = resolve(repoRoot, ".dev.vars");
  const env = parseDevVars(envPath);
  const projectId = env.VERTEX_PROJECT_ID;
  const saJson = env.VERTEX_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) {
    console.error("Missing VERTEX_PROJECT_ID or VERTEX_SERVICE_ACCOUNT_JSON in .dev.vars");
    process.exit(1);
  }

  if (!jsonOutput) {
    console.error(`Probing model "${model}" across ${REGIONS.length} regions for project ${projectId}…\n`);
  }

  const token = await getAccessToken(saJson);

  const results = await Promise.all(
    REGIONS.map((region) => probeRegion({ region, projectId, model, token }))
  );

  results.sort((a, b) => a.region.localeCompare(b.region));

  if (jsonOutput) {
    console.log(JSON.stringify({ model, projectId, results }, null, 2));
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `${pad("REGION", 28)} ${pad("STATUS", 6)} ${pad("VERDICT", 16)} ${pad("LAT(ms)", 8)} DETAIL`
  );
  console.log("-".repeat(110));
  for (const r of results) {
    console.log(
      `${pad(r.region, 28)} ${pad(r.status, 6)} ${pad(r.verdict, 16)} ${pad(r.latencyMs, 8)} ${r.detail}`
    );
  }

  const counts = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\nSummary:", counts);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
