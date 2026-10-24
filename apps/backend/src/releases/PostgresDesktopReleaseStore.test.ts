import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {Pool} from "pg";
import {DesktopReleaseStore} from "./desktopReleaseStore";
import {PostgresDesktopReleaseStore} from "./PostgresDesktopReleaseStore";
import {PostgresDesktopDatabase} from "./PostgresDesktopDatabase";
import {readDesktopSnapshot,desktopFingerprint} from "./DesktopReleaseSnapshot";
test("desktop migration preserves full data, concurrent writes and transactional telemetry",{skip:process.env.ORVYN_DESKTOP_STORAGE_TEST!=="1"},async()=>{
 const url=process.env.ORVYN_PG_URL;assert.ok(url);assert.equal(new URL(url).pathname,"/desktop_storage_test");
 const pool=new Pool({connectionString:url}),dir=fs.mkdtempSync(path.join(os.tmpdir(),"orvyn-desktop-pg-")),sqlite=new DesktopReleaseStore(dir);
 let database:PostgresDesktopDatabase|undefined,first:PostgresDesktopReleaseStore|undefined,second:PostgresDesktopReleaseStore|undefined;
 try{
 sqlite.upsertFromPipeline({version:"1.0.0",channel:"stable",notes:"Unicode "+String.fromCharCode(937,0,92)});
 sqlite.recordTelemetry({installationId:"synthetic-installation",accountId:"synthetic-account",platform:"win32",arch:"x64",version:"1.0.0",channel:"stable",event:"app_started"});
 const snapshot=readDesktopSnapshot(path.join(dir,"desktop-releases.db"));
 database=await PostgresDesktopDatabase.connect(url);await database.importSnapshot(snapshot);assert.equal(desktopFingerprint(await database.exportSnapshot()),desktopFingerprint(snapshot));await database.importSnapshot(snapshot);
 first=await PostgresDesktopReleaseStore.connect(url);second=await PostgresDesktopReleaseStore.connect(url);
 assert.equal((await first.current("stable")).notes,snapshot.desktop_releases[0].notes);assert.equal((await first.summary()).installations.length,1);
 const releases=await Promise.all(Array.from({length:8},(_,i)=>(i%2?first!:second!).upsertFromPipeline({version:"1.1.0",channel:"stable",notes:"concurrent"})));
 assert.equal(new Set(releases.map(r=>r.id)).size,1);assert.equal((await first.list()).length,2);
 await assert.rejects(first.patch(releases[0].id,{required:true}),/super admin/);
 await second.patch(releases[0].id,{required:true,allowRequired:true,rolloutPercent:10});assert.equal((await first.current("stable")).required,true);
 await second.patch(releases[0].id,{status:"paused"});assert.equal((await first.current("stable")).latest,"1.0.0");assert.equal((await first.publicDownloads()).version,"1.0.0");
 const before=desktopFingerprint(await database.exportSnapshot());await assert.rejects(database.importSnapshot({...snapshot,desktop_releases:[]}),/differs/);assert.equal(desktopFingerprint(await database.exportSnapshot()),before);
 await pool.query("CREATE FUNCTION orvyn_desktop.reject_synthetic_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$; CREATE TRIGGER reject_synthetic BEFORE INSERT ON orvyn_desktop.desktop_update_events FOR EACH ROW EXECUTE FUNCTION orvyn_desktop.reject_synthetic_event()");
 await assert.rejects(first.recordTelemetry({installationId:"synthetic-installation",accountId:"synthetic-account",platform:"win32",arch:"x64",version:"9.9.9",channel:"stable",event:"app_started"}),/synthetic rollback/);
 assert.equal((await second.installationsForAccount("synthetic-account"))[0].version,"1.0.0");assert.equal(desktopFingerprint(await database.exportSnapshot()),before);
 await first.close();first=undefined;first=await PostgresDesktopReleaseStore.connect(url);assert.equal((await first.current("stable")).latest,"1.0.0");
 sqlite.db.exec("CREATE TABLE unclassified(value TEXT)");assert.throws(()=>readDesktopSnapshot(path.join(dir,"desktop-releases.db")),/Unclassified/);
 }finally{sqlite.db.close();await first?.close();await second?.close();await database?.close();await pool.query("DROP SCHEMA IF EXISTS orvyn_desktop CASCADE");await pool.end();fs.rmSync(dir,{recursive:true,force:true});}
});
