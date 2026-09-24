import { Router } from "express";
import { readPublishedFile } from "../agent/sitePreview";

export const siteRouter = Router();

function send(id: string, rel: string, res: import("express").Response): void {
  const file = readPublishedFile(id, rel);
  if (!file) {
    res.status(404).type("text/plain").send("That preview file is not in the site this run wrote.");
    return;
  }
  res.setHeader("Content-Type", file.contentType);
  res.send(file.body);
}

siteRouter.use("/:id", (req, res) => {
  const rel = req.path.replace(/^\/+/, "") || "index.html";
  send(req.params.id, rel, res);
});
