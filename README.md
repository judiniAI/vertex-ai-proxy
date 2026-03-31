# Vertex AI Gateway

Cloudflare Worker that converts OpenAI API format to Google Vertex AI. Use it as **Custom LLM** in ElevenLabs or any OpenAI-compatible client.

```
Your app ──(OpenAI format)──> Cloudflare Worker ──(Vertex format)──> Google Vertex AI
```

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Google Cloud project](https://console.cloud.google.com) with Vertex AI API enabled
- GCP service account JSON key with Vertex AI permissions

## Deploy

```bash
# 1. Install
npm install

# 2. Login to Cloudflare
npx wrangler login

# 3. Set secrets
echo 'YOUR_GCP_PROJECT_ID' | npx wrangler secret put VERTEX_PROJECT_ID
echo 'global' | npx wrangler secret put VERTEX_REGION
echo 'YOUR_SECRET_API_KEY' | npx wrangler secret put API_KEY

# For the service account, paste the full JSON key:
cat your-service-account.json | npx wrangler secret put VERTEX_SERVICE_ACCOUNT_JSON

# 4. Deploy
npm run deploy
```

Done. You'll get a URL like `https://vertex-ai-gateway.<your-subdomain>.workers.dev`.

## Local dev

```bash
cp .dev.vars.example .dev.vars  # fill in your values
npm run dev
```

## Environment variables

| Variable                      | What it is                                                 |
| ----------------------------- | ---------------------------------------------------------- |
| `VERTEX_PROJECT_ID`           | GCP project ID                                             |
| `VERTEX_REGION`               | `global`, `us-central1`, etc.                              |
| `VERTEX_SERVICE_ACCOUNT_JSON` | Full JSON key from GCP service account in one line         |
| `API_KEY`                     | Any string you choose. Clients send this as `Bearer` token |

## Use with ElevenLabs

Once deployed, connect your gateway to an ElevenLabs Conversational AI agent:

1. Open your agent in the [ElevenLabs dashboard](https://elevenlabs.io/app/conversational-ai)
2. In the agent settings, click the **LLM** dropdown on the right side
3. Scroll down and select **Custom LLM**
4. Fill in:
   - **Server URL**: `https://your-gateway.workers.dev/v1`
   - **Model ID**: `gemini-2.5-flash` (or any model from your Vertex project)
5. Under **API key**, click the dropdown and select **Create new secret**
   - Name: `OPENAI_API_KEY`
   - Value: your gateway's `API_KEY`
6. Close the modal and click **Publish**

> Docs: [elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm)

## Endpoints

**Chat completions**

```bash
curl https://your-gateway.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello"}]}'
```

**List models**

```bash
curl https://your-gateway.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Supports: `model`, `messages`, `temperature`, `max_tokens`, `top_p`, `stream`, `tools`, `tool_choice`.

## License

MIT
# cloudflare-vertex-ai-gateway
