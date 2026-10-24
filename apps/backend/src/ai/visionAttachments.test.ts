import {test} from "node:test";
import assert from "node:assert/strict";
import {normalizeVisionAttachments} from "./visionAttachments";
test("ICO model input becomes PNG without modifying the original attachment",async()=>{
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=","base64");
 const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=1;ico[7]=1;ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
 const original={kind:"image" as const,name:"orvyn-icon.ico",mediaType:"image/x-icon",b64:Buffer.concat([ico,png]).toString("base64")};
 const [image]=await normalizeVisionAttachments([original]);assert.equal(image!.mediaType,"image/png");assert.equal(image!.b64,png.toString("base64"));assert.equal(original.mediaType,"image/x-icon");
});
test("invalid ICO containers fail before any provider request",async()=>{
 await assert.rejects(normalizeVisionAttachments([{kind:"image",name:"bad.ico",mediaType:"image/x-icon",b64:"invalid"}]),/Upload it as PNG/);
});
