import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { AgentRunError, runAgent, runOptions, type QueryFn, type RunnerConfig } from '../src/runner';
import type { FormPost } from '../src/vendor/agentRun';
import type { Transport } from '../src/vendor/mcp';

const AGENT = '3f6c2a10-1111-4222-8333-444455556666';

const cfg: RunnerConfig = {
	account: { tokenUrl: 'https://ra.test/api/auth/oauth/token', clientId: 'id', clientSecret: 'secret' },
	mcpUrl: 'https://ra.test/api/mcp',
	organisation: 'Example Ltd',
};

const bundle = {
	agent: { uuid: AGENT, name: 'Recruiting assistant', purpose: 'Keep roles staffed', instructions: 'Be brief.' },
	guardrails: [{ kind: 'policy', uuid: 'p1', name: 'No personal data in drafts', body: { description: 'Never copy salaries.' } }],
	context: [{ kind: 'role', uuid: 'r1', name: 'Recruiter', body: { purpose: 'Hire well' } }],
};

/** Fake token endpoint: a queue of exchange replies; client_credentials always works. */
function tokenServer(exchanges: Array<{ status: number; body: unknown }>, usageReply: { status: number; body: unknown } = { status: 200, body: { run_id: 'r', period_year: 2026, period: '2026-11', counted: true, budget_currency: 'USD' } }) {
	const calls: Array<{ form: Record<string, string>; headers: Record<string, string> }> = [];
	const usage: Array<{ url: string; form: Record<string, string>; headers: Record<string, string> }> = [];
	let n = 0;
	const post: FormPost = async (url, form, headers) => {
		if (!form.grant_type) {
			usage.push({ url, form, headers });
			return { status: usageReply.status, body: JSON.stringify(usageReply.body) };
		}
		calls.push({ form, headers });
		if (form.grant_type === 'client_credentials') return { status: 200, body: JSON.stringify({ access_token: 'account', expires_in: 3600 }) };
		const reply = exchanges[Math.min(n++, exchanges.length - 1)];
		return { status: reply.status, body: JSON.stringify(reply.body) };
	};
	return { post, calls, usage };
}

const runToken = (token: string) => ({ status: 200, body: { access_token: token, expires_in: 900, agent: { uuid: AGENT, name: 'Recruiting assistant' } } });

/** Fake MCP endpoint answering initialize and get_agent_context. */
function mcpServer() {
	const bearers: string[] = [];
	const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	const transport = (_url: string, bearer: string): Transport => async (body) => {
		bearers.push(bearer);
		const rpc = body as { id?: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
		const headers = { 'mcp-session-id': 's1' };
		if (rpc.method === 'notifications/initialized') return { status: 202, headers, body: '' };
		if (rpc.method === 'tools/call') {
			toolCalls.push(rpc.params);
			return { status: 200, headers, body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(bundle) }] } }) };
		}
		return { status: 200, headers, body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }) };
	};
	return { transport, bearers, toolCalls };
}

type Seen = { options?: Options; task?: unknown; servers: Array<Record<string, unknown>>; interrupted: boolean };

/** Fake SDK query: reads the task, waits `delayMs`, then yields one result message. */
function fakeQuery(result: Record<string, unknown>, delayMs = 0): { query: QueryFn; seen: Seen } {
	const seen: Seen = { servers: [], interrupted: false };
	const query: QueryFn = ({ prompt, options }) => {
		seen.options = options;
		async function* run() {
			const it = prompt[Symbol.asyncIterator]();
			const first = (await it.next()).value as SDKUserMessage;
			seen.task = first.message.content;
			await new Promise((r) => setTimeout(r, delayMs));
			if (!seen.interrupted) yield { type: 'result', ...result };
		}
		const gen = run();
		return Object.assign(gen, {
			setMcpServers: async (servers: Record<string, unknown>) => {
				seen.servers.push(servers);
				return { added: [], removed: [], errors: {} };
			},
			interrupt: async () => {
				seen.interrupted = true;
				return undefined;
			},
		}) as unknown as Query;
	};
	return { query, seen };
}

const success = { subtype: 'success', is_error: false, result: 'Proposed two drafts.', total_cost_usd: 0.41, num_turns: 9 };

