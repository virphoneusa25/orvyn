import path from "node:path";

/** Local engine settings are independent of any inherited cloud deployment. */
export function localEngineEnvironment(
  base: NodeJS.ProcessEnv,
  credentials: Record<string, string>,
  dataDir: string,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...credentials,
    PORT: "4570",
    ORVYN_BIND_HOST: "127.0.0.1",
    ORVYN_CLOUD_MODE: "false",
    ORVYN_DATA_DIR: dataDir,
    ORVYN_API_KEY: "",
    ORVYN_POSTGRES_MIRROR: "0",
    ORVYN_POSTGRES_PRIMARY_READS: "0",
    ORVYN_POSTGRES_PRIMARY_WRITES: "0",
    ORVYN_POSTGRES_DESKTOP_RELEASES: "0",
    ORVYN_POSTGRES_EXECUTION: "0",
    ORVYN_POSTGRES_READ_FALLBACK_SQLITE: "0",
    DATABASE_URL: "",
    ORVYN_PG_URL: "",
    PGPASSWORD: "",
    ORVYN_REDIS_URL: "",
    ORVYN_ENV: "local",
    REDIS_URL: "",
    REDIS_QUEUE_URL: "",
    REDIS_CACHE_URL: "",
    REDIS_AUTH_URL: "",
    ORVYN_DISTRIBUTED_CONTROLS: "0",
    ORVYN_DISTRIBUTED_MISSIONS: "0",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_EXECUTOR_OVERRIDE_ENABLED: "0",
    ORVYN_BUILD_SHA: "",
    ORVYN_ENFORCE_CREDITS: "false",
  };
}

export function packagedNode(backend: string, platform = process.platform): string {
  return path.join(backend, platform === "win32" ? "node.exe" : "node");
}
