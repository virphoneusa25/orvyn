import test from "node:test";
import assert from "node:assert/strict";
import type { AuthService } from "../auth/AuthService";
import { asyncAuthService } from "../auth/AsyncAuthService";
import { asyncHandler } from "../http/asyncHandler";
import { createAsyncAccountStores } from "../auth/AsyncAccountStores";

test("shared account interfaces propagate initialization failure without another backend", async () => {
  const failure=new Error("account database unavailable");
  let initializations=0;
  const stores=createAsyncAccountStores(async () => { initializations++; throw failure; });
  for(const operation of [() => stores.auth.getUser("user"),() => stores.staff.roleOf("user"),() => stores.onboarding.get("user")]) {
    await assert.rejects(operation(),error => error === failure);
  }
  assert.equal(initializations,1,"all interfaces share one initialization outcome");
});

test("async auth boundary preserves receiver binding, awaits delayed state, and rejects failures", async () => {
  let release!:(value:null) => void;
  const delayed = new Promise<null>(resolve => { release=resolve; });
  const backend = { marker: "bound", getUser() { assert.equal(this.marker,"bound"); return delayed; }, login() { throw new Error("rejected login"); } };
  const boundary=asyncAuthService(() => backend as unknown as AuthService);
  let completed=false;
  const pending=boundary.getUser("user").then(value => { completed=true; return value; });
  await Promise.resolve();
  assert.equal(completed,false,"a request cannot treat a pending lookup as an authenticated user");
  release(null);
  assert.equal(await pending,null);
  await assert.rejects(boundary.login("user","password"),/rejected login/);
});

test("Express adapter forwards both synchronous and delayed authentication errors exactly once", async () => {
  for(const asynchronous of [false,true]) {
    const failure=new Error("authentication storage unavailable");
    let calls=0;
    await new Promise<void>((resolve,reject) => {
      const handler=asyncHandler(() => {
        if(asynchronous) return Promise.resolve().then(() => { throw failure; });
        throw failure;
      });
      handler({} as never,{} as never,error => {
        try { assert.equal(error,failure); calls++; resolve(); } catch(error) { reject(error); }
      });
    });
    await Promise.resolve();
    assert.equal(calls,1);
  }
});
