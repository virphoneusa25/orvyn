# SSH Server Operations

Use only a server that is already configured.

1. Call ssh_exec with the configured server alias (the resource id is server:<alias> from the workspace SSH allowlist) and a non-empty command. Never call ssh_exec with an empty host or an empty command.
2. If no server is configured, or the alias is unknown, stop. Say that no server is connected and that SSH was not called. Do not invent a hostname, user, port, key, or resource id.
3. Do not put passwords, private keys, or tokens in the command or the reply. Credentials stay on the configured server resource. Do not print them.
4. Status and file reads are diagnostic. Restarts and installs are mutating and follow the access profile. rm -rf, reboot, shutdown, and firewall flush wait for approval.
5. After a mutating command, run a follow-up check and report both outputs. Do not treat a zero exit as a healthy service.
