import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeDesktopPolicy } from './nativeDesktopPolicy.ts';
const window = { handle: '123', pid: 123, started: '456', path: 'C:/fixture.exe', title: 'Fixture' };
function fixture(approve: () => Promise<boolean> = async () => true) {
    let time = 1000;
    const executed: Record<string, unknown>[] = [];
    const audit: unknown[] = [];
    const policy = new NativeDesktopPolicy(async (r) => { executed.push(r); return { ok: true }; }, approve, (...r) => audit.push(r), () => time);
    return { policy, executed, audit, advance: () => time += 300001 };
}
async function grant(f: ReturnType<typeof fixture>, input = true) {
    f.policy.start(window, input);
    await f.policy.request({ action: 'screenshot' });
    f.executed.length = 0;
}
test('off by default; remote requests cannot self-grant or select another target', async () => {
    const f = fixture();
    assert.equal((await f.policy.request({ action: 'click', x: 1, y: 1 })).ok, false);
    assert.equal((await f.policy.request({ action: 'start', handle: '999' })).ok, false);
    await grant(f);
    await f.policy.request({ action: 'click', x: 1, y: 1, handle: '999', expiresAt: 999999999, pid: 999 });
    assert.equal(f.executed[0].handle, '123');
    assert.equal(f.executed[0].pid, 123);
    assert.equal(f.executed[0].expiresAt, 301000);
});
test('view-only grant allows capture but blocks input', async () => {
    const f = fixture();
    f.policy.start(window, false);
    assert.equal((await f.policy.request({ action: 'screenshot' })).ok, true);
    assert.equal((await f.policy.request({ action: 'type', text: 'secret' })).ok, false);
    assert.equal(f.executed.length, 1);
});
test('denial never reaches native helper', async () => {
    const f = fixture(async () => false);
    await grant(f);
    assert.equal((await f.policy.request({ action: 'click', x: 1, y: 1 })).ok, false);
    assert.equal(f.executed.length, 0);
});
test('Stop cancels pending approval and prevents late input', async () => {
    let approve!: (v: boolean) => void;
    const f = fixture(() => new Promise(r => approve = r));
    await grant(f);
    const pending = f.policy.request({ action: 'type', text: 'hello' });
    f.policy.stop();
    approve(true);
    assert.equal((await pending).ok, false);
    assert.equal(f.executed.length, 0);
    assert.equal(f.policy.status().active, false);
});
test('expiry after approval prevents native execution', async () => {
    const f = fixture(async () => { f.advance(); return true; });
    await grant(f);
    assert.equal((await f.policy.request({ action: 'click', x: 1, y: 1 })).ok, false);
    assert.equal(f.executed.length, 0);
});
test('bounded arguments and blocked system shortcuts', async () => {
    const f = fixture();
    await grant(f);
    for (const value of [{ action: 'click', x: NaN, y: 0 }, { action: 'type', text: 'x'.repeat(1001) }, { action: 'scroll', delta: 1201 }, { action: 'key', key: 'Ctrl+R' }, { action: 'shell', text: 'cmd' }])
        assert.equal((await f.policy.request(value)).ok, false);
    assert.equal(f.executed.length, 0);
});
test('only one action may await approval; audit contains no typed contents', async () => {
    let approve!: (v: boolean) => void;
    const f = fixture(() => new Promise(r => approve = r));
    await grant(f);
    const pending = f.policy.request({ action: 'type', text: 'private-content' });
    assert.equal((await f.policy.request({ action: 'screenshot' })).ok, false);
    approve(true);
    await pending;
    assert.equal(JSON.stringify(f.audit).includes('private-content'), false);
});
test('helper failure revokes grant; new session cannot resurrect old approval', async () => {
    let approve!: (v: boolean) => void;
    const f = fixture(() => new Promise(r => approve = r));
    await grant(f);
    const pending = f.policy.request({ action: 'click', x: 1, y: 1 });
    f.policy.start({ ...window, handle: '456' }, true);
    approve(true);
    assert.equal((await pending).ok, false);
    assert.equal(f.executed.length, 0);
    const broken = new NativeDesktopPolicy(async () => { throw new Error('gone'); }, async () => true, () => { });
    broken.start(window, false);
    assert.equal((await broken.request({ action: 'screenshot' })).ok, false);
    assert.equal(broken.status().active, false);
});
test('user takeover cancels pending input while retaining scoped viewing until original expiry', async () => {
    let approve!: (v: boolean) => void;
    const f = fixture(() => new Promise(r => approve = r));
    await grant(f);
    const expiry = f.policy.status().expiresAt;
    const pending = f.policy.request({ action: 'type', text: 'hello' });
    f.policy.takeControl();
    approve(true);
    assert.equal((await pending).ok, false);
    assert.equal(f.policy.status().active, true);
    assert.equal(f.policy.status().input, false);
    assert.equal(f.policy.status().expiresAt, expiry);
    assert.equal((await f.policy.request({ action: 'screenshot' })).ok, true);
    assert.equal((await f.policy.request({ action: 'click', x: 0, y: 0 })).ok, false);
    f.advance();
    assert.equal((await f.policy.request({ action: 'inspect' })).ok, false);
});
test('input requires a fresh observed frame after session creation and return', async () => {
    const f = fixture();
    f.policy.start(window, true);
    assert.match((await f.policy.request({ action: 'click', x: 1, y: 1 })).error ?? '', /fresh screenshot/);
    await f.policy.request({ action: 'screenshot' });
    assert.equal((await f.policy.request({ action: 'click', x: 1, y: 1 })).ok, true);
    f.policy.takeControl();
    f.policy.start(window, true);
    assert.equal((await f.policy.request({ action: 'type', text: 'stale' })).ok, false);
});
test('local UI previews do not satisfy the agent fresh-frame requirement', async () => {
    const f = fixture();
    f.policy.start(window, true);
    await f.policy.request({ action: 'screenshot' }, false);
    assert.equal((await f.policy.request({ action: 'click', x: 1, y: 1 })).ok, false);
});
test('takeover remains viewing-only when an aborted native approval rejects', async () => {
    let reject!: (e: Error) => void;
    const f = fixture(() => new Promise((_r, j) => reject = j));
    await grant(f);
    const pending = f.policy.request({ action: 'type', text: 'must not run' });
    f.policy.takeControl();
    reject(new Error('aborted'));
    assert.equal((await pending).ok, false);
    assert.equal(f.policy.status().active, true);
    assert.equal(f.policy.status().input, false);
});

test('task end cancels old approval but retains the original scoped grant and expiry',async()=>{let resolve!:(value:boolean)=>void;const f=fixture(()=>new Promise(r=>resolve=r));await grant(f);const expiry=f.policy.status().expiresAt;const pending=f.policy.request({action:'click',x:1,y:1});f.policy.endTask();resolve(true);assert.equal((await pending).ok,false);assert.equal(f.executed.length,0);assert.equal(f.policy.status().active,true);assert.equal(f.policy.status().expiresAt,expiry);assert.equal((await f.policy.request({action:'click',x:1,y:1})).ok,false);});
