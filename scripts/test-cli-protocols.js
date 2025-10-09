#!/usr/bin/env node
"use strict";

const fs = require('fs');
const path = require('path');
const axios = require('axios').default;

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'test-cli-protocols.config.json');
const EXAMPLE_PATH = path.join(__dirname, 'test-cli-protocols.config.example.json');

function ensureTrailingSlashRemoved(url) {
  return url.replace(/\/+$/, '');
}

function buildDefaultConfigFromEnv() {
  const getScenarioEntry = (keyPrefix, defaults) => {
    const apiKey = process.env[`${keyPrefix}_API_KEY`];
    if (!apiKey) return null;
    return {
      name: process.env[`${keyPrefix}_NAME`] || keyPrefix.toLowerCase(),
      apiKey,
      model: process.env[`${keyPrefix}_MODEL`] || defaults.model,
      prompt: process.env[`${keyPrefix}_PROMPT`] || defaults.prompt,
      system: process.env[`${keyPrefix}_SYSTEM`] || defaults.system,
      beta: process.env[`${keyPrefix}_BETA`] === 'true'
    };
  };

  const scenarios = {
    claudeDirect: [],
    claudeBridge: [],
    codexOpenAI: [],
    codexClaude: []
  };

  const direct = getScenarioEntry('CLAUDE', {
    model: 'claude-3-5-haiku-20241022',
    prompt: 'Please respond with a short confirmation (Claude direct test).',
    system: 'You are Claude Code CLI in diagnostic mode.'
  });
  if (direct) scenarios.claudeDirect.push(direct);

  const bridge = getScenarioEntry('CLAUDE_BRIDGE', {
    model: 'claude-3-5-haiku-20241022',
    prompt: 'Please respond with a short confirmation (Claude bridge test).',
    system: 'You are Claude Code CLI bridging via OpenAI.'
  });
  if (bridge) scenarios.claudeBridge.push(bridge);

  const codex = getScenarioEntry('CODEX', {
    model: 'gpt-5',
    prompt: 'Please respond with a short confirmation (Codex → OpenAI test).',
    system: 'You are an assistant validating Codex protocol.'
  });
  if (codex) scenarios.codexOpenAI.push(codex);

  const codexClaude = getScenarioEntry('CODEX_CLAUDE', {
    model: 'claude-sonnet-4-20250514',
    prompt: 'Please respond with a short confirmation (Codex → Claude test).',
    system: 'You are testing the OpenAI-compatible Claude endpoint.'
  });
  if (codexClaude) scenarios.codexClaude.push(codexClaude);

  return {
    baseUrl: process.env.CRS_BASE_URL || 'http://localhost:3000',
    timeoutMs: parseInt(process.env.CRS_TEST_TIMEOUT || DEFAULT_TIMEOUT, 10),
    scenarios
  };
}

function loadConfig() {
  const cliPath = process.argv[2];
  const resolvedCliPath = cliPath ? path.resolve(process.cwd(), cliPath) : null;

  if (resolvedCliPath && fs.existsSync(resolvedCliPath)) {
    return JSON.parse(fs.readFileSync(resolvedCliPath, 'utf8'));
  }

  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  }

  const fallback = buildDefaultConfigFromEnv();
  const hasScenario = Object.values(fallback.scenarios).some((arr) => Array.isArray(arr) && arr.length > 0);
  if (!hasScenario) {
    const msg = [
      'No config file or environment variables detected for test scenarios.',
      `- Place a config at ${DEFAULT_CONFIG_PATH} (see ${EXAMPLE_PATH})`,
      '- or set environment variables such as CLAUDE_API_KEY, CODEX_API_KEY, etc.'
    ].join('
');
    throw new Error(msg);
  }
  return fallback;
}

function buildClaudeRequest(entry) {
  return {
    model: entry.model,
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: entry.system || 'You are Claude Code CLI diagnostic agent.'
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: entry.prompt || 'Say hello from Claude CLI test.'
          }
        ]
      }
    ],
    stream: false,
    max_tokens: entry.maxTokens || 512
  };
}

function buildCodexRequest(entry) {
  return {
    model: entry.model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: entry.system || 'You are Codex CLI diagnostic agent.'
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: entry.prompt || 'Say hello from Codex CLI test.'
          }
        ]
      }
    ],
    stream: false
  };
}

function buildOpenAIChatRequest(entry) {
  return {
    model: entry.model,
    messages: [
      {
        role: 'system',
        content: entry.system || 'You are testing the OpenAI-compatible Claude endpoint.'
      },
      {
        role: 'user',
        content: entry.prompt || 'Say hello from Codex to Claude bridge test.'
      }
    ],
    max_tokens: entry.maxTokens || 512,
    stream: false
  };
}

async function withTiming(fn) {
  const start = Date.now();
  const res = await fn();
  const latency = Date.now() - start;
  return { res, latency };
}

