# Deliver a generated file

Create a real file in ORVYN virtual storage and hand it to the user from Files → Generated.

## Steps

1. Call generate_image, create_document, or artifact_create. Do not write a sandbox path.
2. Succeed only when the tool result includes artifactId and the persisted filename.
3. Tell the user the file is in Files → Generated (virtual file storage). The chat card is Preview / Download / Show in Files.
4. Never invent a filename or a sandbox/artifacts/.../download path.

## Gate

artifact.created with status ready + readable bytes
