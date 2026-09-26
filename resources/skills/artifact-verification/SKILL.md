# Artifact Verification

Accept an artifact only after readback shows a non-empty file of the expected type.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Verify the artifact a tool already returned. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Call artifact_get with that artifactId. Readback must succeed and include the filename and mime type. File size must be greater than 0.
3. Reject a zero-byte artifact, an unreadable artifact, or a wrong-type artifact. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
