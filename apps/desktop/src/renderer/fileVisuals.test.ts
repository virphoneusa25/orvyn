import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactVisualFor, fileIconKeyFor, visualLabelFor } from "./fileVisuals";

// ── Extension mapping ────────────────────────────────────────────────────────

test("code and document files map to their brand icon keys", () => {
  assert.equal(fileIconKeyFor("index.html"), "html");
  assert.equal(fileIconKeyFor("page.htm"), "html");
  assert.equal(fileIconKeyFor("styles.css"), "css");
  assert.equal(fileIconKeyFor("theme.scss"), "sass");
  assert.equal(fileIconKeyFor("index.js"), "js");
  assert.equal(fileIconKeyFor("app.ts"), "ts");
  assert.equal(fileIconKeyFor("component.tsx"), "react");
  assert.equal(fileIconKeyFor("widget.jsx"), "react");
  assert.equal(fileIconKeyFor("data.json"), "json");
  assert.equal(fileIconKeyFor("README.md"), "markdown");
  assert.equal(fileIconKeyFor("guide.mdx"), "markdown");
  assert.equal(fileIconKeyFor("script.py"), "python");
  assert.equal(fileIconKeyFor("server.go"), "go");
  assert.equal(fileIconKeyFor("main.rs"), "rust");
  assert.equal(fileIconKeyFor("query.sql"), "sql");
  assert.equal(fileIconKeyFor("config.yaml"), "yaml");
  assert.equal(fileIconKeyFor("deploy.yml"), "yaml");
  assert.equal(fileIconKeyFor("doc.pdf"), "pdf");
  assert.equal(fileIconKeyFor("bundle.zip"), "archive");
  assert.equal(fileIconKeyFor("notes.txt"), "text");
  assert.equal(fileIconKeyFor("run.sh"), "shell");
});

test("unknown extensions fall back to the generic icon", () => {
  assert.equal(fileIconKeyFor("mystery.foo"), "generic");
  assert.equal(fileIconKeyFor("no-extension"), "generic");
});

// ── Special filenames win over extensions ────────────────────────────────────

test("special filenames map before the extension does", () => {
  assert.equal(fileIconKeyFor("package.json"), "node");
  assert.equal(fileIconKeyFor("package-lock.json"), "node");
  assert.equal(fileIconKeyFor("pnpm-lock.yaml"), "node");
  assert.equal(fileIconKeyFor("yarn.lock"), "node");
  assert.equal(fileIconKeyFor("Dockerfile"), "docker");
  assert.equal(fileIconKeyFor("docker-compose.yml"), "docker");
  assert.equal(fileIconKeyFor(".gitignore"), "git");
  assert.equal(fileIconKeyFor(".env"), "env");
  assert.equal(fileIconKeyFor(".env.local"), "env");
  assert.equal(fileIconKeyFor("tsconfig.json"), "ts");
  assert.equal(fileIconKeyFor("Makefile"), "shell");
  assert.equal(fileIconKeyFor("deep/path/Dockerfile"), "docker", "basename wins at any depth");
});

// ── Image-vs-code decision ───────────────────────────────────────────────────

test("image assets are thumbnails, never file icons", () => {
  for (const f of ["hero.png", "logo.svg", "background.webp", "photo.jpg", "pic.jpeg", "anim.gif", "art.avif", "public/hero.png"]) {
    const v = artifactVisualFor(f);
    assert.equal(v.kind, "thumbnail", `${f} must be a real thumbnail`);
  }
});

test("code files are icons, not thumbnails", () => {
  for (const f of ["index.html", "styles.css", "index.js", "app.ts", "data.json", "readme.md"]) {
    const v = artifactVisualFor(f);
    assert.equal(v.kind, "icon", `${f} must be an icon`);
  }
});

test("mime type image/* also selects the thumbnail", () => {
  assert.equal(artifactVisualFor("blob.bin", { mimeType: "image/png" }).kind, "thumbnail");
});

// ── Empty / fallback ─────────────────────────────────────────────────────────

test("empty files get the muted empty treatment regardless of type", () => {
  assert.equal(artifactVisualFor("hero.png", { size: 0 }).kind, "empty");
  assert.equal(artifactVisualFor("index.html", { size: 0 }).kind, "empty");
});

// ── Accessible labels ────────────────────────────────────────────────────────

test("tooltip labels are human file descriptions", () => {
  assert.equal(visualLabelFor("index.html"), "HTML file");
  assert.equal(visualLabelFor("styles.css"), "CSS stylesheet");
  assert.equal(visualLabelFor("index.js"), "JavaScript file");
  assert.equal(visualLabelFor("app.ts"), "TypeScript file");
  assert.equal(visualLabelFor("weird.xyz"), "File");
});
