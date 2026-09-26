# Technical Report Builder

Turn findings into a report that separates facts, observations, and conclusions.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Build the report with create_document as a .docx or .pdf. Separate facts, observations, and conclusions. Include evidence only where a tool result already provided it.
3. Call artifact_get and read_document on that report. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
