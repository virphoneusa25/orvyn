# Image Editing

Edit only an existing image artifact, and do not invent a replacement.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Require an existing image target. Find it with artifact_list and artifact_get. If no source artifactId comes back, stop. Do not invent a target.
3. Preserve the areas the user said to leave unchanged. No registered tool accepts that source image as an edit input, so do not call another tool to fake an edit and do not invent an edited artifact.
4. An edited artifact passes only when a tool result returns a new artifactId and artifact_get reads it back with size greater than 0. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
