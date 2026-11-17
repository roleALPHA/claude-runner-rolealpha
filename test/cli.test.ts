import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAccess } from '../src/cli';

test('starts with an API key, a gateway token or a cloud provider', () => {
	assert.equal(claudeAccess({ ANTHROPIC_API_KEY: 'sk-ant-x' }), 'api_key');
	assert.equal(claudeAccess({ ANTHROPIC_AUTH_TOKEN: 't' }), 'auth_token');
	assert.equal(claudeAccess({ CLAUDE_CODE_USE_BEDROCK: '1' }), 'CLAUDE_CODE_USE_BEDROCK');
	assert.equal(claudeAccess({ CLAUDE_CODE_USE_VERTEX: 'true' }), 'CLAUDE_CODE_USE_VERTEX');
});

test('refuses a subscription token alone', () => {
	assert.throws(() => claudeAccess({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' }), /subscription login is not supported/);
	assert.throws(() => claudeAccess({}), /No Claude API access/);
	assert.throws(() => claudeAccess({ CLAUDE_CODE_USE_BEDROCK: '0' }), /No Claude API access/);
});
