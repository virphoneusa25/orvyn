import type { AuthService } from "./AuthService";
import { asyncOperations } from "./asyncOperations";
import { accountAuth } from "./AsyncAccountStores";

export type AsyncAuthService = {
  [K in keyof AuthService]: AuthService[K] extends (...args:infer A) => infer R
    ? (...args:A) => Promise<R> : never;
};

/** Preserve receiver binding and turn synchronous failures into rejected promises. */
export function asyncAuthService(load:() => AuthService | AsyncAuthService | Promise<AuthService | AsyncAuthService>): AsyncAuthService {
  return asyncOperations<AuthService>(load);
}

// Local mode remains authoritative until auth, admin and onboarding migrate together.
// Loading is lazy: importing the boundary alone never opens a SQLite database.
export const authService:AsyncAuthService = accountAuth;
