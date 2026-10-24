// Run inside the production backend container with its existing environment:
// docker compose ... exec -T backend node < scripts/acceptance/huggingface-production.cjs
// No key or authorization header is logged. No fallback provider is permitted.
const assert = require('node:assert/strict');
const { ModelService } = require('./dist/services/ModelService');
const { startRoute } = require('./dist/models/routingPolicy');
const build = require('./build-info.json');

(async () => {
  assert.match(process.env.HUGGINGFACE_ROUTING_ENABLED || '', /^(1|true)$/i);
  const service = new ModelService();
  const availableIds = service.registry.list().map((provider) => provider.config.id);
  const route = startRoute({ profile: 'auto', instruction: 'Say hello', availableIds });
  assert.ok(route.registryId?.startsWith('hf:'), `HF verification failed: production selected ${route.registryId}`);
  const provider = service.registry.get(route.registryId);
  const configuredEndpoint = new URL(provider.config.endpoint);
  assert.equal(configuredEndpoint.hostname, 'router.huggingface.co');
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/chat/completions')) {
      assert.equal(url.hostname, configuredEndpoint.hostname, 'Fallback provider is a verification failure');
      const model = JSON.parse(String(init?.body)).model;
      assert.equal(model, provider.config.apiModelId);
      const response = await originalFetch(input, init);
      requests.push({ host: url.hostname, path: url.pathname, model, status: response.status });
      return response;
    }
    return originalFetch(input, init);
  };
  const response = await provider.generate({
    messages: [{ role: 'user', content: 'Reply with exactly: HF Test Passed' }],
    maxOutputTokens: 512,
  });
  assert.ok(requests.length > 0, 'No HF provider request was observed');
  assert.ok(requests.every((request) => request.status === 200));
  assert.ok(response.content.includes('HF Test Passed'), 'HF response did not satisfy the smoke test');
  console.log(JSON.stringify({ status: 'passed', commit: build.commit, registryId: route.registryId,
    provider: 'huggingface', adapter: provider.config.provider, requests, response: response.content }));
  process.exit(0);
})().catch((error) => {
  // Provider errors can contain upstream payloads. Keep failure output secret-safe.
  console.error(JSON.stringify({ status: 'failed', error: error.name, code: error.code || null,
    detail: error.name === 'AssertionError' ? error.message : 'Provider request failed; inspect securely on the server.' }));
  process.exit(1);
});
