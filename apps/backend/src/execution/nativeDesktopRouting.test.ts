import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRemoteTools } from './RemoteToolAdapter';
import { ToolRpcChannel } from './ToolRpc';
import { PermissionEngine } from '../gateway/PermissionEngine';
import { ToolRegistry } from '../ai/ToolTypes';
import { registerHostDesktopTools } from '../ai/tools/hostDesktopTools';
import { applyMode } from '../agent/modes';
import { applyAccessMode } from '../gateway/PermissionProfiles';
test('only an explicitly local-host execution mounts native desktop tools into RPC', async () => {
    const cloud: string[] = [];
    registerRemoteTools({ register: t => cloud.push(t.name) }, new ToolRpcChannel(), 'cloud');
    assert.equal(cloud.some(n => n.startsWith('host_desktop_')), false);
    const local = new Map<string, any>();
    const rpc = new ToolRpcChannel();
    registerRemoteTools({ register: t => local.set(t.name, t) }, rpc, 'local', 'fixture', true);
    assert.ok(local.has('host_desktop_inspect'));
    assert.ok(local.has('host_desktop_screenshot'));
    const pending = local.get('host_desktop_screenshot').execute({});
    const request = rpc.poll('local');
    assert.ok(request);
    const screenshot = { b64: 'iVBORw0KGgo=', mediaType: 'image/png' };
    rpc.resolve({ requestId: request.requestId, runId: 'local', ok: true, output: 'Selected window', meta: { screenshot }, durationMs: 1 });
    assert.deepEqual((await pending).meta.screenshot, screenshot);
    rpc.cleanup('local');
});
test('native capability does not grant SYSTEM; read-only modes keep native input denied', () => {
    const permissions = new PermissionEngine();
    assert.equal(permissions.checkRole('host_desktop_click', 'coder').allowed, true);
    assert.equal(permissions.checkRole('unknown_system_tool', 'coder').allowed, false);
    const registry = new ToolRegistry();
    registerHostDesktopTools(t => registry.register(t), 'fixture');
    for (const mode of ['plan', 'research'] as const) {
        applyMode(registry, mode);
        applyAccessMode(registry, 'full_access');
        assert.equal(registry.getPermission('host_desktop_click'), 'denied');
        assert.equal(registry.getPermission('host_desktop_type'), 'denied');
    }
    applyMode(registry, 'agent');
    assert.equal(registry.getPermission('host_desktop_click'), 'ask');
});