function previewText(text, length = 80) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length - 1)}…`;
}

async function runClaudeDirect(baseUrl, timeoutMs, entry) {
  const url = `${ensureTrailingSlashRemoved(baseUrl)}/api/v1/messages${entry.beta ? '?beta=true' : ''}`;
  const payload = buildClaudeRequest(entry);
  const headers = {
    Authorization: `Bearer ${entry.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'claude-cli/2.0.1 (external, cli)'
  };

  const { res, latency } = await withTiming(() =>
    axios.post(url, payload, { headers, timeout: timeoutMs })
  );

  const text = Array.isArray(res.data?.content)
    ? res.data.content.map((c) => c.text).filter(Boolean).join(' ')
    : res.data?.content?.text || res.data?.output_text || '';

  return {
    status: res.status,
    latency,
    preview: previewText(text)
  };
}

async function runClaudeBridge(baseUrl, timeoutMs, entry) {
  const url = `${ensureTrailingSlashRemoved(baseUrl)}/claude/openai/v1/messages`;
  const payload = buildClaudeRequest(entry);
  const headers = {
    Authorization: `Bearer ${entry.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'claude-cli/2.0.1 (external, cli)'
  };

  const { res, latency } = await withTiming(() =>
    axios.post(url, payload, { headers, timeout: timeoutMs })
  );

  const text = Array.isArray(res.data?.content)
    ? res.data.content.map((c) => c.text).filter(Boolean).join(' ')
    : '';

  return {
    status: res.status,
    latency,
    preview: previewText(text)
  };
}

async function runCodexOpenAI(baseUrl, timeoutMs, entry) {
  const url = `${ensureTrailingSlashRemoved(baseUrl)}/openai/responses`;
  const payload = buildCodexRequest(entry);
  const headers = {
    Authorization: `Bearer ${entry.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.40.0 (Ubuntu 22.04; x86_64) WindowsTerminal'
  };

  const { res, latency } = await withTiming(() =>
    axios.post(url, payload, { headers, timeout: timeoutMs })
  );

  const text = res.data?.output?.[0]?.content?.[0]?.text || res.data?.output_text || '';

  return {
    status: res.status,
    latency,
    preview: previewText(text)
  };
}

async function runCodexClaude(baseUrl, timeoutMs, entry) {
  const url = `${ensureTrailingSlashRemoved(baseUrl)}/openai/claude/v1/chat/completions`;
  const payload = buildOpenAIChatRequest(entry);
  const headers = {
    Authorization: `Bearer ${entry.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.40.0 (Ubuntu 22.04; x86_64) WindowsTerminal'
  };

  const { res, latency } = await withTiming(() =>
    axios.post(url, payload, { headers, timeout: timeoutMs })
  );

  const text = res.data?.choices?.[0]?.message?.content || '';

  return {
    status: res.status,
    latency,
    preview: previewText(text)
  };
}

async function runScenario(baseUrl, timeoutMs, scenarioName, entry, runner) {
  try {
    const result = await runner(baseUrl, timeoutMs, entry);
    return {
      scenario: scenarioName,
      name: entry.name,
      success: result.status >= 200 && result.status < 300,
      status: result.status,
      latencyMs: result.latency,
      preview: result.preview
    };
  } catch (error) {
    return {
      scenario: scenarioName,
      name: entry.name,
      success: false,
      status: error.response?.status || 'ERR',
      latencyMs: undefined,
      preview: previewText(error.response?.data?.error?.message || error.message)
    };
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`
❗ ${err.message}
`);
    process.exit(1);
  }

  const baseUrl = config.baseUrl || 'http://localhost:3000';
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT;
  const scenarios = config.scenarios || {};

  const allResults = [];

  if (Array.isArray(scenarios.claudeDirect)) {
    for (const entry of scenarios.claudeDirect) {
      allResults.push(
        await runScenario(baseUrl, timeoutMs, 'Claude CLI → Claude', entry, runClaudeDirect)
      );
    }
  }

  if (Array.isArray(scenarios.claudeBridge)) {
    for (const entry of scenarios.claudeBridge) {
      allResults.push(
        await runScenario(baseUrl, timeoutMs, 'Claude CLI → OpenAI Responses', entry, runClaudeBridge)
      );
    }
  }

  if (Array.isArray(scenarios.codexOpenAI)) {
    for (const entry of scenarios.codexOpenAI) {
      allResults.push(
        await runScenario(baseUrl, timeoutMs, 'Codex CLI → OpenAI Responses', entry, runCodexOpenAI)
      );
    }
  }

  if (Array.isArray(scenarios.codexClaude)) {
    for (const entry of scenarios.codexClaude) {
      allResults.push(
        await runScenario(baseUrl, timeoutMs, 'Codex CLI → Claude', entry, runCodexClaude)
      );
    }
  }

  if (allResults.length === 0) {
    console.warn('
⚠️  No scenarios defined. Nothing to test.
');
    return;
  }

  const tableData = allResults.map((item) => ({
    Scenario: item.scenario,
    Name: item.name,
    Status: item.status,
    Success: item.success ? '✅' : '❌',
    'Latency(ms)': item.latencyMs ?? '-',
    Preview: item.preview
  }));

  console.log('
=== CLI Protocol Test Summary ===');
  console.table(tableData);

  const failed = allResults.filter((item) => !item.success);
  if (failed.length > 0) {
    console.error(`
❌ ${failed.length} scenario(s) failed. See table above for details.`);
    process.exit(1);
  } else {
    console.log('
✅ All configured scenarios completed successfully.');
  }
}

main().catch((err) => {
  console.error('
❌ Unexpected error while running CLI protocol tests:', err);
  process.exit(1);
});
