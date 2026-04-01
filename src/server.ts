import { createServer } from "node:http";
import { Env } from "./types";
import { handleRequest } from "./handler";

const PORT = parseInt(process.env.PORT || "8080", 10);

function getEnv(): Env {
  const required = ["VERTEX_PROJECT_ID", "VERTEX_REGION", "VERTEX_SERVICE_ACCOUNT_JSON", "API_KEY"] as const;
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing required environment variable: ${key}`);
      process.exit(1);
    }
  }
  return {
    VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID!,
    VERTEX_REGION: process.env.VERTEX_REGION!,
    VERTEX_SERVICE_ACCOUNT_JSON: process.env.VERTEX_SERVICE_ACCOUNT_JSON!,
    API_KEY: process.env.API_KEY!,
  };
}

const env = getEnv();

const server = createServer(async (req, res) => {
  const url = `http://localhost:${PORT}${req.url || "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  // Read request body for non-GET methods
  let body: Buffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  const request = new Request(url, {
    method: req.method || "GET",
    headers,
    body,
  });

  const response = await handleRequest(request, env);

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

  if (response.body) {
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(value);
      }
    };
    await pump();
  } else {
    res.end(await response.text());
  }
});

server.listen(PORT, () => {
  console.log(`vertex-ai-gateway listening on port ${PORT}`);
});
