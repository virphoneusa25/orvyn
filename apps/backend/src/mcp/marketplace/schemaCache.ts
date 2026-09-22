// Tool schema cache keyed by server + version + schema hash. Avoids
// tools/list on every model turn. Invalidate on update/reconnect/hash mismatch.

import { createHash } from "crypto";

export interface CachedSchema {
  serverId: string;
  version?: string;
  schemaHash: string;
  tools: { name: string; description: string; inputSchema?: Record<string, unknown> }[];
  cachedAt: number;
}

export class ToolSchemaCache {
  private cache = new Map<string, CachedSchema>();

  static hash(tools: { name: string; description?: string; inputSchema?: unknown }[]): string {
    const h = createHash("sha256");
    h.update(JSON.stringify(tools.map((t) => ({ n: t.name, d: t.description, s: t.inputSchema }))));
    return h.digest("hex").slice(0, 16);
  }

  get(serverId: string, version?: string): CachedSchema | undefined {
    const row = this.cache.get(serverId);
    if (!row) return undefined;
    if (version && row.version && row.version !== version) return undefined;
    return row;
  }

  put(serverId: string, tools: CachedSchema["tools"], version?: string): CachedSchema {
    const row: CachedSchema = {
      serverId,
      version,
      schemaHash: ToolSchemaCache.hash(tools),
      tools,
      cachedAt: Date.now(),
    };
    this.cache.set(serverId, row);
    return row;
  }

  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }

  stale(serverId: string, incomingHash: string, version?: string): boolean {
    const row = this.get(serverId, version);
    return !row || row.schemaHash !== incomingHash;
  }
}

export const toolSchemaCache = new ToolSchemaCache();
