import { PostgresAuthDatabase } from "./PostgresAuthDatabase";
import { PostgresAuthService } from "./PostgresAuthService";
import { PostgresStaffStore } from "../admin/PostgresStaffStore";
import { PostgresOnboardingStore } from "../onboarding/PostgresOnboardingStore";

/** One validated database, connection pool and transaction context for all account stores. */
export class PostgresAccountStores {
  readonly auth:PostgresAuthService;
  readonly staff:PostgresStaffStore;
  readonly onboarding:PostgresOnboardingStore;
  private constructor(private database:PostgresAuthDatabase) {
    this.auth=PostgresAuthService.fromDatabase(database);
    this.staff=PostgresStaffStore.fromDatabase(database);
    this.onboarding=PostgresOnboardingStore.fromDatabase(database);
  }

  static async connect(url:string):Promise<PostgresAccountStores> {
    const stores=new PostgresAccountStores(await PostgresAuthDatabase.connect(url));
    try { await stores.staff.seedFromEnv(); return stores; }
    catch(error) { await stores.close(); throw error; }
  }

  transaction<T>(operation:(stores:PostgresAccountStores) => Promise<T>):Promise<T> {
    // A composite failure must never commit earlier writes, including login rejection.
    return this.database.transaction(() => operation(this), {commitLoginRejection:false});
  }

  /** Close the shared pool once through its owner, after requests have drained. */
  async close():Promise<void> { await this.database.close(); }
}
