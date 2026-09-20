import { Router } from "express";
import { promises as fs } from "fs";
import path from "path";
import { requireTenant } from "../middleware/tenant";
import { documentPath, DOCUMENT_EXTENSIONS, DOCUMENT_LIMIT, extractDocument } from "../documents/documents";
import { resolveWorkspace } from "../documents/workspace";
export const documentRouter = Router();

documentRouter.post("/extract", async (req,res) => {
  try {
    const {name,b64} = req.body;
    if (typeof name !== "string" || typeof b64 !== "string" || b64.length > DOCUMENT_LIMIT * 1.34 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return res.status(400).json({error:"Provide a document of at most 6 MB."});
    res.json(await extractDocument(name, Buffer.from(b64,"base64")));
  } catch(e:any) {res.status(400).json({error:e.message});}
});

documentRouter.get("/", async (req,res) => {
  try {
    const root = await resolveWorkspace(requireTenant(req), req.query.projectRoot);
    const dir = await documentPath(root,".orvyn/artifacts");
    let names: string[];
    try {names = await fs.readdir(dir);} catch(e:any) {if(e.code === "ENOENT") return res.json({documents:[]}); throw e;}
    const documents = [];
    for (const name of names) {
      if (!DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const file = await documentPath(root, `.orvyn/artifacts/${name}`);
      const stat = await fs.stat(file);
      if (stat.isFile()) documents.push({name,size:stat.size,modified:stat.mtimeMs});
    }
    res.json({documents:documents.sort((a,b)=>b.modified-a.modified).slice(0,100)});
  } catch(e:any) {res.status(400).json({error:e.message});}
});

documentRouter.get("/:name", async (req,res) => {
  try {
    const name = req.params.name;
    if (path.basename(name) !== name || /[\\/]/.test(name) || !DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())) return res.status(400).json({error:"Invalid document name."});
    const root = await resolveWorkspace(requireTenant(req), req.query.projectRoot);
    const file = await documentPath(root, `.orvyn/artifacts/${name}`);
    if ((await fs.stat(file)).size > DOCUMENT_LIMIT) return res.status(413).json({error:"Document exceeds the preview/download limit of 6 MB."});
    if (req.query.preview === "text") return res.json(await extractDocument(name, await fs.readFile(file)));
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Cache-Control","private, no-store");
    res.download(file,name);
  } catch(e:any) {res.status(e.code === "ENOENT" ? 404 : 400).json({error:e.message});}
});
