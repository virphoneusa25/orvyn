import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostClick, hostType, hostAction } from './hostDesktopActions';
import { setHostDesktopAllowed, returnHostControl } from './hostDesktopSession';
test('server opt-in cannot grant native OS control without desktop IPC', async () => {
    setHostDesktopAllowed('native-test', true);
    returnHostControl('native-test');
    for (const result of [await hostClick('native-test', 1, 1), await hostType('native-test', '{ENTER}'), await hostAction('native-test', { action: 'screenshot' })]) {
        assert.equal(result.ok, false);
        assert.match(result.error ?? '', /desktop application/);
    }
    setHostDesktopAllowed('native-test', false);
});
test('host screenshot never falls through to a cloud or browser frame', async () => {
    const { ComputerUseCapability } = await import('../computerUse/ComputerUseCapability');
    const capability = new ComputerUseCapability();
    const result = await capability.act({ action: 'screenshot', surface: 'host', identity: { tenantId: 'native-test', projectRoot: 'fixture' } });
    assert.equal(result.ok, false);
    assert.equal(result.surface, 'host');
    assert.equal(result.screenshot, undefined);
});
