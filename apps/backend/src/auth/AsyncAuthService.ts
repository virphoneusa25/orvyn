import type { AuthService } from "./AuthService";

export type AsyncAuthService = {
  [K in keyof AuthService]: AuthService[K] extends (...args:infer A) => infer R
    ? (...args:A) => Promise<R> : never;
};

/** Preserve receiver binding and turn synchronous failures into rejected promises. */
export function asyncAuthService(load:() => AuthService | AsyncAuthService | Promise<AuthService | AsyncAuthService>): AsyncAuthService {
  return new Proxy({} as AsyncAuthService, {
    get(_target, method:keyof AuthService) {
      return async (...args:unknown[]) => {
        const service = await load();
        const operation = service[method] as (...values:unknown[]) => unknown;
        if (typeof operation !== "function") throw new Error("Unknown authentication operation");
        return operation.apply(service, args);
      };
    },
  });
}

// Local mode remains authoritative until auth, admin and onboarding migrate together.
// Loading is lazy: importing the boundary alone never opens a SQLite database.
export const authService = asyncAuthService(async () => (await import("./AuthService")).authService);
