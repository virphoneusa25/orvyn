// apps/backend/src/routes/auth.ts
//
// Account endpoints. Mounted BEFORE the tenant resolver in index.ts:
// register/login must be reachable without credentials, and me/logout
// authenticate directly against the session store (they don't need a tenant).

import { Router, Request } from "express";
import { authService } from "../auth/AuthService";

export const authRouter = Router();

function bearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

authRouter.post("/register", (req, res) => {
  try {
    const { user, token, organization } = authService.register(
      String(req.body.email ?? ""),
      String(req.body.password ?? ""),
      req.body.name ? String(req.body.name) : undefined
    );
    const session = authService.verifyPrincipal(token);
    res.status(201).json({
      user,
      token,
      organization,
      principal: session?.principal ?? null,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.post("/login", (req, res) => {
  try {
    const { user, token, organization } = authService.login(String(req.body.email ?? ""), String(req.body.password ?? ""));
    const session = authService.verifyPrincipal(token);
    res.json({
      user,
      token,
      organization,
      principal: session?.principal ?? null,
    });
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
  const session = token ? authService.verifyPrincipal(token) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  res.json({
    user: session.user,
    principal: session.principal,
    organizations: authService.listOrganizations(session.user.id),
  });
});
