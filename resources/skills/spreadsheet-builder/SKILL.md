# Spreadsheet Builder

Create a real XLSX workbook with formula totals and verify it reads back.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Call create_document with an .xlsx name and a rows array. Use a formula string such as =SUM(B2:B9) for a total instead of a hardcoded number. This is actual workbook output, not markdown pretending to be a spreadsheet.
3. Call artifact_get with the returned artifactId and read_document on that workbook. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
