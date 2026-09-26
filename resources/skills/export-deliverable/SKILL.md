# Export Deliverable

Export the requested supported format and verify the destination artifact.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Read the source with read_file or read_document so the export keeps the same content. Write the requested supported format with create_document, or create_zip when the requested output is an archive.
3. Call artifact_get on the destination. For a document, also call read_document. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
