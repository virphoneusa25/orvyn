import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { writeDocument, extractDocument, documentPath } from "../../documents/documents";
import { ToolRegistry } from "../ToolTypes";
import { makeCreateDocumentTool, makeReadDocumentTool } from "./documentTools";
import { applyMode } from "../../agent/modes";
import { applyProfile } from "../../gateway/PermissionProfiles";

test("document tools generate real Office/PDF files and read them back", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"orvyn-documents-"));
  try {
    for (const ext of ["docx","pdf","xlsx","pptx","csv","md"]) {
      const file = await writeDocument(root,{name:`test.${ext}`,title:"Quarterly update",content:"# Results\nRevenue increased.\n- Next steps",rows:[["Name","Value"],["Revenue",120]],slides:[{title:"Quarterly update",body:"Revenue increased."}]});
      const bytes=await fs.readFile(path.join(root,file));
      if(ext==="pdf") assert.equal(bytes.subarray(0,4).toString(),"%PDF");
      if(["docx","xlsx","pptx"].includes(ext)) assert.equal(bytes.subarray(0,2).toString(),"PK");
      const result=await extractDocument(file,bytes);
      assert.match(result.text,/Revenue/i,`${ext} text should survive a real round trip`);
    }
    await assert.rejects(writeDocument(root,{name:"test.docx",content:"overwrite"}),/EEXIST/);
    await assert.rejects(documentPath(root,"../outside.txt"),/outside/);
    await assert.rejects(writeDocument(root,{name:"../unsafe.docx",content:"bad"}),/filename/);
    await assert.rejects(extractDocument("broken.docx",Buffer.from("not a zip")));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test("document creation remains forbidden in plan mode under autonomous profile", async () => {
  const registry=new ToolRegistry();registry.register(makeCreateDocumentTool(os.tmpdir()));registry.register(makeReadDocumentTool(os.tmpdir()));
  applyMode(registry,"plan");applyProfile(registry,"AUTONOMOUS");
  assert.equal(registry.getPermission("create_document"),"denied");
  assert.equal(registry.getPermission("read_document"),"allowed");
});
