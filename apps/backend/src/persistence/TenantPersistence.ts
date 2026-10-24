import type { LocalStore } from "./LocalStore";

/** Common persistence contract for local SQLite and acknowledged PostgreSQL calls. */
export type TenantPersistence = {
  [K in keyof LocalStore]: LocalStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<R>
    : LocalStore[K];
};
