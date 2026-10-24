import { onboardingStore, staffStore } from "../auth/AsyncAccountStores";
// apps/backend/src/cli/account.ts
//
// Operator tool: create (or update) an ORVYN account from the server, ready
// to use — email verified, setup finished — and optionally make it platform
// staff. The password is typed at a hidden prompt (or piped on stdin); it is
// never an argument, never logged, never written anywhere but its hash.
//
//   docker compose exec backend node dist/cli/account.js --email you@x.com --name "Your Name" [--role super_admin|billing|support|readonly]
//
// An existing account keeps its data; its password is replaced (every
// signed-in device is signed out) and it is marked verified and set up.

import readline from "node:readline";
import { authService } from "../auth/AsyncAuthService";

import { provisionAccount } from "../onboarding/provisioning";
import { STAFF_ROLES, type StaffRole } from "../admin/staffStore";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => { if (!muted) out.output.write(s); else if (s.includes("\n")) out.output.write("\n"); };
  const answer = await new Promise<string>((resolve) => { rl.question(prompt, resolve); muted = true; });
  rl.close();
  return answer;
}

async function main() {
  const email = String(arg("email") ?? "").trim().toLowerCase();
  const name = arg("name")?.trim();
  const role = arg("role") as StaffRole | undefined;
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Usage: node dist/cli/account.js --email you@example.com --name \"Your Name\" [--role super_admin]");
  if (role && !STAFF_ROLES.includes(role)) throw new Error(`--role must be one of: ${STAFF_ROLES.join(", ")}`);
  const password = await readPassword(`New password for ${email}: `);
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (process.stdin.isTTY) {
    const again = await readPassword("Repeat password: ");
    if (again !== password) throw new Error("Passwords don't match.");
  }

  let userId: string;
  const reset = (await authService.createPasswordReset(email));
  if (reset) {
    (await authService.resetPassword(reset.token, password));
    userId = reset.user.id;
    console.log(`Updated the existing account ${email} (its devices were signed out).`);
  } else {
    const created = (await authService.register(email, password, name, "operator-cli"));
    (await authService.logout(created.token));
    userId = created.user.id;
    console.log(`Created ${email}.`);
  }
  if (name) (await authService.setName(userId, name));
  if (!(await authService.isEmailVerified(userId))) {
    const v = (await authService.createEmailVerification(userId));
    (await authService.verifyEmailToken(v.token));
  }
  const store = onboardingStore();
  (await store.ensure(userId, "provisioning", ["welcome", "signup", "verification"]));
  (await provisionAccount(userId));
  (await store.update(userId, { step: "complete", completed: ["provisioning", "name"], ...(name ? { answers: { name } } : {}) }));
  console.log("Email verified and setup complete.");
  if (role) {
    (await staffStore().setStaff(email, role, "operator-cli"));
    (await staffStore().audit({ actorId: "operator-cli", actorEmail: "operator-cli", action: "staff.set", tenantId: null, detail: { email, role } }));
    console.log(`Staff role: ${role}.`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(`Error: ${err?.message ?? err}`); process.exit(1); });
