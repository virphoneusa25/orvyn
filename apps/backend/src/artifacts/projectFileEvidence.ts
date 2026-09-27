import { promises as fs } from "fs";
import path from "path";
import { sha256Hex, validateBytes } from "./bytes";
import { mediaTypeForName } from "./ArtifactService";
import { resolveSafePath } from "../execution/pathSafety";

export interface ProjectFileEvidence {
  projectRoot: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  exists: true;
  readable: true;
  sha256: string;
  createdAt: string;
}

/** Reads the written bytes from the actual workspace before reporting success. */
export async function verifyProjectFile(projectRoot: string, relativePath: string, expected?: Buffer): Promise<ProjectFileEvidence> {
  const absolute = resolveSafePath(projectRoot, relativePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error(`Project path is not a file: ${relativePath}`);
  const bytes = await fs.readFile(absolute);
  if (expected && !bytes.equals(expected)) throw new Error(`Project file read-back mismatch: ${relativePath}`);
  const name = path.basename(absolute);
  const mimeType = mediaTypeForName(name);
  if (mimeType.startsWith("image/")) validateBytes(name, mimeType, bytes);
  return {
    projectRoot: path.resolve(projectRoot), path: path.relative(projectRoot, absolute).replace(/\\/g, "/"),
    name, mimeType, size: bytes.length, exists: true, readable: true,
    sha256: sha256Hex(bytes), createdAt: new Date().toISOString(),
  };
}
