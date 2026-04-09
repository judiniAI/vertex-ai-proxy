# Roadmap

## Pending

### Propagation of functionCall.id for Gemini 3.x
Gemini 3.x models return an `id` field on function calls that should be sent back in the corresponding `functionResponse`. Currently the gateway generates its own IDs via `crypto.randomUUID()` and discards any Gemini-provided ID. When 3.x models are used with tool calling in production, this may cause issues if Vertex expects its own ID back.

**Approach:** Store the Gemini `id` as a `_gemini_id` field in the OpenAI-format tool call, and restore it when converting back to Vertex format.

### Sanitization of NaN/Infinity values
Protobuf Struct (used by Vertex AI) does not support `NaN` or `Infinity` values. While `JSON.parse` never produces these, edge cases from non-standard clients could cause failures. A recursive `sanitizeJsonValues()` function would replace these with `null`.

**Priority:** Low — JSON.parse already prevents this in normal usage.
