import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveTaskSurface,surfaceToolAllowed} from './taskSurface';
import {inferTaskIntent} from '../agent/taskIntent';
function decide(instruction:string,overrides:Partial<Parameters<typeof resolveTaskSurface>[0]>={}){return resolveTaskSurface({instruction,intent:inferTaskIntent(instruction,'auto'),client:'desktop',requested:'auto',localAuthorized:true,localSupported:true,...overrides})}
test('native screen task selects authorized local computer',()=>{assert.deepEqual(decide('Click in Notepad on my screen'),{surface:'local_computer',allowed:true,executionTarget:'local_host'})});
test('disabled and unsupported local permissions never substitute cloud',()=>{for(const override of [{localAuthorized:false},{localSupported:false}]){const result=decide('Click in Notepad',override);assert.equal(result.allowed,false);assert.equal(result.surface,'none');assert.match(result.message!,/off or unavailable/)}});
test('explicit cloud execution cannot silently become local screen access',()=>{assert.equal(decide('Click in Notepad',{requested:'ovh_worker'}).allowed,false)});
test('cloud rejects physical computer and explicit local execution',()=>{assert.equal(decide('Click in Notepad',{client:'cloud'}).allowed,false);assert.equal(decide('Build my project',{client:'cloud',requested:'local_host'}).allowed,false)});
test('cloud desktop, browser and project tasks use isolated worker',()=>{for(const instruction of ['Use the virtual desktop to open an application','Browse https://example.com and check its title','Build a website in the project']){const result=decide(instruction,{client:'cloud'});assert.equal(result.allowed,true);assert.equal(result.executionTarget,'ovh_worker',instruction);assert.notEqual(result.surface,'local_computer')}});
test('informational question does not activate a screen',()=>{assert.equal(decide('Explain how a database index works').surface,'none')});

test('local terminal tasks retain the selected project workspace',()=>{const intent=inferTaskIntent('Run the slow counter and tell me what it prints.','auto');assert.equal(intent.requiresWorkspace,true);assert.equal(decide(intent.goal).surface,'project_workspace')});

test('desktop never offers or executes virtual desktop tools, and cloud never executes host tools',()=>{for(const tool of ['desktop_start','computer_click','computer.screenshot'])assert.equal(surfaceToolAllowed(tool,'desktop','host'),false);assert.equal(surfaceToolAllowed('host_desktop_click','cloud','desktop'),false);assert.equal(surfaceToolAllowed('desktop_start','cloud','none'),false);assert.equal(surfaceToolAllowed('browser_screenshot','cloud','browser'),true);assert.equal(surfaceToolAllowed('host_desktop_click','desktop','host'),true)});

test('asking what is on the actual screen is a visual task, not an answer from memory',()=>{assert.equal(decide('What is on my screen?').surface,'local_computer');assert.equal(decide('What is on my screen?',{localAuthorized:false}).allowed,false);assert.equal(decide('Explain how desktop permissions work').surface,'none')});
