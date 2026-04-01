# Vertex AI Gateway

OpenAI-compatible proxy for Google Vertex AI. Deploy to **Cloudflare Workers** or **Google Cloud Run**. Use it as **Custom LLM** in ElevenLabs or any OpenAI-compatible client.

```
Your app ──(OpenAI format)──> Gateway ──(Vertex format)──> Google Vertex AI
```

## Prerequisites

- [Google Cloud project](https://console.cloud.google.com) with Vertex AI API enabled
- GCP service account JSON key with Vertex AI permissions
- **For Cloudflare**: [Cloudflare account](https://dash.cloudflare.com/sign-up)
- **For Cloud Run**: [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated

## Deploy to Cloudflare Workers

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

## Deploy to Google Cloud Run

### Prerequisites

1. [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed
2. A GCP project with the following APIs enabled (they will be enabled automatically on first deploy):
   - Cloud Run API
   - Cloud Build API
   - Artifact Registry API
3. The default Compute Engine service account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) needs these roles:
   - **Storage Admin** (`roles/storage.admin`)
   - **Cloud Build Service Account** (`roles/cloudbuild.builds.builder`)

   You can grant them with:
   ```bash
   gcloud projects add-iam-policy-binding YOUR_GCP_PROJECT_ID \
     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
     --role="roles/storage.admin"

   gcloud projects add-iam-policy-binding YOUR_GCP_PROJECT_ID \
     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
     --role="roles/cloudbuild.builds.builder"
   ```

### Deploy

```bash
# 1. Login and set project
gcloud auth login
gcloud config set project YOUR_GCP_PROJECT_ID

# 2. Create an env.yaml file with your environment variables
cat > env.yaml <<'EOF'
VERTEX_PROJECT_ID: "your-vertex-project-id"
VERTEX_REGION: "us-central1"
API_KEY: "sk_your-uuid-here"
VERTEX_SERVICE_ACCOUNT_JSON: |
  {"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
EOF

# 3. Deploy (builds with Dockerfile automatically)
gcloud run deploy vertex-ai-gateway \
  --source . \
  --region us-central1 \
  --env-vars-file env.yaml \
  --allow-unauthenticated

# 4. Clean up the env file (contains secrets)
rm env.yaml
```

Done. You'll get a URL like `https://vertex-ai-gateway-XXXXXX.us-central1.run.app`.

> **Note**: The `--env-vars-file` approach is recommended because the service account JSON contains special characters that break `--set-env-vars`. For production, use [Secret Manager](https://cloud.google.com/run/docs/configuring/services/secrets) instead for sensitive values.

## Local dev

**With Wrangler (Cloudflare runtime):**

```bash
cp .dev.vars.example .dev.vars  # fill in your values
npm run dev
```

**With Node.js:**

```bash
export VERTEX_PROJECT_ID=your-project-id
export VERTEX_REGION=global
export VERTEX_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
export API_KEY=your-api-key
npm run build:cloudrun && npm start
```

## Environment variables

| Variable                      | What it is                                                 |
| ----------------------------- | ---------------------------------------------------------- |
| `VERTEX_PROJECT_ID`           | GCP project ID                                             |
| `VERTEX_REGION`               | `global`, `us-central1`, etc.                              |
| `VERTEX_SERVICE_ACCOUNT_JSON` | Full JSON key from GCP service account in one line         |
| `API_KEY`                     | Must follow OpenAI key format: `sk_<uuid>` (e.g. `sk_58aadc9c-b687-41ea-8d20-e6eccd58c0de`). Clients send this as `Bearer` token |

## Use with ElevenLabs

Once deployed, connect your gateway to an ElevenLabs Conversational AI agent:

1. Open your agent in the [ElevenLabs dashboard](https://elevenlabs.io/app/conversational-ai)
2. In the agent settings, click the **LLM** dropdown on the right side
3. Scroll down and select **Custom LLM**
4. Fill in:
   - **Server URL**: `https://your-gateway-url/v1` (your Workers or Cloud Run URL)
   - **Model ID**: `gemini-2.5-flash` (or any model from your Vertex project)
5. Under **API key**, click the dropdown and select **Create new secret**
   - Name: `OPENAI_API_KEY`
   - Value: your gateway's `API_KEY`
6. Close the modal and click **Publish**

> Docs: [elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm)

## Available Models

| Model | Tier |
| ----- | ---- |
| `gemini-3.1-pro-preview` | Preview |
| `gemini-3.1-flash-lite-preview` | Preview |
| `gemini-2.5-pro` | Stable |
| `gemini-2.5-flash` | Stable |
| `gemini-2.5-flash-lite` | Stable |

> Models are fetched dynamically from Vertex AI. The list above reflects currently available models via the `/v1/models` endpoint.

## Endpoints

**Chat completions**

```bash
curl https://your-gateway-url/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hello"}]}'
```

**List models**

```bash
curl https://your-gateway-url/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## License

MIT
