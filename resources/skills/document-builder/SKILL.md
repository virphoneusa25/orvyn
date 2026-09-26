# Document Builder

Create a structured DOCX and verify the persisted artifact.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Call create_document with a .docx name. Preserve headings as lines that start with # and lists as lines that start with -. Keep formatting the tool supports. A markdown table in that content is not a real table, so do not claim one was created.
3. Call artifact_get with the artifactId from that result, and read_document on the persisted name. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
