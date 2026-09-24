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

siteRouter.get("/:id", (req, res) => send(req.params.id, "index.html", res));
siteRouter.get("/:id/*", (req, res) => send(req.params.id, req.params[0] || "index.html", res));
