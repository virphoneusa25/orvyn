# Windows cloud smoke test

Run this on a Windows machine with the ORVYN Desktop build from branch `fix/core-agent-runtime`. This environment cannot launch the Windows Electron app, so these steps are the acceptance procedure, not a record of a completed click-through.

Cloud host: `https://orvyn.virphoneusa.com`  
WebSocket: `wss://orvyn.virphoneusa.com/ws/chat`  
Local engine: `http://localhost:4570`

Do not paste an API key for the normal sign-in. Do not redesign the UI while running this. Local projects and chat history must still be present after sign-out.

Optional diagnostics, off by default: in the desktop DevTools console run `localStorage.setItem("orvyn:debug","1")` and reload. The console then prints `[orvyn]` lines with connection mode, backend host, WebSocket host and scheme, cloud state, account state, worker count, whether a session exists, and the active run id. Those lines do not include session tokens, passwords, or API keys. Remove the flag with `localStorage.removeItem("orvyn:debug")`.

The bottom-left name is the Windows account name. On the verification machine that name is Royce. It is not a hardcoded product label.

## A. Local Mode startup

Launch ORVYN Desktop with no cloud session.

Expected:

- Top right: `Local Mode` and `Connect account →`
- Bottom left: Windows account name, subtitle `Local workspace`
- Status bar: `ORVYN Cloud Offline` and `Local Engine Ready`
- The word `Synced` is absent

## B. Connect account

Click `Connect account`. Sign in with the existing account form against `https://orvyn.virphoneusa.com`. Leave the advanced backend URL and API key fields untouched.

## C. Cloud connected state

Expected after login:

- Top right: `ORVYN Cloud` and the account name
- Bottom left: account name, subtitle `Connected` or `Synced`
- Status bar: `ORVYN Cloud Connected` and `Local Engine Ready`
- If a worker is heartbeating: `1 worker online`
- Separate status facts read Backend online, Account signed in, and the worker count
- `GET /api/v1/auth/me` returns 200 for this session

`Synced` appears only after `/auth/me` succeeds and the cloud socket is up.

## D. Chat

Send a normal chat message.

Expected:

- The socket is `wss://orvyn.virphoneusa.com/ws/chat`
- It is not `ws://localhost:4570/ws/chat`
- The reply streams into the desktop

## E. Cloud mission

Start an ORION mission.

Expected:

- The run is created on the OVH control plane
- Run events stream into the desktop
- Chat, missions, approvals, worker calls, memory, usage, and model calls use `https://orvyn.virphoneusa.com` or `wss://orvyn.virphoneusa.com`
- None of those calls use `localhost:4570`

The local-engine health probe may still touch `127.0.0.1:4570`. That probe is the Local Engine indicator, not the cloud API.

## F. Approval

Trigger a tool action that requires approval, then approve it in the desktop.

Expected, in order, on the same run:

- `approval.required`
- `approval.resolved`
- `tool.started`
- tool completion
- the tool result visible on the run

Stop the check only after the result is attached. Delivery of the approval prompt is not enough.

## G. OVH worker

Run `echo ORVYN_WINDOWS_CLOUD_OK` with execution location `OVH_WORKER` (Server mode while signed into cloud).

Expected events:

- `sandbox.started`
- `sandbox.ready`
- `terminal.started`
- `terminal.output` containing `ORVYN_WINDOWS_CLOUD_OK`
- `terminal.completed`

## H. Network loss

While signed in, disconnect Windows from the network.

Expected:

- `ORVYN Cloud Offline`
- `Local Engine Ready`
- `Synced` is absent

Restore the network. Do not restart ORVYN.

Expected:

- Connecting
- `ORVYN Cloud Connected`
- `Synced` once `/auth/me` and the socket succeed again

## I. Desktop restart

Start a cloud run. Close ORVYN Desktop while it is still active. Reopen it.

Expected:

- The session loads from Electron `safeStorage`, not from a plaintext `orvsess_` value in `orvyn-connection.json` or renderer `localStorage`
- `GET /api/v1/auth/me` succeeds
- The WebSocket reconnects to `wss://orvyn.virphoneusa.com/ws/chat`
- The same run reattaches
- Event replay fills events missed while the app was closed

## J. Sign out

Sign out.

Expected:

- `POST /api/v1/auth/logout` revokes the session
- The secure token is cleared
- Top right returns to `Local Mode` / `Connect account →`
- Bottom left returns to the Windows account name and `Local workspace`
- Status bar shows `ORVYN Cloud Offline` and `Local Engine Ready`
- The backend URL used for new calls is `http://localhost:4570`
- Local projects and chat history are still on disk
