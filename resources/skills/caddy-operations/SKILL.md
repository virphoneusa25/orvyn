# Caddy Operations

Read the Caddyfile and the service before you reload.

1. Inspect the Caddyfile, systemctl status caddy, and a short log excerpt with ssh_exec on a configured server alias, or read_file and terminal when Caddy is local. Never call ssh_exec with an empty host.
2. Where caddy is installed, validate the config before reload. If validate fails, do not reload.
3. A Caddyfile edit and reload are mutating and follow the access profile. Do not replace certificates or disable TLS unless the user asked.
4. After a change, verify the HTTP or TLS endpoint with fetch_url and the service status. A successful reload is not proof the site answers.
