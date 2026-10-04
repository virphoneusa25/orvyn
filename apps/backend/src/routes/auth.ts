// apps/backend/src/routes/auth.ts
//
// Account endpoints. Mounted BEFORE the tenant resolver in index.ts:
// register/login must be reachable without credentials, and me/logout
// authenticate directly against the session store (they don't need a tenant).

import { Router, Request } from "express";
import { authService } from "../auth/AuthService";
import { LEGAL_VERSION, REQUIRED_LEGAL_DOCUMENTS } from "../legal/policy";

export const authRouter = Router();

function bearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

authRouter.post("/register", async (req, res) => {
  try {
    const { user, token, legalAcceptance } = await authService.registerAsync(
      String(req.body.email ?? ""),
      String(req.body.password ?? ""),
      req.body.name ? String(req.body.name) : undefined,
      {
        accepted: req.body.legalAccepted === true,
        version: String(req.body.legalVersion ?? ""),
      }
    );
    res.status(201).json({ user, token, legalAcceptance });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const { user, token } = await authService.loginAsync(String(req.body.email ?? ""), String(req.body.password ?? ""));
    res.json({ user, token, legalAcceptance: await authService.getLegalAcceptanceAsync(user.id) });
  } catch (err: any) {
    // 429 for lockout, 401 for bad credentials.
    const status = err.message.startsWith("Too many") ? 429 : 401;
    res.status(status).json({ error: err.message });
  }
});

authRouter.post("/logout", async (req, res) => {
  try {
    const token = bearerToken(req);
    if (token) await authService.logoutAsync(token);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(503).json({ error: "Authentication storage is unavailable", detail: err.message });
  }
});

authRouter.get("/me", async (req, res) => {
  try {
    const token = bearerToken(req);
    const user = token ? await authService.verifyAsync(token) : null;
    if (!user) return res.status(401).json({ error: "Not signed in" });
    res.json({ user, legalAcceptance: await authService.getLegalAcceptanceAsync(user.id) });
  } catch (err: any) {
    res.status(503).json({ error: "Authentication storage is unavailable", detail: err.message });
  }
});

authRouter.get("/legal", async (req, res) => {
  try {
    const token = bearerToken(req);
    const user = token ? await authService.verifyAsync(token) : null;
    res.json({
      version: LEGAL_VERSION,
      requiredDocuments: REQUIRED_LEGAL_DOCUMENTS,
      acceptance: user ? await authService.getLegalAcceptanceAsync(user.id) : null,
    });
  } catch (err: any) {
    res.status(503).json({ error: "Authentication storage is unavailable", detail: err.message });
  }
});

authRouter.post("/legal/accept", async (req, res) => {
  try {
    const token = bearerToken(req);
    const user = token ? await authService.verifyAsync(token) : null;
    if (!user) return res.status(401).json({ error: "Not signed in" });
    const version = String(req.body.version ?? "");
    const acceptance = await authService.recordLegalAcceptanceAsync(user.id, version);
    res.json({ acceptance });
  } catch (err: any) {
    const storageFailure = /postgres|database|connect|timeout|ECONN/i.test(String(err?.message ?? ""));
    res.status(storageFailure ? 503 : 400).json({ error: err.message });
  }
});
