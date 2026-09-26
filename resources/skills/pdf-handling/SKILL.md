# PDF Handling

Extract, assemble, or convert PDF content and avoid visual claims from text alone.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Inspect or extract with read_document. Assemble or convert with create_document and a .pdf name when a new PDF is requested. read_document does not perform OCR.
3. Do not claim visual PDF verification from raw text alone when page inspection is needed. Open the persisted artifact in the existing browser session and capture browser_screenshot before describing the page.
4. When a PDF was created, call artifact_get. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
