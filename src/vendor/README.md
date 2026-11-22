# Vendored from n8n-nodes-rolealpha

These files are byte-identical copies of `lib/*.ts` in
[roleALPHA/n8n-nodes-rolealpha](https://github.com/roleALPHA/n8n-nodes-rolealpha)
at commit `9085cc7` (2026-11-22, Report Usage, 0.12.0):

| File | What the runner uses |
|---|---|
| `agentRun.ts` | account token, run token swap, usage report, refusal codes → reactions |
| `mcp.ts` | MCP client (reads the agent's context before Claude starts) |
| `agents.ts` | `getAgentContext` |
| `prompt.ts` | `buildSystemPrompt` from the context bundle |
| `graph.ts`, `share.ts` | types only (needed by `prompt.ts`) |
| `pricing.ts` | the cost of a run from `RUNNER_PRICES` |
| `memory.ts`, `knowledge.ts`, `waits.ts` | needed by `prompt.ts` (memory and knowledge of roles); the runner passes neither |

Do not edit them here. Change them upstream, then copy them again.
`npm run check-vendor` shows whether they still match upstream `main`.
The plan is to move them into one shared package that both runners depend on.
