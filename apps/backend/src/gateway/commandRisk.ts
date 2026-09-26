// apps/backend/src/gateway/commandRisk.ts
//
// How risky a shell command is, for the terminal and for SSH on a server:
//
//   read       looks, never changes: systemctl status, journalctl, df -h,
//              docker ps, cat a config, ss -lntp … → runs without asking
//              (except in the Ask access mode).
//   change     changes something recoverable: restart a service, install a
//              package, edit a config, write a file … → follows the access
//              mode (auto in Full Access, asks otherwise).
//   dangerous  can destroy data or cut off the server: rm -rf, DROP DATABASE,
//              firewall reset/flush, reboot, mkfs … → always asks, whatever
//              the mode, and an earlier "Allow for this mission" never covers it.
//
// A command line is as risky as its riskiest part (`a && b; c | d`).

export type CommandRisk = "read" | "change" | "dangerous";

const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b.*--force|--force\b.*--recursive)/i,
  /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\*|\.\s*$|\/\*)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+[^|]*\bof=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\binit\s+[06]\b/i,
  /\bsystemctl\s+(reboot|poweroff|halt|kexec)\b/i,
  /\bdrop\s+(database|schema|table|user|role)\b/i,
  /\btruncate\s+(table\s+)?\w+/i,
  /\bdelete\s+from\s+\w+\s*(;|$|")/i,
  /\bdropdb\b/i,
  /\bflushall\b|\bflushdb\b/i,
  /\bufw\s+(reset|disable)\b/i,
  /\biptables\s+(-F|--flush|-X|--delete-chain|-P\s+INPUT\s+DROP)/i,
  /\bnft\s+flush\b/i,
  /\bfirewall-cmd\s+.*--(panic-on|complete-reload)/i,
  /\buserdel\b|\bdeluser\b/i,
  /\bpasswd\b/i,
  /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+\/(\s|$)/i,
  /\bchown\s+-R\s+\S+\s+\/(\s|$)/i,
  /\bgit\s+push\s+(.*\s)?(--force|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bdocker\s+(system|volume|image|container)\s+prune\b/i,
  /\bdocker\s+volume\s+rm\b/i,
  /\bdocker(-compose|\s+compose)\s+down\s+.*(-v|--volumes)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bcrontab\s+-r\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/,
  />\s*\/dev\/(sd|nvme|hd|vd)[a-z]/i,
  /\bkill\s+-9\s+1\b/,
  /\bsystemctl\s+(stop|disable|mask)\s+(sshd?|networking|network-manager|systemd-networkd)\b/i,
  /\b(del|erase)\s+\/[sq]\b/i,
  /\b(rd|rmdir)\s+\/s\b/i,
  /\bformat\s+[a-z]:/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bshutdown\s+\/[srp]\b/i,
];

const READ_VERBS = new Set([
  "ls", "ll", "dir", "cat", "type", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "findstr",
  "stat", "file", "wc", "du", "df", "free", "uptime", "w", "who", "whoami", "id", "hostname", "hostnamectl", "uname", "date",
  "timedatectl", "which", "where", "whereis", "pwd", "echo", "printf", "ps", "pgrep", "top", "htop", "vmstat", "iostat",
  "ss", "netstat", "lsof", "ip", "ifconfig", "ipconfig", "ping", "traceroute", "tracepath", "mtr", "dig", "nslookup", "host",
  "journalctl", "dmesg", "lsblk", "blkid", "mount", "findmnt", "lscpu", "lsmem", "lspci", "lsusb", "sensors", "nproc",
  "tasklist", "systeminfo", "getent", "last", "lastlog", "tree", "md5sum", "sha256sum", "diff", "cmp", "jq", "yq", "sort",
  "uniq", "cut", "awk", "column", "env", "printenv", "locale", "test", "true", "sleep",
]);

/** Sub-command verbs that only read, for tools that also have writing verbs. */
const READ_SUBCOMMANDS: Record<string, RegExp> = {
  systemctl: /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|show|cat|get-default|--failed)\b/,
  service: /^\S+\s+status\b/,
  docker: /^(ps|logs|inspect|images|image\s+ls|stats|top|port|version|info|network\s+(ls|inspect)|volume\s+(ls|inspect)|compose\s+(ps|logs|config|ls)|container\s+(ls|inspect|logs))\b/,
  "docker-compose": /^(ps|logs|config)\b/,
  kubectl: /^(get|describe|logs|top|version|explain|api-resources|config\s+view)\b/,
  git: /^(status|log|diff|show|branch|remote(\s+-v)?|rev-parse|describe|blame|ls-files|tag(\s+-l)?)\b/,
  npm: /^(ls|list|view|outdated|audit|-v|--version|config\s+get)\b/,
  pip: /^(list|show|freeze|-V|--version)\b/,
  pip3: /^(list|show|freeze|-V|--version)\b/,
  apt: /^(list|show|search|policy)\b/,
  "apt-cache": /./,
  dpkg: /^(-l|-L|-s|--list|--status)\b/,
  rpm: /^-q/,
  nginx: /^(-t|-T|-v|-V)\b/,
  caddy: /^(validate|version|list-modules)\b/,
  crontab: /^-l\b/,
  ufw: /^status\b/,
  iptables: /^(-L|-S|--list)\b/,
  "firewall-cmd": /^--(list|state|get)/,
  pm2: /^(ls|list|status|logs|describe|show)\b/,
  node: /^(-v|--version|-e\s+["']?console\.log)/,
  python: /^(-V|--version)\b/,
  python3: /^(-V|--version)\b/,
  php: /^(-v|--version|-m|-i)\b/,
  "redis-cli": /^(-h\s+\S+\s+)?(-p\s+\S+\s+)?(ping|info|get|keys|scan|ttl|type|exists|dbsize|config\s+get|client\s+list)\b/i,
  psql: /-c\s+["']?\s*(select|show|\\d|explain)\b/i,
  mysql: /-e\s+["']?\s*(select|show|describe|explain)\b/i,
  curl: /^(?!.*(?:^|\s)(?:-X\s*(?:POST|PUT|DELETE|PATCH)|-d|--data\S*|-F|--form|-T|--upload-file|-o|--output)(?:\s|$))/i,
  wget: /(--spider|-q\s+-O\s*-|-O\s*-)/,
  find: /^(?!.*(-delete|-exec\s+rm|-execdir\s+rm))/,
  sed: /^(-n\s)/,
  tar: /^(-?t|--list)/,
  zcat: /./,
  "Get-Content": /./,
  "Get-ChildItem": /./,
  "Get-Process": /./,
  "Get-Service": /./,
};

function segments(command: string): string[] {
  return command
    .replace(/\\\n/g, " ")
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function segmentRisk(seg: string): CommandRisk {
  let s = seg.replace(/^(sudo(\s+-\S+)*\s+|nohup\s+|time\s+|env\s+\w+=\S+\s+)+/, "").trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  // Writing a file by redirection or tee is a change (reading into /dev/null is not).
  if (/(^|[^0-9&])>{1,2}\s*(?!\/dev\/null|&\d|NUL\b)\S/.test(s) || /\btee\b/.test(s)) return "change";
  const [verb = "", ...rest] = s.split(/\s+/);
  const tail = rest.join(" ");
  const name = verb.replace(/^.*[\\/]/, "");
  const sub = READ_SUBCOMMANDS[name];
  if (sub) return sub.test(tail) ? "read" : "change";
  if (READ_VERBS.has(name) || READ_VERBS.has(name.toLowerCase())) return "read";
  return "change";
}

export function classifyCommand(command: string): CommandRisk {
  const cmd = String(command ?? "").trim();
  if (!cmd) return "change";
  if (DANGEROUS.some((re) => re.test(cmd))) return "dangerous";
  let risk: CommandRisk = "read";
  for (const seg of segments(cmd)) {
    const r = segmentRisk(seg);
    if (r === "change") risk = "change";
  }
  return risk;
}

/** Tools that run a shell command. */
export const COMMAND_TOOL_NAMES = new Set(["terminal", "run_command", "ssh_exec"]);

export function commandOf(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (!COMMAND_TOOL_NAMES.has(toolName)) return null;
  return String(args?.command ?? "");
}

export interface ApprovalDecision {
  ask: boolean;
  /** Always ask; never covered by an earlier "Allow for this mission". */
  dangerous: boolean;
  risk?: CommandRisk;
}

/**
 * Whether a tool call needs the user's approval.
 * - dangerous commands: always ask;
 * - read-only commands: run without asking, unless the access mode is Ask;
 * - everything else: the tool's permission (ask unless the access mode allows it),
 *   or an earlier "Allow for this mission".
 */
export function approvalFor(input: {
  toolName: string;
  args: Record<string, unknown> | undefined;
  permission: "allowed" | "ask" | "denied";
  accessMode?: string;
  approvedForRun: boolean;
}): ApprovalDecision {
  const command = commandOf(input.toolName, input.args);
  if (command === null) return { ask: input.permission === "ask" && !input.approvedForRun, dangerous: false };
  const risk = classifyCommand(command);
  if (risk === "dangerous") return { ask: true, dangerous: true, risk };
  if (risk === "read" && input.accessMode !== "ask") return { ask: false, dangerous: false, risk };
  return { ask: input.permission === "ask" && !input.approvedForRun, dangerous: false, risk };
}
