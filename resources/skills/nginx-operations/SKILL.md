# Nginx Operations

Test the config before you reload.

1. Read the relevant server block with read_file locally, or ssh_exec on a configured server alias. Never call ssh_exec with an empty host. Do not invent upstream hosts or ports.
2. Where nginx is installed, run nginx -t before reload. If the test fails, do not reload.
3. Check that the upstream is reachable before blaming the proxy. A config edit and nginx reload are mutating and follow the access profile.
4. After a repair, verify with systemctl status nginx and fetch_url or a local request. Do not claim the site is up from the reload exit alone.
