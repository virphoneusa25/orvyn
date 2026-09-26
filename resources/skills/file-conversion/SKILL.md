# File Conversion

Convert a verified source into a supported destination type and read it back.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Verify the source type with read_document or artifact_get before converting. Convert only to a type create_document supports: docx, pdf, xlsx, pptx, csv, md, or txt.
3. Write the destination with create_document and the requested extension. Call artifact_get and read_document and confirm the destination type is readable.
4. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
