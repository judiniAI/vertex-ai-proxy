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
