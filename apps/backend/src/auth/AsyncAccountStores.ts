import type { AuthService } from "./AuthService";
import type { StaffStore } from "../admin/staffStore";
import type { OnboardingStore } from "../onboarding/OnboardingStore";
import { asyncOperations, type AsyncOperations } from "./asyncOperations";

export interface AsyncAccountStores {
  auth:AsyncOperations<AuthService>;
  staff:AsyncOperations<StaffStore>;
  onboarding:AsyncOperations<OnboardingStore>;
}
type AccountBackend = AsyncAccountStores | {auth:AuthService;staff:StaffStore;onboarding:OnboardingStore};

/** All account interfaces resolve through one backend owner, never independent flags. */
export function createAsyncAccountStores(load:() => AccountBackend | Promise<AccountBackend>):AsyncAccountStores {
  let owner:Promise<AccountBackend> | undefined;
  const ready=() => owner ??= Promise.resolve().then(load);
  return {
    auth:asyncOperations<AuthService>(async () => (await ready()).auth),
    staff:asyncOperations<StaffStore>(async () => (await ready()).staff),
    onboarding:asyncOperations<OnboardingStore>(async () => (await ready()).onboarding),
  };
}

// PostgreSQL selection remains blocked until cross-store reporting/billing are ready.
// Lazy initialization retains SQLite behavior and creates no database on import.
const accountStores=createAsyncAccountStores(async () => {
  const auth=await import("./AuthService");
  const staff=await import("../admin/staffStore");
  const onboarding=await import("../onboarding/OnboardingStore");
  return {auth:auth.authService,staff:staff.staffStore(),onboarding:onboarding.onboardingStore()};
});
export const accountAuth=accountStores.auth;
export function staffStore():AsyncAccountStores["staff"] { return accountStores.staff; }
export function onboardingStore():AsyncAccountStores["onboarding"] { return accountStores.onboarding; }
