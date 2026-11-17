#!/usr/bin/env node
/**
 * claude-runner-rolealpha <agent-uuid> "<task>" [--run-id <id>]
 *
 * Prints the run result as JSON on stdout. Exit codes:
 *   0  done
 *   1  the run stopped (see "reason")
 *  75  roleALPHA says: try later (agent paused, budget spent, roleALPHA unreachable)
 *  78  roleALPHA says: configuration or admin action needed (not bound, no right, unknown agent …)
 */

import { AgentRunError, runAgent, type QueryFn, type RunnerConfig } from './runner';

const TRY_LATER = new Set(['pause', 'pauseUntilNextPeriod', 'retryLater']);

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Environment variable ${name} is missing`);
	return value;
}

function number(name: string): number | undefined {
	const value = process.env[name];
	if (!value) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
	return n;
}

const CLOUD_PROVIDERS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/**
 * The runner works unattended for an organisation, which Anthropic's terms put on API keys.
 * It refuses to start on a Claude subscription login alone; an API key also takes precedence
 * over a subscription token in the SDK, so a login on the machine is never used.
 */
export function claudeAccess(env: NodeJS.ProcessEnv): string {
	if (env.ANTHROPIC_API_KEY) return 'api_key';
	if (env.ANTHROPIC_AUTH_TOKEN) return 'auth_token';
	const cloud = CLOUD_PROVIDERS.find((name) => env[name] === '1' || env[name] === 'true');
	if (cloud) return cloud;
	throw new Error(
		'No Claude API access: set ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY). ' +
			'A Claude subscription login is not supported for unattended runs, see README.',
	);
}

export function configFromEnv(): RunnerConfig {
	claudeAccess(process.env);
	return {
		account: {
			tokenUrl: env('ROLEALPHA_TOKEN_URL'),
			clientId: env('ROLEALPHA_CLIENT_ID'),
			clientSecret: env('ROLEALPHA_CLIENT_SECRET'),
			authentication: process.env.ROLEALPHA_CLIENT_AUTH === 'body' ? 'body' : 'header',
		},
		mcpUrl: env('ROLEALPHA_MCP_URL'),
		organisation: env('ROLEALPHA_ORGANISATION'),
		model: process.env.CLAUDE_MODEL || undefined,
		maxTurns: number('RUNNER_MAX_TURNS'),
		maxBudgetUsd: number('RUNNER_MAX_BUDGET_USD'),
	};
}

async function main(argv: string[]): Promise<number> {
	const args = [...argv];
	let runId: string | undefined;
	const at = args.indexOf('--run-id');
	if (at >= 0) [, runId] = args.splice(at, 2);
	const [agentUuid, task] = args;
	if (!agentUuid || !task) {
		console.error('Usage: claude-runner-rolealpha <agent-uuid> "<task>" [--run-id <id>]');
		return 2;
	}

	const { query } = await import('@anthropic-ai/claude-agent-sdk');
	try {
		const result = await runAgent(configFromEnv(), { agentUuid, task, runId }, { query: query as QueryFn });
		console.log(JSON.stringify(result, null, 2));
		return result.status === 'done' ? 0 : 1;
	} catch (e) {
		if (e instanceof AgentRunError) {
			console.error(`roleALPHA refused the run: ${e.message} → ${e.reaction}`);
			return TRY_LATER.has(e.reaction) ? 75 : 78;
		}
		throw e;
	}
}

if (require.main === module) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e) => {
			console.error(e instanceof Error ? e.message : e);
			process.exit(1);
		},
	);
}
