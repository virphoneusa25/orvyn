import { asyncHandler } from "../http/asyncHandler";
import { Router } from "express";
import { desktopReleaseStore, RELEASE_CHANNELS, type ReleaseChannel } from "../releases/AsyncDesktopReleaseStore";
import { requireTenant } from "../middleware/tenant";

export const releasesRouter = Router();

releasesRouter.get("/current", asyncHandler(async (req, res) => {
  const channel = RELEASE_CHANNELS.includes(String(req.query.channel) as ReleaseChannel)
    ? (String(req.query.channel) as ReleaseChannel)
    : "stable";
  const current = (await desktopReleaseStore().current(channel));
  res.json({
    latest: current.latest,
    minimumSupported: current.minimumSupported,
    channel: current.channel,
    required: current.required,
    notes: current.notes,
    publishedAt: current.publishedAt,
    paused: current.paused,
    rolloutPercent: current.rolloutPercent,
  });
}));

releasesRouter.post("/telemetry", asyncHandler(async (req, res) => {
  let accountId: string | undefined;
  try {
    accountId = requireTenant(req).id;
  } catch {
    return res.status(401).json({ error: "Sign in to continue." });
  }
  (await desktopReleaseStore().recordTelemetry({
    installationId: req.body?.installationId,
    accountId,
    platform: req.body?.platform,
    arch: req.body?.arch,
    version: req.body?.version,
    channel: req.body?.channel,
    event: req.body?.event,
  }));
  res.json({ ok: true });
}));

releasesRouter.get("/installations", asyncHandler(async (req, res) => {
  const t = requireTenant(req);
  res.json({ installations: (await desktopReleaseStore().installationsForAccount(t.id)) });
}));
