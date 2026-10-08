import {createHash,randomUUID} from "node:crypto";
import {Pool} from "pg";
import type {ModelConfig,TokenUsage} from "@orvyn/ai-core";

export const PROBE_DAILY_MICROS=50_000,PROBE_DAILY_REQUESTS=4;
export const credentialScope=(c:ModelConfig)=>createHash("sha256").update(JSON.stringify([c.providerName,c.apiKey])).digest("hex");
export const verificationKey=(c:ModelConfig)=>createHash("sha256").update(JSON.stringify([credentialScope(c),c.endpoint,c.apiModelId??c.id])).digest("hex");
export type VerificationEvidence={context:number;streaming:boolean;capabilities:ModelConfig["capabilities"]};
export class ProviderVerificationStore {
  private pool:Pool;
  constructor(url:string){this.pool=new Pool({connectionString:url,max:3,connectionTimeoutMillis:5000,statement_timeout:10000,idleTimeoutMillis:1000,allowExitOnIdle:true});}
  async init(){await this.pool.query(`CREATE SCHEMA IF NOT EXISTS orvyn_provider_controls;
    CREATE TABLE IF NOT EXISTS orvyn_provider_controls.probe_attempts (
      id TEXT PRIMARY KEY,scope TEXT NOT NULL,proof_key TEXT NOT NULL,model TEXT NOT NULL,
      reserved_micros BIGINT NOT NULL CHECK(reserved_micros>0),cost_micros BIGINT,
      status TEXT NOT NULL CHECK(status IN ('reserved','succeeded','unknown')),
      quote JSONB NOT NULL,usage JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS probe_scope_day ON orvyn_provider_controls.probe_attempts(scope,created_at);
    CREATE TABLE IF NOT EXISTS orvyn_provider_controls.verifications (
      proof_key TEXT PRIMARY KEY,attempt_id TEXT NOT NULL REFERENCES orvyn_provider_controls.probe_attempts(id),
      evidence JSONB NOT NULL,expires_at BIGINT NOT NULL);`);}
  async reserve(config:ModelConfig,micros:number):Promise<string>{
    if(!Number.isSafeInteger(micros)||micros<1||micros>PROBE_DAILY_MICROS)throw new Error("Provider verification reservation exceeds its daily budget");
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[credentialScope(config)]);
      const r=await client.query(`SELECT count(*)::int AS requests,COALESCE(sum(GREATEST(reserved_micros,COALESCE(cost_micros,0))),0) AS spent
        FROM orvyn_provider_controls.probe_attempts WHERE scope=$1 AND created_at >= (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,[credentialScope(config)]);
      if(r.rows[0].requests>=PROBE_DAILY_REQUESTS||Number(r.rows[0].spent)+micros>PROBE_DAILY_MICROS)throw new Error("Provider verification daily request or reservation budget exhausted");
      const id=randomUUID(),rate=config.rate;
      await client.query(`INSERT INTO orvyn_provider_controls.probe_attempts(id,scope,proof_key,model,reserved_micros,status,quote) VALUES($1,$2,$3,$4,$5,'reserved',$6)`,
        [id,credentialScope(config),verificationKey(config),config.apiModelId??config.id,micros,JSON.stringify({input:rate?.input,output:rate?.output,source:rate?.source,expiresAt:rate?.expiresAt})]);
      await client.query("COMMIT");return id;
    }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
  }
  async settle(id:string,costMicros:number|undefined,usage:TokenUsage|undefined){
    if(costMicros!==undefined&&(!Number.isSafeInteger(costMicros)||costMicros<0))throw new Error("Invalid verification cost");
    const safeUsage=usage?{promptTokens:usage.promptTokens,completionTokens:usage.completionTokens,cachedTokens:usage.cachedTokens}:undefined;
    const r=await this.pool.query(`UPDATE orvyn_provider_controls.probe_attempts SET cost_micros=$2,usage=$3,status=$4 WHERE id=$1 AND status='reserved' RETURNING id`,[id,costMicros??null,safeUsage?JSON.stringify(safeUsage):null,costMicros===undefined?'unknown':'succeeded']);
    if(r.rowCount!==1)throw new Error("Verification attempt was not pending");
  }
  async save(config:ModelConfig,attempt:string){
    const evidence:VerificationEvidence={context:config.contextWindow,streaming:config.streaming,capabilities:{...config.capabilities}};
    const r=await this.pool.query(`INSERT INTO orvyn_provider_controls.verifications(proof_key,attempt_id,evidence,expires_at)
      SELECT proof_key,id,$3,$4 FROM orvyn_provider_controls.probe_attempts WHERE id=$1 AND proof_key=$2 AND status='succeeded' AND cost_micros<=reserved_micros
      ON CONFLICT(proof_key) DO UPDATE SET attempt_id=EXCLUDED.attempt_id,evidence=EXCLUDED.evidence,expires_at=EXCLUDED.expires_at RETURNING proof_key`,[attempt,verificationKey(config),JSON.stringify(evidence),Date.now()+24*60*60_000]);
    if(r.rowCount!==1)throw new Error("Metered verification evidence is unavailable");
  }
  async evidence(config:ModelConfig):Promise<VerificationEvidence|undefined>{
    const exists=await this.pool.query("SELECT to_regclass('orvyn_provider_controls.verifications') AS name");if(!exists.rows[0].name)return;
    const r=await this.pool.query(`SELECT v.evidence FROM orvyn_provider_controls.verifications v JOIN orvyn_provider_controls.probe_attempts a ON a.id=v.attempt_id
      WHERE v.proof_key=$1 AND v.expires_at>$2 AND a.status='succeeded' AND a.cost_micros<=a.reserved_micros`,[verificationKey(config),Date.now()]);
    const e=r.rows[0]?.evidence;
    if(!e||!Number.isSafeInteger(e.context)||e.context<1||typeof e.streaming!=="boolean"||!e.capabilities||Object.values(e.capabilities).some(value=>typeof value!=="boolean"))return;
    return e;
  }
  close(){return this.pool.end();}
}

let runtimeStore:ProviderVerificationStore|undefined;
export async function savedVerification(config:ModelConfig){
  if(process.env.ORVYN_POSTGRES_PRIMARY_READS!=="1"||process.env.ORVYN_POSTGRES_PRIMARY_WRITES!=="1")return;
  const url=process.env.DATABASE_URL||process.env.ORVYN_PG_URL;if(!url)return;
  try{return await(runtimeStore??=new ProviderVerificationStore(url)).evidence(config);}catch{return;}
}
