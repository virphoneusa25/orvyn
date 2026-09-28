// apps/backend/src/onboarding/mailer.ts
//
// Outgoing account email (verification links) over SMTP. Settings come from
// the environment only: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER,
// SMTP_PASS, SMTP_FROM. Nothing here logs credentials or message links.
//
// ORVYN_MAIL_CAPTURE=<dir> writes each message to a file instead of sending
// (tests read the verification link from it).

import * as fs from "fs";
import * as path from "path";
import nodemailer from "nodemailer";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function mailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORVYN_MAIL_CAPTURE?.trim() || (env.SMTP_HOST?.trim() && env.SMTP_USER?.trim() && env.SMTP_PASS));
}

let transport: nodemailer.Transporter | null = null;

function smtp(env: NodeJS.ProcessEnv = process.env): nodemailer.Transporter {
  if (transport) return transport;
  const port = Number(env.SMTP_PORT) || 465;
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465;
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST!.trim(),
    port,
    secure,
    auth: { user: env.SMTP_USER!.trim(), pass: env.SMTP_PASS! },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  return transport;
}

export async function sendMail(mail: OutgoingMail, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const capture = env.ORVYN_MAIL_CAPTURE?.trim();
  if (capture) {
    fs.mkdirSync(capture, { recursive: true });
    const file = path.join(capture, `${Date.now()}-${mail.to.replace(/[^a-z0-9@.]+/gi, "_")}.json`);
    fs.writeFileSync(file, JSON.stringify(mail, null, 2));
    return;
  }
  if (!mailConfigured(env)) throw new Error("Email is not configured on this server.");
  const from = env.SMTP_FROM?.trim() || `ORVYN <${env.SMTP_USER!.trim()}>`;
  await smtp(env).sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
}

/** The verification email. */
export function verificationMail(input: { to: string; name?: string | null; link: string }): OutgoingMail {
  const hello = input.name ? `Hi ${input.name},` : "Hi,";
  const text = [
    hello,
    "",
    "Confirm your email to finish setting up your ORVYN account:",
    input.link,
    "",
    "The link works for 24 hours. If you did not create an ORVYN account, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#050816;font-family:Inter,Segoe UI,Arial,sans-serif;color:#F8FAFF">
<div style="max-width:520px;margin:0 auto;padding:40px 28px">
  <div style="font-weight:700;letter-spacing:.14em;font-size:14px;color:#F8FAFF">ORVYN</div>
  <h1 style="font-size:22px;margin:28px 0 12px;color:#F8FAFF">Confirm your email</h1>
  <p style="color:#9DAAC7;line-height:1.6;font-size:14px">${escapeHtml(hello)} confirm your email to finish setting up your ORVYN account. ORVYN will continue automatically.</p>
  <p style="margin:28px 0"><a href="${escapeAttr(input.link)}" style="display:inline-block;padding:12px 22px;border-radius:10px;color:#fff;text-decoration:none;font-weight:600;background:linear-gradient(90deg,#7C4DFF,#31C8FF)">Verify email</a></p>
  <p style="color:#9DAAC7;font-size:12px;line-height:1.6">The link works for 24 hours. If you did not create an ORVYN account, ignore this email.</p>
</div></body></html>`;
  return { to: input.to, subject: "Confirm your ORVYN account", text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
