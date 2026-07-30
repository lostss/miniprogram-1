---
name: claude-api
description: Reference for Claude API / Anthropic SDK best practices — model IDs, pricing, parameters, streaming, tool use, MCP, Agents, caching, token counting, and model migration. Use when integrating or debugging Anthropic API calls.
license: Complete terms in LICENSE.txt
---

# Claude API Reference

Default model: **Claude Opus 4.8** (`claude-opus-4-8`) with adaptive thinking enabled and streaming by default.

## Model List

| Model | Model ID | Context | Input/1M | Output/1M |
|------|----------|--------|----------|-----------|
| Claude Fable 5 | `claude-fable-5` | 1M | $10.00 | $50.00 |
| Claude Mythos 5 | `claude-mythos-5` | 1M | $10.00 | $50.00 |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5.00 | $25.00 |
| Claude Opus 4.7 | `claude-opus-4-7` | 1M | $5.00 | $25.00 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | $3.00 | $15.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1.00 | $5.00 |

## Usage Decision Tree

- **Single LLM call** (classification/summary/extraction/Q&A) → Claude API
- **Multi-step workflow** → Claude API + tool use
- **Custom Agent** → Claude API + tool use
- **Server-hosted stateful Agent** → Managed Agents

## Key Pitfalls

- Do NOT truncate input content
- Do NOT use `budget_tokens` on Fable 5 / Opus 4.8/4.7 (use `effort` instead)
- Prefill removed in 4.6+
- Use `output_config: {format: {...}}` not deprecated `output_format`
- `max_tokens` defaults: non-streaming ~16000, streaming ~64000
- Always use SDK types, not custom types

## Streaming Best Practices

- Use streaming by default for better UX
- Handle `refusal` stop reason (Fable 5 safety classifier)
- Track `usage` for token accounting

## Tool Use

- Define tools with `name`, `description`, and `input_schema`
- Handle `tool_use` content blocks in responses
- Return `tool_result` blocks for each tool invocation