test('runs the agent under its run token, with roleALPHA as the only tool source', async () => {
	const tokens = tokenServer([runToken('run-1')]);
	const mcp = mcpServer();
	const { query, seen } = fakeQuery(success);

	const r = await runAgent(cfg, { agentUuid: AGENT, task: 'Check open roles', runId: 'ci-42' }, { query, post: tokens.post, transport: mcp.transport });

	assert.deepEqual(r, { runId: 'ci-42', agent: { uuid: AGENT, name: 'Recruiting assistant' }, status: 'done', text: 'Proposed two drafts.', costUsd: 0.41, numTurns: 9, usageReported: true });

	// The usage of the run goes to roleALPHA with the ACCOUNT token; without own prices the SDK's
	// list price, marked as such.
	assert.equal(tokens.usage.length, 1);
	assert.equal(tokens.usage[0].url, 'https://ra.test/api/agent-lauf/verbrauch');
	assert.equal(tokens.usage[0].headers.Authorization, 'Bearer account');
	assert.deepEqual(tokens.usage[0].form, { agent_uuid: AGENT, run_id: 'ci-42', model: 'claude-opus-5-5', cost: '0.41', currency: 'USD', price_kind: 'listenpreis', price_source: 'claude-agent-sdk' });

	const exchange = tokens.calls.find((c) => c.form.grant_type?.includes('token-exchange'));
	assert.equal(exchange?.form.agent_uuid, AGENT);
	assert.equal(exchange?.form.run_id, 'ci-42');
	assert.equal(exchange?.form.subject_token, 'account');

	// Context is read with the run token, as the agent itself ("caller"), for the organisation.
	assert.ok(mcp.bearers.length > 0 && mcp.bearers.every((b) => b === 'run-1'));
	assert.deepEqual(mcp.toolCalls, [{ name: 'get_agent_context', arguments: { agent_uuid: AGENT, organisation: 'Example Ltd', view: 'caller' } }]);

	const o = seen.options!;
	assert.deepEqual(o.tools, []);
	assert.deepEqual(o.settingSources, []);
	assert.equal(o.strictMcpConfig, true);
	assert.equal(o.permissionMode, 'dontAsk');
	assert.deepEqual(o.allowedTools, ['mcp__rolealpha']);
	assert.deepEqual(o.mcpServers, { rolealpha: { type: 'http', url: cfg.mcpUrl, headers: { Authorization: 'Bearer run-1' } } });
	assert.equal(seen.task, 'Check open roles');

	// The system prompt carries identity, binding guardrails, roles and the runner's rules.
	const prompt = String(o.systemPrompt);
	assert.match(prompt, /You are the agent "Recruiting assistant"/);
	assert.match(prompt, /# Guardrails \(binding\)\n## No personal data in drafts\nNever copy salaries\./);
	assert.match(prompt, /- Recruiter\n {2}Purpose: Hire well/);
	assert.match(prompt, /Pass organisation "Example Ltd" on every roleALPHA tool call\./);
});

test('a refused swap stops before Claude starts and says what to do', async () => {
	const tokens = tokenServer([{ status: 429, body: { error: 'agent_budget_erschoepft', error_description: 'Budget used up' } }]);
	const { query, seen } = fakeQuery(success);

	await assert.rejects(
		runAgent(cfg, { agentUuid: AGENT, task: 'x' }, { query, post: tokens.post, transport: mcpServer().transport }),
		(e: unknown) => e instanceof AgentRunError && e.code === 'agent_budget_erschoepft' && e.reaction === 'pauseUntilNextPeriod',
	);
	assert.equal(seen.options, undefined, 'Claude must not start');
});

test('a stale account token is renewed once, then the swap succeeds', async () => {
	const tokens = tokenServer([{ status: 401, body: { error: 'token_ungueltig' } }, runToken('run-1')]);
	const r = await runAgent(cfg, { agentUuid: AGENT, task: 'x' }, { query: fakeQuery(success).query, post: tokens.post, transport: mcpServer().transport });
	assert.equal(r.status, 'done');
	assert.equal(tokens.calls.filter((c) => c.form.grant_type === 'client_credentials').length, 2);
});

test('a long run swaps the token again and hands Claude the new one', async () => {
	const tokens = tokenServer([runToken('run-1'), runToken('run-2')]);
	const { query, seen } = fakeQuery(success, 80);

	const r = await runAgent({ ...cfg, renewEveryMs: 20 }, { agentUuid: AGENT, task: 'x', runId: 'r1' }, { query, post: tokens.post, transport: mcpServer().transport });

	assert.equal(r.status, 'done');
	assert.ok(seen.servers.length >= 1);
	assert.deepEqual(seen.servers[0], { rolealpha: { type: 'http', url: cfg.mcpUrl, headers: { Authorization: 'Bearer run-2' } } });
	const swaps = tokens.calls.filter((c) => c.form.grant_type?.includes('token-exchange'));
	assert.ok(swaps.length >= 2 && swaps.every((c) => c.form.run_id === 'r1'), 'every swap keeps the run ID');
});

test('a refusal during the run interrupts Claude and reports the code', async () => {
	const tokens = tokenServer([runToken('run-1'), { status: 409, body: { error: 'agent_nicht_aktiv', error_description: 'Status: retired' } }]);
	const { query, seen } = fakeQuery(success, 80);

	const r = await runAgent({ ...cfg, renewEveryMs: 20 }, { agentUuid: AGENT, task: 'x' }, { query, post: tokens.post, transport: mcpServer().transport });

	assert.equal(seen.interrupted, true);
	assert.equal(r.status, 'stopped');
	assert.equal(r.reason, 'agent_nicht_aktiv');
});

test('an SDK error result is a stopped run with its subtype', async () => {
	const tokens = tokenServer([runToken('run-1')]);
	const r = await runAgent(cfg, { agentUuid: AGENT, task: 'x' }, {
		query: fakeQuery({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 2.01, num_turns: 30 }).query,
		post: tokens.post,
		transport: mcpServer().transport,
	});
	assert.equal(r.status, 'stopped');
	assert.equal(r.reason, 'error_max_budget_usd');
	assert.equal(r.costUsd, 2.01);
});

test('defaults: Opus 5.5, 40 turns, 2 USD per run', () => {
	const o = runOptions(cfg, 'sys', 't');
	assert.equal(o.model, 'claude-opus-5-5');
	assert.equal(o.maxTurns, 40);
	assert.equal(o.maxBudgetUsd, 2);
});

test('usage: own price table prices the result totals; the SDK list price is not used then', async () => {
	const tokens = tokenServer([{ status: 200, body: { ...runToken('run-1').body, usage_url: 'https://ra.test/usage' } }]);
	const { query } = fakeQuery({ ...success, usage: { input_tokens: 12_000, output_tokens: 1_800, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 } });
	const prices = { currency: 'USD', asOf: '2026-11-20', models: { 'claude-opus-5-5': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 } } };
	const r = await runAgent({ ...cfg, prices }, { agentUuid: AGENT, task: 't', runId: 'ci-43' }, { query, post: tokens.post, transport: mcpServer().transport });
	assert.equal(r.usageReported, true);
	assert.equal(tokens.usage[0].url, 'https://ra.test/usage', 'the usage_url of the exchange');
	assert.deepEqual(tokens.usage[0].form, {
		agent_uuid: AGENT, run_id: 'ci-43', model: 'claude-opus-5-5',
		input_tokens: '12000', cache_read_tokens: '30000', cache_write_tokens: '0', output_tokens: '1800',
		cost: '0.096', currency: 'USD', price_kind: 'tabelle', price_source: 'runner-tabelle 2026-11-20',
	});
});

test('usage: a refused report never breaks the run; the result says why', async () => {
	const tokens = tokenServer([runToken('run-1')], { status: 409, body: { error: 'planung_nicht_lizenziert' } });
	const { query } = fakeQuery(success);
	const r = await runAgent(cfg, { agentUuid: AGENT, task: 't', runId: 'ci-44' }, { query, post: tokens.post, transport: mcpServer().transport });
	assert.equal(r.status, 'done');
	assert.equal(r.usageReported, false);
	assert.equal(r.usageError, 'planung_nicht_lizenziert');
});
