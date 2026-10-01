import { Router } from "express";
import { desktopReleaseStore, RELEASE_CHANNELS, type ReleaseChannel } from "../releases/desktopReleaseStore";
import { requireTenant } from "../middleware/tenant";

export const releasesRouter = Router();

releasesRouter.get("/current", (req, res) => {
  const channel = RELEASE_CHANNELS.includes(String(req.query.channel) as ReleaseChannel)
    ? (String(req.query.channel) as ReleaseChannel)
    : "stable";
  const current = desktopReleaseStore().current(channel);
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
});

releasesRouter.post("/telemetry", (req, res) => {
  let accountId: string | undefined;
  try {
    accountId = requireTenant(req).id;
  } catch {
    return res.status(401).json({ error: "Sign in to continue." });
  }
  desktopReleaseStore().recordTelemetry({
    installationId: req.body?.installationId,
    accountId,
    platform: req.body?.platform,
    arch: req.body?.arch,
    version: req.body?.version,
    channel: req.body?.channel,
    event: req.body?.event,
  });
  res.json({ ok: true });
});

releasesRouter.get("/installations", (req, res) => {
  const t = requireTenant(req);
  res.json({ installations: desktopReleaseStore().installationsForAccount(t.id) });
});
