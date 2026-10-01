# SSH Server Operations

Use only a server that the user has explicitly connected.

1. Call ssh_exec with the configured server alias (the resource id is server:<alias> from the workspace SSH allowlist) and a non-empty command. Never call ssh_exec with an empty host or an empty command.
2. If no server is configured, or the alias is unknown, stop before SSH. Ask the user to open **Servers → Add server**. If their message already includes an IP or hostname, carry it into that connection flow; never run against it until the user confirms the target.
3. Credentials must be entered through the server connection/vault UI, never repeated into chat or placed in `.orvyn/ssh.json`. Ask whether the credential is for this session, this mission, or saved for later tasks on that server.
4. Do not put passwords, private keys, or tokens in the command or the reply. Credentials stay in the vault-backed server resource. Do not print them.
5. Status and file reads are diagnostic. Restarts and installs are mutating and follow the access profile. rm -rf, reboot, shutdown, and firewall flush wait for approval.
6. After a mutating command, run a follow-up check and report both outputs. Do not treat a zero exit as a healthy service.
