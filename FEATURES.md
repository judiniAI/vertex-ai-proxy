# Features

## OpenAI-Compatible API

Drop-in replacement for the OpenAI API format. Any client that speaks OpenAI can use this gateway to reach Google Vertex AI models.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List available models |
| POST | `/v1/chat/completions` | Chat completions (streaming and non-streaming) |
| GET | `/health` | Health check |

## Supported Models

| Model | Tier | Thinking |
|-------|------|----------|
| `gemini-3.1-pro-preview` | Preview | thinkingLevel (min: `low`) |
| `gemini-3.1-flash-lite-preview` | Preview | thinkingLevel (min: `minimal`) |
| `gemini-3-flash-preview` | Preview | thinkingLevel (min: `minimal`) |
| `gemini-2.5-pro` | Stable | thinkingBudget (min: `128`, cannot disable) |
| `gemini-2.5-flash` | Stable | thinkingBudget (min: `0`, can disable) |
| `gemini-2.5-flash-lite` | Stable | thinkingBudget (`0` to disable, min `512` when on) |

## Dynamic Region Routing

The gateway resolves the Vertex AI region per request with the following priority:

1. **`x-vertex-region` header** — client overrides the region per request
2. **`VERTEX_REGION` env var** — global default from configuration
3. **Model-based fallback:**
   - `gemini-2.5-*` → `us-east1`
   - `gemini-3*` → `global`
   - All others → `global`

```bash
# Override region per request
curl -H "x-vertex-region: us-central1" ...
```

## Retry + Multi-Region Fallback (Gemini DSQ)

Gemini 2.5 and 3.x on Vertex AI are served through **Dynamic Shared Quota (DSQ)**, a pool that can return `429 RESOURCE_EXHAUSTED` under load even when no project-visible quota is exceeded. Google explicitly recommends exponential backoff and cross-region fallback as the mitigation. The gateway implements both transparently for any Gemini call.

### Behavior

- **Retries within a region** on `408`, `429`, `500`, `502`, `503`, `504`, and network errors. Up to 2 attempts per region with full-jitter exponential backoff capped at 2s.
- **Falls back across regions** when a region stays exhausted, in this order ranked by empirical DSQ headroom (average error rate across burst 30 / 100 / 600 stress runs):
  ```
  global → us-east5 → us-south1 → us-west4 → us-east1 → us-east4 → us-west1 → us-central1
  ```
- **Honors `google.rpc.RetryInfo.retryDelay`** parsed from the error body (Vertex does not set an HTTP `Retry-After` header). Short delays are observed; when the server asks for more than 5 s the region is skipped entirely.
- **Wall-clock budget** of 25 s bounds the entire chain so interactive calls cannot stall indefinitely.
- **Streaming-safe**: retry only happens before the first byte of the response body is forwarded. Once a stream starts, errors surface to the client.
- **Non-retryable errors** (4xx other than 408/429) are propagated immediately with their real upstream status, not masked as 502.
- **Respects explicit region pinning**: when `x-vertex-region` is set by the caller, fallback is disabled so the caller gets the region they asked for.

### Opting out

Pass `x-vertex-region` on the request to disable cross-region fallback. The gateway will still retry within that single region but will not route anywhere else.

```bash
# Pin to us-central1 with no fallback
curl -H "x-vertex-region: us-central1" ...
```

### Observability

The gateway is opaque to clients: responses do not expose which region served them. For operators, every Gemini request emits a structured log line via `console.log` with the model, final region, attempt count, and full fallback trail, visible via `wrangler tail` or Cloudflare Logpush.

### Scope

Applies to Gemini and Gemma models only. Non-Google models (Claude, Llama, Mistral, etc.) use Vertex's OpenAPI-compat endpoint, which is not uniformly available across regions, and keep the single-shot path.

## Reasoning Effort (Thinking Control)

Maps the OpenAI `reasoning_effort` parameter to Vertex AI thinking configuration, respecting per-model limits.

### Gemini 2.5 (thinkingBudget)

| reasoning_effort | Flash | Pro | Flash-Lite |
|------------------|-------|-----|------------|
| `none` | 0 | 128 | 0 |
| `minimal` | 128 | 128 | 512 |
| `low` | 1024 | 1024 | 1024 |
| `medium` | 8192 | 8192 | 8192 |
| `high` | -1 (dynamic) | -1 (dynamic) | -1 (dynamic) |

### Gemini 3.x (thinkingLevel)

| reasoning_effort | Flash / Flash-Lite | Pro |
|------------------|--------------------|-----|
| `none` | minimal | low |
| `minimal` | minimal | low |
| `low` | low | low |
| `medium` | medium | medium |
| `high` | high | high |

## Streaming

Supports both streaming (`"stream": true`) and non-streaming responses. Gemini native streaming is converted to OpenAI SSE format. Non-Google models use passthrough streaming.

## Tool Calling (Function Calling)

Full support for OpenAI-format tool calling, converted to Vertex AI function calling:

- `tool_choice`: `auto`, `none`, `required`, or specific function
- Tool call responses are mapped back to OpenAI format with generated call IDs

## Authentication

Clients authenticate with `Authorization: Bearer <API_KEY>`. The gateway authenticates to Vertex AI using a GCP service account JSON key.

## CORS

All endpoints return `Access-Control-Allow-Origin: *` headers. Preflight `OPTIONS` requests are handled automatically.

## Deployment Targets

- **Cloudflare Workers** — primary target via Wrangler
- **Google Cloud Run** — alternative with Docker support
