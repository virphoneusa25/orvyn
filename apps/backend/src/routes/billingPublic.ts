// apps/backend/src/routes/billingPublic.ts
//
// The two billing endpoints that are reached without an ORVYN session:
//  * the Stripe webhook (authenticated by its signature, raw body), and
//  * the page a browser lands on after Checkout / the portal. That page
//    never changes anything: it says the payment is being confirmed.

import express, { Router } from "express";
import { billingService } from "../billing/stripe";

export const stripeWebhookHandler = [
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req: express.Request, res: express.Response) => {
    const svc = billingService();
    if (!svc.enabled) return res.status(503).json({ error: "Payments are not set up on this server." });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "");
    const result = await svc.handleWebhook(raw, req.header("stripe-signature") ?? undefined);
    res.status(result.status).json(result.body);
  },
] as const;

export const billingReturnRouter = Router();

billingReturnRouter.get("/", (req, res) => {
  const status = String(req.query.status ?? "");
  const [title, body] =
    status === "success" ? ["Thanks — payment received", "Your plan or credits update as soon as the payment is confirmed (usually a few seconds). You can close this window and return to ORVYN."]
    : status === "cancel" ? ["Checkout canceled", "Nothing was charged. You can close this window and return to ORVYN."]
    : ["Billing updated", "You can close this window and return to ORVYN."];
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ORVYN</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e1a;color:#e8ebf5;font:15px/1.5 system-ui,sans-serif}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{opacity:.75;margin:0}</style>
<main><h1>${title}</h1><p>${body}</p></main>`);
});
