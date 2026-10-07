import type { AdminService } from "./AdminService";
import { asyncOperations, type AsyncOperations } from "../auth/asyncOperations";

/** One reporting owner keeps all admin reads on the same selected backend. */
export function createAsyncAdminService(load: () => AdminService | AsyncOperations<AdminService> | Promise<AdminService | AsyncOperations<AdminService>>): AsyncOperations<AdminService> {
  let owner: ReturnType<typeof load> | undefined;
  const ready = () => owner ??= Promise.resolve().then(load);
  return asyncOperations<AdminService>(ready);
}

// Retain SQLite until PostgreSQL cross-store reporting is implemented and verified.
const reports = createAsyncAdminService(async () => (await import("./AdminService")).adminService());
export function adminService(): AsyncOperations<AdminService> { return reports; }
