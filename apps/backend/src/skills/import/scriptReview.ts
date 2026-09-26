import * as fs from "fs";
import * as path from "path";

export interface ScriptReview {
  path: string;
  purpose: string;
  inputs: string;
  outputs: string;
  filesystem: string;
  network: boolean;
  mutatesState: boolean;
  highRisk: boolean;
  executable: false;
}

const NETWORK = /\b(requests|urllib|httpx|aiohttp|socket|axios|fetch\(|curl |wget |net\.Dial|http\.Get|http\.Post)\b/i;
const MUTATE = /\b(os\.remove|os\.unlink|shutil\.rmtree|subprocess|os\.system|child_process|\bexec\(|\bspawn\(|fs\.rm|fs\.writeFile|writeFileSync|unlinkSync|write_text|write_bytes)\b|\bopen\([^)\n]{0,80}['"][wa]/i;

function purposeOf(text: string, fileName: string): string {
  const lines = text.split(/\r?\n/).slice(0, 30);
  for (const line of lines) {
    const comment = line.match(/^\s*(?:#|\/\/)\s*(.+)$/)?.[1]?.trim();
    if (comment && !comment.startsWith("!") && comment.length > 8) return comment.slice(0, 180);
  }
  const doc = text.match(/^\s*"""([\s\S]{0,180}?)\n/)?.[1]?.trim();
  if (doc) return doc.replace(/\s+/g, " ").slice(0, 180);
  return `Helper script ${fileName}. Purpose is not declared in a header comment.`;
}

/** Static review only. The file is never executed. */
export function reviewScript(absPath: string, relPath: string): ScriptReview {
  const ext = path.extname(absPath).toLowerCase();
  let text = "";
  try {
    text = fs.readFileSync(absPath, "utf8");
  } catch {
    text = "";
  }
  const network = NETWORK.test(text);
  const mutatesState = MUTATE.test(text) || ext === ".sh" || ext === ".bat" || ext === ".ps1";
  const shell = ext === ".sh" || ext === ".bat" || ext === ".ps1";
  return {
    path: relPath,
    purpose: purposeOf(text, path.basename(absPath)),
    inputs: /argparse|sys\.argv|process\.argv/.test(text) ? "Command-line arguments declared in the script." : "Inputs are not declared.",
    outputs: /print\(|console\.log|write\(/.test(text) ? "The script writes to stdout or to files it names." : "Outputs are not declared.",
    filesystem: /open\(|Path\(|fs\.|os\.path|readFile/.test(text) ? "Touches files named in the script." : "No filesystem access was detected.",
    network: network || shell,
    mutatesState,
    highRisk: network || mutatesState || shell,
    executable: false,
  };
}
