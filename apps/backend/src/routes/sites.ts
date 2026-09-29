import { Router } from "express";
import { PREVIEW_CACHE_CONTROL, readPublishedFile, rebaseRootUrls } from "../agent/sitePreview";
import { publishedSiteHealth } from "../agent/previewCheck";

export const siteRouter = Router();

function send(id: string, rel: string, prefix: string, res: import("express").Response): void {
  const file = readPublishedFile(id, rel);
  if (!file) {
    res.status(404).type("text/plain").send("That preview file is not in the site this run wrote.");
    return;
  }
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Cache-Control", PREVIEW_CACHE_CONTROL);
  // The site is served under /api/v1/sites/<id>/: a root-absolute "/styles.css"
  // in the project means this site's styles.css, not the server's root.
  // Rewritten on the way out — the project's own files are never changed.
  if (/^text\/(html|css)/.test(file.contentType)) {
    res.send(rebaseRootUrls(file.body.toString("utf8"), prefix, file.contentType.startsWith("text/css") ? "css" : "html"));
    return;
  }
  res.send(file.body);
}

// The preview's real health (page + every stylesheet/script/image it links),
// so the Preview pane is green only when the site actually renders styled.
siteRouter.get("/:id/__health", async (req, res) => {
  const health = await publishedSiteHealth(req.params.id, readPublishedFile, rebaseRootUrls);
  res.setHeader("Cache-Control", "no-store");
  res.json(health);
});

siteRouter.use("/:id", (req, res) => {
  const rel = req.path.replace(/^\/+/, "") || "index.html";
  // Inside this handler req.baseUrl is the site's own root: /api/v1/sites/<id>.
  send(req.params.id, rel, req.baseUrl.replace(/\/+$/, ""), res);
});
