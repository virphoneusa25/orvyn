import test from "node:test";
import assert from "node:assert/strict";
import {WorkerAdmission} from "./workerAdmission";
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test("concurrent worker admissions share planning and publish once",async()=>{
  const admissions=new WorkerAdmission(),gate=deferred();let plans=0,published=0;
  const plan=async(current:()=>boolean)=>{plans++;await gate.promise;if(current())published++;};
  const one=admissions.run("fixture",plan),two=admissions.run("fixture",plan);
  assert.equal(one,two);gate.resolve();await Promise.all([one,two]);assert.equal(plans,1);assert.equal(published,1);
});

test("cancelled admission cannot publish and resumed planning survives old cleanup",async()=>{
  const admissions=new WorkerAdmission(),oldGate=deferred(),newGate=deferred();const published:string[]=[];
  const old=admissions.run("fixture",async current=>{await oldGate.promise;if(current())published.push("old");});
  admissions.cancel("fixture");
  const resumed=admissions.run("fixture",async current=>{await newGate.promise;if(current())published.push("resumed");});
  oldGate.resolve();await old;
  const concurrent=admissions.run("fixture",async()=>{throw new Error("duplicate planning");});assert.equal(concurrent,resumed);
  newGate.resolve();await resumed;assert.deepEqual(published,["resumed"]);
});

test("failed planning releases admission so a retry can publish",async()=>{
  const admissions=new WorkerAdmission();let published=false;
  await assert.rejects(admissions.run("fixture",async()=>{throw new Error("fixture financial read failed");}),/fixture financial read failed/);
  await admissions.run("fixture",async current=>{published=current();});assert.equal(published,true);
});
