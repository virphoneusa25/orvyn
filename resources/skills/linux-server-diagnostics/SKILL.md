# Linux Server Diagnostics

Inspect the machine before changing it.

1. On a configured server alias, use ssh_exec for read-only checks (uptime, free, df, ps, ss, systemctl status, a short journal excerpt). On the local machine, use terminal. Never call ssh_exec with an empty host.
2. Identify a cause only when that output supports it. Do not invent hostnames, users, ports, or resource ids.
3. Leave the box unchanged unless the evidence shows a repair is required. Restarts and package installs are mutating and follow the access profile. Reboot, shutdown, and rm -rf wait for explicit approval.
4. If you do change something, rerun the check that failed and report both outputs. A zero exit is not health.
