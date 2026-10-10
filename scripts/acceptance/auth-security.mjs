// scripts/acceptance/auth-security.mjs
//
// Account security over the real API, with a mock Google/GitHub:
//   1. Sessions: each device is listed; one can be ended; "sign out
//      everywhere" ends the others; rotation issues a new token and reusing
//      the old one ends the whole family.
//   2. Password reset: the same answer for unknown emails; a single-use
//      link; the new password works, the old one doesn't; every session ends.
//   3. The login lockout survives a restart.
//   4. Google sign-in from the desktop: state + PKCE (the mock provider checks
//      the S256 challenge), the browser never carries a session token, the
//      app claims its session with its secret verifier exactly once.
//   5. Linking: a provider-verified email joins the existing account;
//      GitHub with no verified email is refused.
//
// Usage (after `npm run build -w @orvyn/backend`): node scripts/acceptance/auth-security.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4861, IDP_PORT = 4862;
const BASE = `http://127.0.0.1:${PORT}`, IDP = `http://127.0.0.1:${IDP_PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-auth-data-"));
const mailDir = mkdtempSync(join(tmpdir(), "orvyn-auth-mail-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };
const b64url = (b) => Buffer.from(b).toString("base64url");

// ---- mock identity provider (Google and GitHub shapes) ----
const codes = new Map(); // code -> { challenge, user, provider }
let nextUser = { sub: "g-1", email: "linked@example.com", verified: true, name: "Linked" };
const idpSeen = [];
const idp = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const u = new URL(req.url, IDP);
    idpSeen.push(u.pathname + (u.search ? "?" + u.searchParams.toString() : ""));
    if (u.pathname.endsWith("/authorize")) {
      if (u.searchParams.get("code_challenge_method") !== "S256" || !u.searchParams.get("code_challenge") || !u.searchParams.get("state")) { res.writeHead(400); return res.end("missing pkce/state"); }
      const code = b64url(randomBytes(12));
      codes.set(code, { challenge: u.searchParams.get("code_challenge"), user: { ...nextUser }, provider: u.pathname.includes("github") ? "github" : "google" });
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code); back.searchParams.set("state", u.searchParams.get("state"));
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (u.pathname.endsWith("/token")) {
      const p = new URLSearchParams(raw);
      const entry = codes.get(p.get("code"));
      codes.delete(p.get("code"));
      const pkceOk = entry && b64url(createHash("sha256").update(p.get("code_verifier") ?? "").digest()) === entry.challenge;
      res.setHeader("Content-Type", "application/json");
      if (!pkceOk || p.get("client_secret") !== "test-secret") { res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" })); }
      const token = `at_${b64url(randomBytes(8))}`;
      codes.set(token, entry);
      return res.end(JSON.stringify({ access_token: token, token_type: "bearer" }));
    }
    const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
    const entry = codes.get(token);
    res.setHeader("Content-Type", "application/json");
    if (!entry) { res.statusCode = 401; return res.end("{}"); }
    if (u.pathname === "/google/v1/userinfo") return res.end(JSON.stringify({ sub: entry.user.sub, email: entry.user.email, email_verified: entry.user.verified, name: entry.user.name }));
    if (u.pathname === "/github/user") return res.end(JSON.stringify({ id: 4242, login: "octo", name: entry.user.name }));
    if (u.pathname === "/github/user/emails") return res.end(JSON.stringify([{ email: entry.user.email, primary: true, verified: entry.user.verified }]));
    res.statusCode = 404; res.end("{}");
  });
});

const call = async (path, method = "GET", body, token, headers = {}) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text, location: r.headers.get("location") };
};
/** Follows the browser's redirects (server → provider → server callback) and returns the final page. */
async function browser(url) {
  const trail = [url];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { redirect: "manual" });
    if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.get("location"), url).toString(); trail.push(url); continue; }
    return { status: r.status, text: await r.text(), trail };
  }
  return { status: 0, text: "too many redirects", trail };
}
const mails = () => readdirSync(mailDir).sort().map((f) => JSON.parse(readFileSync(join(mailDir, f), "utf8")));

let server; const log = [];
function start() {
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, ORVYN_PROJECTS_DIR: mkdtempSync(join(tmpdir(), "orvyn-auth-proj-")), PORT: String(PORT),
    ORVYN_CLOUD_MODE: "true", ORVYN_REQUIRE_EMAIL_VERIFICATION: "false", ORVYN_PUBLIC_ORIGIN: BASE, ORVYN_MAIL_CAPTURE: mailDir,
    ORVYN_VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
    GOOGLE_CLIENT_ID: "g-client", GOOGLE_CLIENT_SECRET: "test-secret", GITHUB_CLIENT_ID: "gh-client", GITHUB_CLIENT_SECRET: "test-secret",
    ORVYN_OAUTH_GOOGLE_AUTHORIZE: `${IDP}/google/authorize`, ORVYN_OAUTH_GOOGLE_TOKEN: `${IDP}/google/token`, ORVYN_OAUTH_GOOGLE_API: `${IDP}/google`,
    ORVYN_OAUTH_GITHUB_AUTHORIZE: `${IDP}/github/authorize`, ORVYN_OAUTH_GITHUB_TOKEN: `${IDP}/github/token`, ORVYN_OAUTH_GITHUB_API: `${IDP}/github`,
    ORVYN_ONBOARDING_RATE_LIMIT_RPM: "1000", ORVYN_SESSION_ROTATION_GRACE_MS: "1500", ORVYN_AUTH_RATE_LIMIT_RPM: "1000",
  };
  delete env.ORVYN_API_KEY;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "STRIPE_SECRET_KEY"]) env[k] = "";
  server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
}
async function ready() { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch {} await sleep(250); } }

async function main() {
  await new Promise((r) => idp.listen(IDP_PORT, "127.0.0.1", r));
  start(); await ready();
  try {
    console.log("\n1. Sessions");
    const reg = await call("/auth/register", "POST", { name: "Sam", email: "sam@example.com", password: "first-password-1" }, null, { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) ORVYN Electron/33" });
    const A = reg.json.token;
    const B = (await call("/auth/login", "POST", { email: "sam@example.com", password: "first-password-1" }, null, { "User-Agent": "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130 Safari/537" })).json.token;
    const C = (await call("/auth/login", "POST", { email: "sam@example.com", password: "first-password-1" }, null, { "User-Agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130" })).json.token;
    const list = await call("/auth/sessions", "GET", null, A);
    ok(list.json.sessions?.length === 3 && list.json.sessions.some((s) => s.current && /Desktop · Windows/.test(s.device)) && list.json.sessions.some((s) => /Chrome · macOS/.test(s.device)), "every signed-in device is listed (device, last used, this one marked)", JSON.stringify(list.json.sessions));
    ok(!list.text.includes("orvsess_"), "the list never shows a token");
    const mac = list.json.sessions.find((s) => /macOS/.test(s.device));
    await call(`/auth/sessions/${mac.id}`, "DELETE", null, A);
    ok((await call("/auth/me", "GET", null, B)).status === 401, "ending one device signs it out");
    const other = await call("/auth/sessions/ses_not_mine", "DELETE", null, A);
    ok(other.status === 404, "a session that isn't yours can't be ended");
    await call("/auth/logout-all", "POST", {}, A);
    ok((await call("/auth/me", "GET", null, C)).status === 401 && (await call("/auth/me", "GET", null, A)).status === 200, "sign out everywhere ends the others and keeps this one");
    const rot = await call("/auth/refresh", "POST", {}, A);
    const A2 = rot.json.token;
    ok(rot.status === 200 && A2 && A2 !== A && (await call("/auth/me", "GET", null, A)).status === 401 && (await call("/auth/me", "GET", null, A2)).status === 200, "refresh rotates: the old token stops working");
    const A3 = (await call("/auth/refresh", "POST", {}, A2)).json.token;
    const inflight = await call("/auth/me", "GET", null, A2); // an in-flight request right after rotation
    ok(inflight.status === 401 && (await call("/auth/me", "GET", null, A3)).status === 200, "a request in flight during rotation is refused without signing the device out");
    await sleep(2000);
    const replay = await call("/auth/me", "GET", null, A2); // reuse of a rotated token, later
    ok(replay.status === 401 && (await call("/auth/me", "GET", null, A3)).status === 401, "reusing a rotated token ends the whole family (stolen-token defence)");

    console.log("\n2. Password reset");
    const unknown = await call("/auth/password/forgot", "POST", { email: "nobody@example.com" });
    const known = await call("/auth/password/forgot", "POST", { email: "sam@example.com" });
    ok(unknown.status === 200 && known.status === 200 && unknown.json.message === known.json.message, "the same answer whether or not the account exists");
    const m = mails().find((x) => x.to === "sam@example.com" && /Reset/.test(x.subject));
    const link = (m?.text.match(/https?:\/\/\S+\/auth\/reset\?token=\S+/) ?? [])[0];
    ok(Boolean(link) && mails().every((x) => x.to !== "nobody@example.com"), "one reset email, only to the real account");
    const S = (await call("/auth/login", "POST", { email: "sam@example.com", password: "first-password-1" })).json.token;
    const pageRes = await fetch(link);
    ok(pageRes.status === 200 && /Choose a new password/.test(await pageRes.text()), "the link opens a reset page");
    const token = new URL(link).searchParams.get("token");
    const done = await call("/auth/password/reset", "POST", { token, password: "second-password-2" });
    const again = await call("/auth/password/reset", "POST", { token, password: "third-password-3" });
    ok(done.status === 200 && again.status === 400, "the link works once");
    ok((await call("/auth/me", "GET", null, S)).status === 401, "every session ended");
    ok((await call("/auth/login", "POST", { email: "sam@example.com", password: "first-password-1" })).status === 401 && (await call("/auth/login", "POST", { email: "sam@example.com", password: "second-password-2" })).status === 200, "the old password fails; the new one works");
    ok(mails().some((x) => x.to === "sam@example.com" && /password was changed/i.test(x.subject)), "a security notice is emailed");

    console.log("\n3. Lockout survives a restart");
    for (let i = 0; i < 5; i++) await call("/auth/login", "POST", { email: "sam@example.com", password: "wrong" });
    server.kill("SIGKILL"); await sleep(500); start(); await ready();
    const locked = await call("/auth/login", "POST", { email: "sam@example.com", password: "second-password-2" });
    ok(locked.status === 429 && /Too many failed attempts/.test(locked.json.error ?? ""), "still locked after a restart (the account lockout, not the IP limiter)", `${locked.status} ${locked.text}`);

    console.log("\n4. Google sign-in from the desktop");
    await call("/auth/register", "POST", { name: "Linked", email: "linked@example.com", password: "linked-password-1" });
    const existingId = (await call("/auth/login", "POST", { email: "linked@example.com", password: "linked-password-1" })).json.user.id;
    const hid = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const early = await call("/auth/handoff/claim", "POST", { hid, verifier });
    ok(early.status === 400, "nothing to claim before sign-in starts");
    const flow = await browser(`${BASE}/api/v1/auth/oauth/google/start?client=desktop&hid=${hid}&challenge=${challenge}`);
    ok(flow.status === 200 && /signed in/.test(flow.text), "the browser completes Google sign-in", `${flow.status} ${flow.text.slice(0, 200)}`);
    ok(flow.trail.every((u) => !/orvsess_/.test(u)) && !/orvsess_/.test(flow.text), "no session token in any URL or page the browser sees");
    ok(idpSeen.some((u) => /code_challenge_method=S256/.test(u)), "the provider got a PKCE challenge");
    const wrong = await call("/auth/handoff/claim", "POST", { hid, verifier: b64url(randomBytes(32)) });
    ok(wrong.status === 400, "a wrong verifier can't claim it");
    const claim = await call("/auth/handoff/claim", "POST", { hid, verifier });
    ok(claim.status === 200 && claim.json.token?.startsWith("orvsess_") && claim.json.user?.id === existingId, "the app claims its session with its verifier — linked to the existing account (verified email)", JSON.stringify(claim.json).slice(0, 200));
    const twice = await call("/auth/handoff/claim", "POST", { hid, verifier });
    ok(twice.status === 400, "…exactly once");
    const replayState = await browser(flow.trail[flow.trail.length - 1]);
    ok(replayState.status === 400, "replaying the callback URL does nothing");


    console.log("\n4b. Native mobile sign-in");
    const mobileHid = b64url(randomBytes(24));
    const mobileVerifier = b64url(randomBytes(32));
    const mobileChallenge = b64url(createHash("sha256").update(mobileVerifier).digest());
    const invalidStart = await call("/auth/handoff/start", "POST", { hid: "bad", challenge: "bad" });
    ok(invalidStart.status === 400, "native handoff rejects invalid id and challenge");
    const mobileStart = await call("/auth/handoff/start", "POST", { hid: mobileHid, challenge: mobileChallenge });
    const pendingMobile = await call("/auth/handoff/claim", "POST", { hid: mobileHid, verifier: mobileVerifier });
    ok(mobileStart.status === 201 && pendingMobile.status === 202, "mobile may poll safely before the system browser navigates");
    // Opening the browser repeats initialization but must preserve this handoff.
    const mobileFlow = await browser(`${BASE}/api/v1/auth/oauth/google/start?client=mobile&hid=${mobileHid}&challenge=${mobileChallenge}`);
    ok(mobileFlow.status === 200 && /signed in/.test(mobileFlow.text), "mobile Google sign-in completes in the system browser");
    ok(mobileFlow.trail.every((url) => !url.includes(mobileVerifier) && !/orvsess_/.test(url)) && !/orvsess_/.test(mobileFlow.text), "native browser URLs never carry the secret verifier or session");
    const mobileWrong = await call("/auth/handoff/claim", "POST", { hid: mobileHid, verifier: b64url(randomBytes(32)), device: "ORVYN Mobile" });
    ok(mobileWrong.status === 400, "mobile also rejects the wrong verifier");
    const mobileClaim = await call("/auth/handoff/claim", "POST", { hid: mobileHid, verifier: mobileVerifier, device: "ORVYN Mobile" });
    ok(mobileClaim.status === 200 && mobileClaim.json.user?.id === existingId && mobileClaim.json.token?.startsWith("orvsess_"), "mobile uses the same existing account");
    ok((await call("/auth/handoff/claim", "POST", { hid: mobileHid, verifier: mobileVerifier })).status === 400, "mobile session is claimed exactly once");
    const mobileDevices = await call("/auth/sessions", "GET", null, mobileClaim.json.token);
    ok(mobileDevices.json.sessions?.some((device) => device.current && device.device === "ORVYN Mobile"), "the mobile session has the correct device label");

    console.log("\n5. GitHub without a verified email");
    nextUser = { sub: "gh-9", email: "unverified@example.com", verified: false, name: "U" };
    const hid2 = b64url(randomBytes(24)); const v2 = b64url(randomBytes(32));
    const flow2 = await browser(`${BASE}/api/v1/auth/oauth/github/start?client=desktop&hid=${hid2}&challenge=${b64url(createHash("sha256").update(v2).digest())}`);
    ok(flow2.status === 400 && /verified email/.test(flow2.text), "refused: no verified email", flow2.text.slice(0, 200));
    ok((await call("/auth/handoff/claim", "POST", { hid: hid2, verifier: v2 })).status === 202, "…so the app has nothing to claim (still pending)");
    nextUser = { sub: "gh-10", email: "newperson@example.com", verified: true, name: "New Person" };
    const hid3 = b64url(randomBytes(24)); const v3 = b64url(randomBytes(32));
    await browser(`${BASE}/api/v1/auth/oauth/github/start?client=desktop&hid=${hid3}&challenge=${b64url(createHash("sha256").update(v3).digest())}`);
    const c3 = await call("/auth/handoff/claim", "POST", { hid: hid3, verifier: v3 });
    const ob = await call("/onboarding", "GET", null, c3.json.token);
    ok(c3.status === 200 && ob.json.user?.emailVerified === true && ob.json.profile?.currentStep === "provisioning", "a new GitHub account is created verified and continues at setup (no password, no email step)", JSON.stringify(ob.json.profile));

    console.log("\n6. Connect GitHub (repository access) from a signed-in app");
    const G = c3.json.token;
    const linkRes = await call("/auth/github/connect-link", "POST", {}, G);
    ok(linkRes.status === 200 && /\/auth\/github\/connect\?link=/.test(linkRes.json.url ?? "") && !/orvsess_/.test(linkRes.json.url ?? ""), "the app gets a one-time connect link (no session in it)", JSON.stringify(linkRes.json));
    const connectFlow = await browser(linkRes.json.url);
    ok(connectFlow.status === 200 && /GitHub connected/.test(connectFlow.text), "the browser authorizes and GitHub is connected", connectFlow.text.slice(0, 160));
    ok(idpSeen.some((u) => u.includes("/github/authorize") && /scope=repo/.test(u)), "repository scope was requested");
    const gh = await call("/onboarding/github", "GET", null, G);
    ok(gh.json.connected === true && !/at_/.test(gh.text), "ORVYN reports it connected; the GitHub token is never returned", gh.text);
    const reuse = await browser(linkRes.json.url);
    ok(reuse.status === 400, "the connect link works once");
    ok(!log.join("").match(/orvsess_[0-9a-f]{8}|test-secret|orvrst_/), "no tokens or client secrets in the server log");
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server?.kill("SIGKILL"); idp.close();
  }
  if (failures) console.log("--- server log (tail) ---\n" + log.join("").slice(-2500));
  console.log(failures === 0 ? "\nAUTH SECURITY: PASS" : `\nAUTH SECURITY: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}
main();
