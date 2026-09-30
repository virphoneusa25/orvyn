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

function frame(title: string, paragraphs: string[], button?: { label: string; href: string }, footer?: string): string {
  return `<!doctype html><html><body style="margin:0;background:#050816;font-family:Inter,Segoe UI,Arial,sans-serif;color:#F8FAFF">
<div style="max-width:520px;margin:0 auto;padding:40px 28px">
  <div style="font-weight:700;letter-spacing:.14em;font-size:14px;color:#F8FAFF">ORVYN</div>
  <h1 style="font-size:22px;margin:28px 0 12px;color:#F8FAFF">${escapeHtml(title)}</h1>
  ${paragraphs.map((p) => `<p style="color:#9DAAC7;line-height:1.6;font-size:14px">${escapeHtml(p)}</p>`).join("\n  ")}
  ${button ? `<p style="margin:28px 0"><a href="${escapeAttr(button.href)}" style="display:inline-block;padding:12px 22px;border-radius:10px;color:#fff;text-decoration:none;font-weight:600;background:linear-gradient(90deg,#7C4DFF,#31C8FF)">${escapeHtml(button.label)}</a></p>` : ""}
  ${footer ? `<p style="color:#9DAAC7;font-size:12px;line-height:1.6">${escapeHtml(footer)}</p>` : ""}
</div></body></html>`;
}

/** Password reset link (1 hour). */
export function passwordResetMail(input: { to: string; name?: string | null; link: string }): OutgoingMail {
  const hello = input.name ? `Hi ${input.name},` : "Hi,";
  const footer = "The link works for one hour and only once. If you didn't ask to reset your password, ignore this email — your password stays the same.";
  return {
    to: input.to,
    subject: "Reset your ORVYN password",
    text: [hello, "", "Choose a new ORVYN password:", input.link, "", footer].join("\n"),
    html: frame("Reset your password", [`${hello} use the button below to choose a new password. Every device signed in to your account will be signed out.`], { label: "Choose a new password", href: input.link }, footer),
  };
}

/** An invitation to join someone's ORVYN workspace. */
export function teamInviteMail(input: { to: string; workspace: string; invitedBy?: string | null; role: string; link: string }): OutgoingMail {
  const who = input.invitedBy ? `${input.invitedBy} invited you` : "You've been invited";
  const msg = `${who} to join the ${input.workspace} workspace on ORVYN as ${input.role === "admin" ? "an admin" : "a member"}. You'll share its projects, files and credits.`;
  const footer = "The invitation works for 7 days, only for this email address. If you weren't expecting it, you can ignore this email.";
  return {
    to: input.to,
    subject: `Join ${input.workspace} on ORVYN`,
    text: ["Hi,", "", msg, "", input.link, "", footer].join("\n"),
    html: frame(`Join ${input.workspace} on ORVYN`, ["Hi,", msg], { label: "Accept invitation", href: input.link }, footer),
  };
}

/** A security notice (password changed, signed out everywhere, new sign-in method). */
export function securityNoticeMail(input: { to: string; name?: string | null; subject: string; message: string }): OutgoingMail {
  const hello = input.name ? `Hi ${input.name},` : "Hi,";
  const footer = "If this wasn't you, reset your password right away and contact support.";
  return { to: input.to, subject: input.subject, text: [hello, "", input.message, "", footer].join("\n"), html: frame(input.subject, [hello, input.message], undefined, footer) };
}

/** A payment problem (dunning). */
export function paymentFailedMail(input: { to: string; name?: string | null; amountUsd?: number; link?: string | null }): OutgoingMail {
  const hello = input.name ? `Hi ${input.name},` : "Hi,";
  const amount = input.amountUsd ? ` of $${input.amountUsd.toFixed(2)}` : "";
  const msg = `We couldn't collect your ORVYN payment${amount}. Update your payment method to keep your plan; paid features pause if the payment keeps failing.`;
  return {
    to: input.to,
    subject: "Action needed: your ORVYN payment didn't go through",
    text: [hello, "", msg, input.link ?? "", ""].join("\n"),
    html: frame("Your payment didn't go through", [hello, msg], input.link ? { label: "Update payment method", href: input.link } : undefined),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
