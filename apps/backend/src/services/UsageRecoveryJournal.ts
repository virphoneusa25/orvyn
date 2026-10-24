import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UsageEvent } from "./UsageService";

export interface UsageRecoveryJournal {
  pending(): UsageEvent[] | Promise<UsageEvent[]>;
  put(event: UsageEvent): void | Promise<void>;
  remove(id: string): void | Promise<void>;
  check(): void | Promise<void>;
}

/** Disk-backed recovery buffer, separate from database availability; no prompts or credentials. */
export class FileUsageRecoveryJournal implements UsageRecoveryJournal {
  private readonly directory: string;
  constructor(root: string, tenantId: string) {
    this.directory = path.join(root, "usage-recovery", createHash("sha256").update(tenantId).digest("hex"));
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    this.check();
  }
  private file(id: string): string { return path.join(this.directory, createHash("sha256").update(id).digest("hex") + ".json"); }
  private syncDirectory(): void {
    // Windows does not expose directory fsync; Linux production requires it.
    if (process.platform === "win32") return;
    const fd = fs.openSync(this.directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  private write(file: string, text: string): void {
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  check(): void {
    const probe = path.join(this.directory, ".probe-" + randomUUID());
    this.write(probe, "");
    fs.unlinkSync(probe); this.syncDirectory();
  }
  pending(): UsageEvent[] {
    const events: UsageEvent[] = [];
    for (const name of fs.readdirSync(this.directory)) {
      const temporary = name.startsWith(".pending-");
      if (!temporary && !/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
      const event = JSON.parse(fs.readFileSync(file, "utf8")) as UsageEvent;
      if (!event || typeof event.id !== "string" || !Number.isSafeInteger(event.timestamp) || typeof event.ok !== "boolean" ||
          typeof event.modelId !== "string" || typeof event.provider !== "string" || !["generate","stream","image","embed"].includes(event.method) || (!temporary && this.file(event.id) !== file)) {
        throw new Error("Invalid usage recovery record");
      }
      if (temporary) {
        const target = this.file(event.id);
        if (fs.existsSync(target)) {
          if (fs.readFileSync(target, "utf8") !== JSON.stringify(event)) throw new Error("Conflicting usage recovery record");
          fs.unlinkSync(file);
        } else fs.renameSync(file, target);
        this.syncDirectory();
      }
      if (!events.some(existing => existing.id === event.id)) events.push(event);
    }
    return events.sort((a,b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }
  put(event: UsageEvent): void {
    const file = this.file(event.id), text = JSON.stringify(event);
    if (fs.existsSync(file)) {
      if (fs.readFileSync(file, "utf8") !== text) throw new Error("Conflicting usage recovery record");
      return;
    }
    const temporary = path.join(this.directory, ".pending-" + randomUUID());
    this.write(temporary, text);
    fs.renameSync(temporary, file); this.syncDirectory();
  }
  remove(id: string): void {
    try { fs.unlinkSync(this.file(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.syncDirectory();
  }
}
