/**
 * Runs one roleALPHA agent with the Claude Agent SDK.
 *
 * Contract (roleALPHA, `agent:run`): the runner holds one service account. For every run
 * it swaps the account token for a run token (RFC 8693, 15 minutes) that carries exactly
 * the view of one agent. Claude then works through roleALPHA's MCP endpoint under that
 * token: it sees what the agent may see and writes only drafts, which a person approves.
 *
 * Claude gets no built-in tools (no shell, no files, no web) and no settings of the host:
 * the only tools of a run are the roleALPHA tools the run token allows.
 */

import { randomUUID } from 'crypto';
import type {
	McpServerConfig,
	Options,
	Query,
	SDKResultMessage,
	SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { AgentRunError, AgentRunTokens, type FormPost, type FunctionAccount, type TokenStore } from './vendor/agentRun';
import { McpClient, type Transport } from './vendor/mcp';
import { getAgentContext } from './vendor/agents';
import { buildSystemPrompt } from './vendor/prompt';

export { AgentRunError };

/** The SDK's `query`, injected so tests run without Claude and the ESM SDK loads lazily. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface RunnerConfig {
	account: FunctionAccount;
	/** roleALPHA MCP address, e.g. https://app.rolealpha.app/api/mcp */
	mcpUrl: string;
	/** Name or ID of the organisation; every roleALPHA tool call needs it. */
	organisation: string;
	model?: string;
	maxTurns?: number;
	/** Hard cost cap of one run in USD, enforced by the SDK, independent of roleALPHA's budget. */
	maxBudgetUsd?: number;
	/** Swap the run token again this often; it is valid for 15 minutes. */
	renewEveryMs?: number;
	/** Rules added to the system prompt after roleALPHA's own. */
	extraRules?: string[];
}

export interface RunnerDeps {
	query: QueryFn;
	post?: FormPost;
	/** MCP transport under a bearer token (used to read the agent's context before the run). */
	transport?: (mcpUrl: string, bearer: string) => Transport;
	now?: () => number;
	store?: TokenStore;
}

export interface RunInput {
	agentUuid: string;
	task: string;
	/** Appears in every audit entry of the run. Default: `claude-<uuid>`. */
	runId?: string;
}

export interface RunResult {
	runId: string;
	agent: { uuid: string; name: string | null };
	status: 'done' | 'stopped';
	text?: string;
	/** What Claude reports as the cost of the run. roleALPHA does not receive it (see README). */
	costUsd?: number;
	numTurns?: number;
	/** Why a stopped run stopped: an SDK result subtype or a roleALPHA refusal code. */
	reason?: string;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';
const SERVER = 'rolealpha';

// ─── HTTP with fetch ────────────────────────────────────────────────────────

export const fetchFormPost: FormPost = async (url, form, headers) => {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
		body: new URLSearchParams(form),
	});
	return { status: res.status, body: await res.text() };
};

export function fetchTransport(mcpUrl: string, bearer: string): Transport {
	return async (body, headers) => {
		const res = await fetch(mcpUrl, {
			method: 'POST',
			headers: { ...headers, Authorization: `Bearer ${bearer}` },
			body: JSON.stringify(body),
		});
		const out: Record<string, string> = {};
		res.headers.forEach((v, k) => (out[k] = v));
		return { status: res.status, headers: out, body: await res.text() };
	};
}

// ─── The run ────────────────────────────────────────────────────────────────

export function runnerRules(organisation: string): string[] {
	return [
		`Pass organisation "${organisation}" on every roleALPHA tool call.`,
		'There is no current step in this run: the task in the user message is your assignment.',
		'Whatever you write in roleALPHA becomes a draft that a person approves. Say so in your report; never claim a change is done.',
	];
}

function mcpServer(mcpUrl: string, bearer: string): McpServerConfig {
	return { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${bearer}` } };
}

/** The SDK options of a run: roleALPHA is the only tool source, nothing of the host leaks in. */
export function runOptions(cfg: RunnerConfig, systemPrompt: string, bearer: string): Options {
	return {
		model: cfg.model ?? DEFAULT_MODEL,
		systemPrompt,
		tools: [],
		mcpServers: { [SERVER]: mcpServer(cfg.mcpUrl, bearer) },
		strictMcpConfig: true,
		settingSources: [],
		allowedTools: [`mcp__${SERVER}`],
		permissionMode: 'dontAsk',
		maxTurns: cfg.maxTurns ?? 40,
		maxBudgetUsd: cfg.maxBudgetUsd ?? 2,
	};
}

export async function runAgent(cfg: RunnerConfig, input: RunInput, deps: RunnerDeps): Promise<RunResult> {
	const tokens = new AgentRunTokens(deps.post ?? fetchFormPost, deps.now, deps.store ?? { accounts: new Map(), runs: new Map() });
	const transport = deps.transport ?? fetchTransport;
	const runId = input.runId ?? `claude-${randomUUID()}`;

	// Refusals (agent paused, budget spent, not bound …) throw here, before Claude starts.
	let run = await tokens.runToken(cfg.account, input.agentUuid, runId);

	const client = new McpClient(transport(cfg.mcpUrl, run.token), '@rolealpha/claude-runner');
	const bundle = await getAgentContext(client, cfg.organisation, run.agent.uuid, 'caller');
	const systemPrompt = buildSystemPrompt({ bundle, extraRules: [...runnerRules(cfg.organisation), ...(cfg.extraRules ?? [])] });
	const agent = { uuid: run.agent.uuid, name: run.agent.name ?? bundle.agent.name ?? null };

	// Swapping the MCP server mid-run (setMcpServers) needs streaming input:
	// the input stays open until the result has arrived.
	let close!: () => void;
	const closed = new Promise<void>((resolve) => (close = resolve));
	async function* prompt(): AsyncIterable<SDKUserMessage> {
		yield { type: 'user', message: { role: 'user', content: input.task }, parent_tool_use_id: null };
		await closed;
	}

	const q = deps.query({ prompt: prompt(), options: runOptions(cfg, systemPrompt, run.token) });

	let stopReason: string | undefined;
	let renewing = false;
	const renew = setInterval(async () => {
		if (renewing || stopReason) return;
		renewing = true;
		try {
			// A fresh swap checks the agent's status and budget again.
			run = await tokens.runToken(cfg.account, agent.uuid, runId, { fresh: true });
			const r = await q.setMcpServers({ [SERVER]: mcpServer(cfg.mcpUrl, run.token) });
			if (r.errors[SERVER]) throw new Error(`mcp_reconnect_failed: ${r.errors[SERVER]}`);
		} catch (e) {
			stopReason = e instanceof AgentRunError ? e.code : e instanceof Error ? e.message : String(e);
			await q.interrupt().catch(() => undefined);
			close();
		} finally {
			renewing = false;
		}
	}, cfg.renewEveryMs ?? 12 * 60_000);

	let result: SDKResultMessage | undefined;
	try {
		for await (const message of q) {
			if (message.type === 'result') {
				result = message;
				close();
			}
		}
	} finally {
		clearInterval(renew);
		close();
	}

	const base = { runId, agent, costUsd: result?.total_cost_usd, numTurns: result?.num_turns };
	if (stopReason) return { ...base, status: 'stopped', reason: stopReason };
	if (!result) return { ...base, status: 'stopped', reason: 'no_result' };
	if (result.subtype !== 'success' || result.is_error) return { ...base, status: 'stopped', reason: result.subtype === 'success' ? 'api_error' : result.subtype };
	return { ...base, status: 'done', text: result.result };
}
