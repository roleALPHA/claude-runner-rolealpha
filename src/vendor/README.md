# Vendored from n8n-nodes-rolealpha

These files are byte-identical copies of `lib/*.ts` in
[roleALPHA/n8n-nodes-rolealpha](https://github.com/roleALPHA/n8n-nodes-rolealpha)
at commit `1d78005` (2026-11-05):

| File | What the runner uses |
|---|---|
| `agentRun.ts` | account token, run token swap, refusal codes → reactions |
| `mcp.ts` | MCP client (reads the agent's context before Claude starts) |
| `agents.ts` | `getAgentContext` |
| `prompt.ts` | `buildSystemPrompt` from the context bundle |
| `graph.ts`, `share.ts` | types only (needed by `prompt.ts`) |

Do not edit them here. Change them upstream, then copy them again.
`npm run check-vendor` shows whether they still match upstream `main`.
The plan is to move them into one shared package that both runners depend on.
