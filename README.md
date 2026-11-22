# @rolealpha/claude-runner-rolealpha

**Run roleALPHA agents with Claude.** The agent's purpose, instructions, roles and guardrails
come from roleALPHA at run time, every time. Claude sees exactly what the agent may see, and
everything it writes is a draft that a person approves.

This is the Claude counterpart of [`@rolealpha/n8n-nodes-rolealpha`](https://github.com/roleALPHA/n8n-nodes-rolealpha):
the same roleALPHA contract (`agent:run`), the same token handling, without n8n. It uses the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) and runs on your own machine,
server or CI. **roleALPHA does not run agents**: this runner does, and you operate it.

> **Status: 0.1, early.** Tested against fakes of roleALPHA and the SDK, not yet in production.
> See [Limits](#limits) before you rely on it.

## How a run works

```
runner                                      roleALPHA
  1. client_credentials (id + secret)  ──▶  account token (60 min, cached)
  2. token exchange (agent, run ID)    ──▶  checks right, binding, status, budget
                                       ◀──  run token (15 min) | refusal code
  3. get_agent_context                 ──▶  purpose, instructions, roles, guardrails
  4. Claude works over /api/mcp        ──▶  agent's view; writing = drafts
  5. every 12 min: report usage, swap  ──▶  status and budget checked again
  6. at the end: report the run's usage ──▶  counts for the agent's budget
```

1. The runner fetches an **account token** for its service account.
2. It swaps it for a **run token** for one agent. If roleALPHA refuses (agent paused, budget
   spent, not bound …), Claude never starts and the runner exits with a code that says what
   to do (see [Exit codes](#exit-codes)).
3. It reads the agent's **context bundle** and builds the system prompt from it: identity,
   rules, binding guardrails, roles. Guardrails are in the prompt before Claude's first turn,
   not left to Claude to look up.
4. **Claude runs** with roleALPHA as its only tool source.
5. Runs longer than 15 minutes swap the token again with the same run ID. If roleALPHA
   refuses now (the agent was retired, unbound or ran out of budget), the run stops.
6. The runner **reports the run's usage** to roleALPHA (tokens, model, cost) with the service
   account — before every swap and at the end. Each report replaces the previous one for the
   run. Once the agent's budget for the period is spent, the next run is refused.

## What Claude can and cannot do in a run

| | |
|---|---|
| **Tools** | Only the roleALPHA tools the run token allows. No shell, no files, no web (`tools: []`). Anything else is denied without asking (`permissionMode: "dontAsk"`). |
| **Host settings** | None. `settingSources: []` and `strictMcpConfig: true`: no `CLAUDE.md`, no `.mcp.json`, no user settings of the machine leak into the run. |
| **Visibility** | The agent's, never more. No admin bypass, even if the service account has admin roles. |
| **Writing** | Drafts only. A run cannot approve, administer or vote. |
| **Audit** | roleALPHA records "agent (account)" and the run ID on every change. |
| **Cost** | Capped per run (`RUNNER_MAX_BUDGET_USD`, default 2 USD) and in turns (`RUNNER_MAX_TURNS`, default 40). Reported to roleALPHA for the agent's budget per period. |

## Setting it up

### 1. In roleALPHA (once, as tenant admin)

1. **Settings → AI → External applications**: switch on *Allow external applications*.
2. Card **Service accounts**: create one. Give it a **name** ("Claude runner"), what it
   **acts for** and a **role**.
3. Give that role the permission **Run AI agents** (`agent:run`).
4. In the account's dialog under **May run these agents**, pick the agents, or tick
   **All agents of this organisation, including future ones**.
5. Set each agent to **Active**. Optional: a **budget per period** on the agent page.
6. Copy the four values roleALPHA shows **once** after saving: client ID, client secret,
   token URL and MCP URL. Only a fingerprint of the secret is stored.

### 2. Where the runner runs

Requirements: **Node.js 22.12 or later** and access to Claude through an **API key**: an
Anthropic API key from the [Claude Console](https://console.anthropic.com), or Claude on
Amazon Bedrock, Google Vertex AI or Microsoft Foundry (see the SDK docs).

#### Why an API key and not a Claude subscription

The runner works unattended, on a server or a schedule, for an organisation. Anthropic's
terms put that on API keys:

- The Agent SDK docs: unless previously approved, third-party products built on the SDK may
  not offer claude.ai login or subscription rate limits; use API key authentication
  ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
  [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- The Consumer Terms allow access "through automated or non-human means" only via an API
  key or where Anthropic explicitly permits it
  ([Consumer Terms](https://www.anthropic.com/legal/consumer-terms)).

Technically the SDK would also pick up a subscription login (`claude setup-token`,
`CLAUDE_CODE_OAUTH_TOKEN`). This runner does not support that, and roleALPHA never asks for,
stores or forwards Claude credentials. Check the linked pages yourself: terms change, and
this is not legal advice.

```bash
npm install -g @rolealpha/claude-runner-rolealpha
```

Or from source:

```bash
git clone https://github.com/roleALPHA/claude-runner-rolealpha.git
cd claude-runner-rolealpha
npm ci
npm run build
```

### 3. Configuration

All configuration is in environment variables. Keep them in a secret store or an env file
with `chmod 600`, never in the repository.

| Variable | Required | Meaning |
|---|---|---|
| `ROLEALPHA_TOKEN_URL` | yes | Token URL of the service account, e.g. `https://app.rolealpha.app/api/auth/oauth/token` |
| `ROLEALPHA_MCP_URL` | yes | MCP URL, e.g. `https://app.rolealpha.app/api/mcp`. Use the login domain roleALPHA shows, not a custom domain. |
| `ROLEALPHA_CLIENT_ID` | yes | Client ID of the service account |
| `ROLEALPHA_CLIENT_SECRET` | yes | Client secret of the service account |
| `ROLEALPHA_ORGANISATION` | yes | Name or ID of your organisation in roleALPHA |
| `ROLEALPHA_CLIENT_AUTH` | no | `header` (default, HTTP Basic) or `body` |
| `ANTHROPIC_API_KEY` | yes* | *or the variables for Bedrock, Vertex AI or Foundry; not a subscription token |
| `CLAUDE_MODEL` | no | Default `claude-opus-5-5` |
| `RUNNER_MAX_TURNS` | no | Default `40` |
| `RUNNER_MAX_BUDGET_USD` | no | Hard cost cap per run, default `2` |
| `RUNNER_PRICES` | no | Your prices per million tokens, as JSON or a path to a JSON file (see [Cost and budget](#cost-and-budget)). Without it the SDK's list price is reported. |

Example `/etc/claude-runner-rolealpha.env`:

```bash
ROLEALPHA_TOKEN_URL=https://app.rolealpha.app/api/auth/oauth/token
ROLEALPHA_MCP_URL=https://app.rolealpha.app/api/mcp
ROLEALPHA_CLIENT_ID=…
ROLEALPHA_CLIENT_SECRET=…
ROLEALPHA_ORGANISATION=Example Ltd
ANTHROPIC_API_KEY=sk-ant-…
```

## Running it

```bash
claude-runner-rolealpha <agent-uuid> "<task>" [--run-id <id>]
```

```bash
set -a; . /etc/claude-runner-rolealpha.env; set +a
claude-runner-rolealpha 3f6c…-…-9a1e "Check which open roles in Sales have no holder and propose one draft per gap."
```

The agent UUID is on the agent's page in roleALPHA. The run ID defaults to
`claude-<uuid>`. Pass your own (1–128 characters of `A-Z a-z 0-9 . _ : -`, unique per run)
to find a run in roleALPHA's change history, e.g. the ID of a CI job.

The result goes to stdout as JSON:

```json
{
  "runId": "claude-0b1e…",
  "agent": { "uuid": "3f6c…", "name": "Recruiting assistant" },
  "status": "done",
  "text": "I proposed two drafts …",
  "costUsd": 0.41,
  "numTurns": 9,
  "usageReported": true
}
```

`usageReported: false` with `usageError` (a roleALPHA code such as `planung_nicht_lizenziert`)
means roleALPHA did not take the usage report. The run itself is not affected.

### Cost and budget

roleALPHA does not price runs: with your own Anthropic key (or Bedrock, Vertex AI, Foundry)
the price depends on your contract, and only you know it. So the runner calculates the cost
and reports it.

- With **`RUNNER_PRICES`** the run is priced from your table (reported as `price_kind: tabelle`):

  ```json
  { "currency": "USD", "asOf": "2026-11-20",
    "models": { "claude-opus-5-5": { "input": 4, "cacheRead": 0.4, "cacheWrite": 5, "output": 20 } } }
  ```

  Prices per million tokens; `input` is for uncached input tokens. A dated model name uses the
  row of its model (`claude-opus-5-5-20261101` → `claude-opus-5-5`).
- Without a table the runner reports the **SDK's list price** (`total_cost_usd`, marked
  `listenpreis`). roleALPHA counts it but shows that it is a list price, not your price.
- Only reports in the organisation's budget currency (USD by default, set in roleALPHA) count
  against the budget. A run without a price counts as "without a price", never as 0.

### Exit codes

The runner decides on roleALPHA's refusal **code**, never its text.

| Code | Meaning | What your scheduler should do |
|---|---|---|
| `0` | done | – |
| `1` | the run started but stopped (`reason`: e.g. `error_max_turns`, `error_max_budget_usd`, `agent_nicht_aktiv` during the run) | look at `reason` |
| `2` | wrong arguments | fix the call |
| `75` | try later: agent not active, budget of the period spent, roleALPHA unreachable | retry later; on a spent budget, in the next period |
| `78` | needs an admin: account deactivated, right missing, agent not bound or unknown, wrong client ID or secret | do not retry; fix it in roleALPHA |

### On a schedule

A run is one process, so any scheduler works. Example with systemd, every weekday at 07:00:

```ini
# /etc/systemd/system/rolealpha-recruiting.service
[Unit]
Description=roleALPHA agent: recruiting assistant

[Service]
Type=oneshot
EnvironmentFile=/etc/claude-runner-rolealpha.env
ExecStart=/usr/bin/claude-runner-rolealpha 3f6c…-…-9a1e "Daily check of open roles in Sales"
SuccessExitStatus=75
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
```

```ini
# /etc/systemd/system/rolealpha-recruiting.timer
[Timer]
OnCalendar=Mon..Fri 07:00
Persistent=true

[Install]
WantedBy=timers.target
```

`SuccessExitStatus=75` keeps a paused agent from showing up as a failed unit. It is not
an error, the agent is just not supposed to run now.

### As a library

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runAgent } from '@rolealpha/claude-runner-rolealpha';

const result = await runAgent(
  {
    account: { tokenUrl, clientId, clientSecret },
    mcpUrl,
    organisation: 'Example Ltd',
  },
  { agentUuid, task: 'Daily check of open roles in Sales', runId: `ci-${process.env.GITHUB_RUN_ID}` },
  { query },
);
```

`runAgent` throws `AgentRunError` (with `.code` and `.reaction`) when roleALPHA refuses the
run before it starts.

## Limits

- **The budget is checked at every token swap, not at every call.** A run that crosses the
  budget ends at its next swap (after 15 minutes at the latest). `RUNNER_MAX_BUDGET_USD` stays
  the hard cap per run.
- **Token swap mid-run is not tested against a live server yet.** Runs under 15 minutes never
  need it.
- **No steps or duties yet.** The n8n nodes can run an agent on one step of a value stream,
  with predecessors, deciders and the agent's share of a shared step. This runner takes a
  free-text task. The code for steps is already vendored (`src/vendor/graph.ts`, `share.ts`).
- **One agent per process.** Run several processes for several agents. They share no budget
  in roleALPHA's rate limiter: every run token has its own (120 calls per minute).

## Security

- The client secret and the run tokens stay in memory. Nothing is written to disk or stdout.
- A leaked run token is worth 15 minutes of one agent's view and draft rights, nothing more.
  Revoke the secret or deactivate the account in roleALPHA, and the next call fails.
- Claude gets no shell and no file access, so content from roleALPHA (a draft, a description)
  that tries to instruct it can at most make it propose drafts, which a person reviews.
- Run it as an unprivileged user (see the systemd example).

## Troubleshooting

| You see | Cause |
|---|---|
| exit 78, `invalid_client` | client ID or secret wrong, or the secret was revoked |
| exit 78, `unauthorized_client` | account deactivated, *External applications* off, or the agent/person it acts for was deleted |
| exit 78, `kein_agent_run_recht` | no role of the account has the permission *Run AI agents* |
| exit 78, `agent_nicht_gebunden` | the agent is not in *May run these agents* |
| exit 75, `agent_nicht_aktiv` | the agent is not *Active* (draft or retired) |
| exit 75, `installation_nicht_erreichbar` | the installation that holds your organisation's data is not answering; nothing is wrong with the account |
| every tool call fails with `falsche_resource` | `ROLEALPHA_MCP_URL` is not the login domain roleALPHA showed |

## Development

```bash
npm ci
npm test            # type check + node:test, no network, no Claude
npm run check-vendor  # are src/vendor/ files still identical to the n8n package?
```

`src/vendor/` holds byte-identical copies of the n8n package's token, MCP and prompt code
(see [`src/vendor/README.md`](src/vendor/README.md)). Change them there, not here.

### Releasing

Bump `version` in `package.json`, tag `v<version>` and push the tag. The workflow
`.github/workflows/publish.yml` builds, tests and publishes to npm with provenance. npm must
know this repository as a trusted publisher (package settings on npmjs.com) before the
first release.

## Licence

MIT, © roleALPHA GmbH. See [LICENSE](LICENSE).
