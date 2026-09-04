# OpenCode Go — API contract (verified 2026-09-03 with live calls)

Base URL: `https://opencode.ai/zen/go/v1`  (docs: https://opencode.ai/docs/go/)
Auth: `Authorization: Bearer <key>` — keys start with `sk-` (67 chars observed).
Recommended headers: `x-opencode-session: <stable id per conversation>` (prompt caching), a specific `User-Agent` (e.g. `agents-pool/<version>`; docs ask tools to identify themselves).

## Endpoints
- `GET /models` → `{"object":"list","data":[{"id":"glm-5.3-flash","object":"model",...}]}`
  **Does NOT validate the key** (returns the list even with a bad key). Use only to populate model choices.
  Observed ids (34): minimax-m3, minimax-m2.7, minimax-m2.5, kimi-k3, kimi-k2.7-code, kimi-k2.6, longcat-2.0, kimi-k2.5,
  glm-5.2, glm-5.3-flash, glm-5.3, glm-5.1, glm-5, deepseek-v4-pro, deepseek-v4-flash, deepseek-v4-flash-vision-exp,
  qwen3.7-max, qwen3.8-max, qwen3.8-flash, qwen3.7-plus, qwen3.6-plus, qwen3.5-plus, mimo-v2-pro, mimo-v2-omni,
  mimo-v2.5-pro, mimo-v2.5, hy4-preview, hy3, hy3-preview, gpt-5.6-luna, grok-4.5, grok-4.6, muse-spark-1.3-contributor, muse-spark-1.2-contributor
  Cheapest: glm-5.3-flash ($0.075/M in) — use it for the key-validation probe. Richer metadata (name, cost, context limit) available from https://models.dev/api.json under provider `opencode-go` (fetch optional, fall back to raw ids).
- `POST /chat/completions` — OpenAI-compatible, supports `stream:true`, `tools` (function calling), `tool_choice`, `max_tokens`.
  - Bad/missing key with a supported model → HTTP 401 `{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}`
  - Unsupported model (any key) → HTTP 401 `{"type":"error","error":{"type":"ModelError","message":"Model X is not supported"}}`  ← note: 401, not 400. Distinguish by `error.type`.
  - Key validation = `POST /chat/completions {"model":"glm-5.3-flash","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}` → 200 means valid (usage.cost was "0").
  - Non-stream response: `choices[0].message.{role,content,reasoning_content,tool_calls}`, `usage.{prompt_tokens,completion_tokens,total_tokens,prompt_tokens_details.cached_tokens,completion_tokens_details.reasoning_tokens}`, top-level `cost` (string).
  - Streaming (SSE `data: {...}` lines, terminated by `data: [DONE]`): `choices[0].delta.reasoning_content` (model thinking, streamed token by token), `choices[0].delta.content`, `choices[0].delta.tool_calls[{index,id,type,function:{name,arguments}}]` (standard OpenAI incremental shape), `finish_reason` on last chunk. Also handle a possible `delta.reasoning` field defensively (other gateways use it).
  - When sending back an assistant message that had reasoning, include `reasoning_content` in the assistant message (some models — GLM/Kimi/MiniMax/DeepSeek — want it echoed for multi-turn tool calling; harmless otherwise).
- `POST /messages` (Anthropic format) and `POST /responses` also exist — not needed.

## Plan limits (from docs)
$10/month subscription: 5-hour rolling limit ≈ $12 of usage, weekly ≈ $30, monthly ≈ $60. Rate limit errors should be surfaced clearly (expect HTTP 429). Optional "use balance" fallback to Zen credits.

## Environment
- macOS host (Darwin 25.6, arm64 assumed), Node 24.11, npm 11.6, rustc/cargo/docker present, no wine.
- Electron latest 44.1.1, electron-builder 26.15.3.
- User already has the `opencode` CLI (1.18.25) with an `opencode-go` key in ~/.local/share/opencode/auth.json — the app must NOT read it silently; it asks for the key at first launch (may offer an "import from opencode" button as convenience).
- User's own opencode config shows preferences: cheap/high-quota default models (deepseek-v4-flash for high volume), kimi-k3 / grok-4.5 as scarce escalation. Sensible default model for new agents: `deepseek-v4-flash` or `glm-5.3-flash`.
