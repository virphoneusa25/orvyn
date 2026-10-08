import test from "node:test";
import assert from "node:assert/strict";
import {localEngineEnvironment,packagedNode} from "./localEngineEnvironment.ts";
test("local desktop ignores inherited cloud storage and direct DeepSeek credentials",()=>{
 const base={PATH:"fixture-path",DATABASE_URL:"postgres://fixture-cloud",ORVYN_PG_URL:"postgres://fixture-cloud",ORVYN_POSTGRES_PRIMARY_READS:"1",ORVYN_POSTGRES_PRIMARY_WRITES:"1",ORVYN_POSTGRES_EXECUTION:"1",ORVYN_POSTGRES_DESKTOP_RELEASES:"1",ORVYN_CLOUD_MODE:"true",ORVYN_API_KEY:"fixture-cloud-token",REDIS_URL:"redis://fixture-cloud",ORVYN_REDIS_URL:"redis://fixture-cloud",ORVYN_BUILD_SHA:"old-cloud-sha"};
 const env=localEngineEnvironment(base,{CHEAPER_INFERENCE_API_KEY:"fixture-ci",DEEPSEEK_API_KEY:"fixture-direct"},"fixture-local-data");
 assert.equal(env.ORVYN_BIND_HOST,"127.0.0.1");assert.equal(env.ORVYN_DATA_DIR,"fixture-local-data");assert.equal(env.PATH,base.PATH);
 for(const key of ["DATABASE_URL","ORVYN_PG_URL","ORVYN_API_KEY","DEEPSEEK_API_KEY","REDIS_URL","ORVYN_REDIS_URL","ORVYN_BUILD_SHA"])assert.equal(env[key],"");
 for(const key of ["ORVYN_POSTGRES_PRIMARY_READS","ORVYN_POSTGRES_PRIMARY_WRITES","ORVYN_POSTGRES_EXECUTION","ORVYN_POSTGRES_DESKTOP_RELEASES","DEEPSEEK_EXECUTOR_OVERRIDE_ENABLED"])assert.equal(env[key],"0");
 assert.equal(env.CHEAPER_INFERENCE_API_KEY,"fixture-ci");assert.equal(base.ORVYN_CLOUD_MODE,"true","parent configuration is not mutated");
});
test("packaged runtime uses the native Node executable name",()=>{
 assert.match(packagedNode("fixture","win32"),/node\.exe$/);assert.match(packagedNode("fixture","linux"),/node$/);assert.match(packagedNode("fixture","darwin"),/node$/);
});
