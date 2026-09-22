# Project intelligence (Phase 5)

Qdrant is an intelligence layer. Workspace files remain the source of truth.

## Collection strategy

One shared collection: `orvyn_code`.

Payload filters (always applied server-side):

- `tenantId`
- `projectId`
- optional `revision`

Do not create a collection per project. Isolation is payload + scoped point IDs, not collection proliferation.

## Project identity

`logicalProjectId(tenantId, root, explicit?)` hashes the last two path segments with the tenant. Mission-container paths (`/tmp/orvyn…`, `orvyn-mission-<runId>`) never define identity. Prefer an explicit `projectId` when the desktop or snapshot provides one.

Logical scope:

```
{ tenantId, projectId, revision, branch }
```

## Payload

Every chunk stores: tenantId, projectId, revision, branch, path, language, symbol, symbolKind, startLine, endLine, chunkHash, fileHash, indexVersion, embeddingModel, updatedAt.

Secrets are never indexed (`.env*`, `*.pem`, `*.key`, `id_rsa*`, credential files).

## Index schema

`INDEX_SCHEMA_VERSION = orvyn-intel-2`

Bump when chunking, payload, embedding model, or vector dimension change incompatibly.

Default embedder: `HashingEmbedder` (dimension 256) unless a model provider implements `embed()`. Cloud deployments may use `OPENAI_EMBED_MODEL` / `OPENAI_EMBED_DIMS` (typically 1536). Worker nodes never hold embedding credentials.

## Persistence

Qdrant uses the named Docker volume `qdrant-data` mounted at `/qdrant/storage`. Vectors survive container restart, backend restart, and compose recreate.

## Search

`HybridSearch` ranks semantic + keyword + symbol + path + recency, then diversifies (max 3 chunks per file). Exact symbol and exact filename get large boosts.

ORION tools (via ToolGateway): `search_codebase`, `find_symbol`, `find_file`, `related_files`, `search_tests`, `get_project_outline`.

Snippets are not authoritative. `read_file` the live file before editing.
