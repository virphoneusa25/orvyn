# Presentation Builder

Create a real PPTX slide deck with one layout and verify the artifact.

1. Do not invent a filename, an artifactId, a sandbox path, or a download URL. Use the registered tools so the file is persisted. Do not bypass artifact persistence. Do not embed billing or provider pricing.
2. Call create_document with a .pptx name and a slides array. Use the same title and body layout on every slide. Keep each title and body short enough that the text does not overflow the slide. That file is the presentation artifact, not a markdown outline.
3. Call artifact_get with the returned artifactId and read_document on that deck. Completion requires persisted bytes and a successful readback. A zero-byte artifact does not pass.
