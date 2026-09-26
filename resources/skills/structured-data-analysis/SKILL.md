# Structured Data Analysis

Inspect columns and types, and write an artifact only when one was requested.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Inspect the schema with read_document or read_file. Name the columns and types that result shows. Distinguish calculated results from source values.
3. Produce an artifact only when the user asked for a file. Use create_document or artifact_create for that file, then artifact_get. If no file was requested, do not create one.
4. When a file was created, completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
