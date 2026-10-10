import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserControl,setBrowserControl,clearBrowserControl,checkBrowserAction,markBrowserFrame} from './cloudBrowserControl';
test('takeover blocks agent input while retaining viewing, in that run only',()=>{setBrowserControl('a','user');assert.match(checkBrowserAction('a','browser_click')!,/user has control/);assert.equal(checkBrowserAction('a','browser_screenshot'),undefined);assert.equal(checkBrowserAction('b','browser_click'),undefined);clearBrowserControl('a')});
test('return requires a new agent frame before input',()=>{setBrowserControl('a','orion');assert.match(checkBrowserAction('a','browser_type')!,/fresh/);assert.equal(checkBrowserAction('a','browser_screenshot'),undefined);markBrowserFrame('a');assert.equal(checkBrowserAction('a','browser_type'),undefined);clearBrowserControl('a')});
test('a viewer frame cannot unlock a user-owned browser',()=>{setBrowserControl('a','user');markBrowserFrame('a');assert.equal(browserControl('a').fresh,false);clearBrowserControl('a')});
