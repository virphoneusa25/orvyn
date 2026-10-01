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

authRouter.post("/register", (req, res) => {
  try {
    const { user, token, legalAcceptance } = authService.register(
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

authRouter.post("/login", (req, res) => {
  try {
    const { user, token } = authService.login(String(req.body.email ?? ""), String(req.body.password ?? ""));
    res.json({ user, token, legalAcceptance: authService.getLegalAcceptance(user.id) });
  } catch (err: any) {
    // 429 for lockout, 401 for bad credentials.
    const status = err.message.startsWith("Too many") ? 429 : 401;
    res.status(status).json({ error: err.message });
  }
});

authRouter.post("/logout", (req, res) => {
  const token = bearerToken(req);
  if (token) authService.logout(token);
  res.json({ ok: true });
});

authRouter.get("/me", (req, res) => {
  const token = bearerToken(req);
  const user = token ? authService.verify(token) : null;
  if (!user) return res.status(401).json({ error: "Not signed in" });
  res.json({ user, legalAcceptance: authService.getLegalAcceptance(user.id) });
});

authRouter.get("/legal", (req, res) => {
  const token = bearerToken(req);
  const user = token ? authService.verify(token) : null;
  res.json({
    version: LEGAL_VERSION,
    requiredDocuments: REQUIRED_LEGAL_DOCUMENTS,
    acceptance: user ? authService.getLegalAcceptance(user.id) : null,
  });
});

authRouter.post("/legal/accept", (req, res) => {
  const token = bearerToken(req);
  const user = token ? authService.verify(token) : null;
  if (!user) return res.status(401).json({ error: "Not signed in" });
  try {
    const version = String(req.body.version ?? "");
    const acceptance = authService.recordLegalAcceptance(user.id, version);
    res.json({ acceptance });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
