# Image Generation

Generate an image only when a real image artifact is persisted and read back.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Call generate_image. Success is a real persisted image artifact. The tool result must include the artifactId, filename, mime type, and size. Do not describe a picture and call that the file.
3. Call artifact_get with that artifactId. The mime type must be an image type and the size must be greater than 0. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
