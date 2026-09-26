# Archive / ZIP Builder

Zip only the intended files and read the archive back before claiming success.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Call create_zip with only the files the user asked to package. Do not add extra members.
3. Call artifact_get with the returned artifactId. The archive can be claimed only when that readback shows the filename, mime application/zip, and size greater than 0. Do not invent a member list.
4. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
