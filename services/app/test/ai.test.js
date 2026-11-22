'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AiClient, AiError } = require('../src/ai');

function fakeServer(responseBody) {
  const captured = { headers: null, body: null };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      captured.headers = request.headers;
      captured.body = JSON.parse(raw);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: responseBody } }]
      }));
    });
  });
  return { server, captured };
}

test('AiClient talks to keyless OpenAI-compatible vLLM and strips Qwen thinking', async () => {
  const { server, captured } = fakeServer('<think>размышление</think>\n{"summary":"ok","attentions":[],"recommendation":"go"}');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new AiClient({
      baseUrl: 'http://127.0.0.1:' + port + '/v1',
      model: 'qwen3-8b',
      timeoutMs: 5000,
      maxTokens: 123,
      apiKey: ''
    });
    const result = await client.summarize('ping');
    assert.equal(result.summary, 'ok');
    assert.equal(captured.headers.authorization, undefined);
    assert.equal(captured.body.model, 'qwen3-8b');
    assert.equal(captured.body.max_tokens, 123);
    assert.equal(captured.body.stream, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('AiClient rejects a non-JSON model answer instead of presenting it as a summary', async () => {
  const { server } = fakeServer('Извините, я не могу помочь с этим запросом.');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new AiClient({ baseUrl: 'http://127.0.0.1:' + port + '/v1', timeoutMs: 5000, apiKey: '' });
    await assert.rejects(() => client.summarize('ping'), error => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'bad_json');
      return true;
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('AiClient extracts a fenced JSON object preceded by prose', async () => {
  const { server } = fakeServer('Вот результат:\n\n```json\n{"summary":"fenced","attentions":[],"recommendation":"go"}\n```');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new AiClient({ baseUrl: 'http://127.0.0.1:' + port + '/v1', timeoutMs: 5000, apiKey: '' });
    const result = await client.summarize('ping');
    assert.equal(result.summary, 'fenced');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('AiClient sends Bearer only when an API key is configured', async () => {
  const { server, captured } = fakeServer('{"summary":"secure"}');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new AiClient({
      baseUrl: 'http://127.0.0.1:' + port + '/v1',
      model: 'qwen3-8b',
      timeoutMs: 5000,
      apiKey: 'test-key'
    });
    const result = await client.summarize('ping');
    assert.equal(result.summary, 'secure');
    assert.equal(captured.headers.authorization, 'Bearer test-key');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
