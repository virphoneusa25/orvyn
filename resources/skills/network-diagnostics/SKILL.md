# Network Diagnostics

Separate a dead app from a dead path.

1. On a configured server alias, use ssh_exec for ss, ip route, and a DNS lookup. Locally, use terminal. Check the endpoint with fetch_url. Never call ssh_exec with an empty host.
2. Report listeners, the resolved address, and the HTTP or TLS result you actually received. Do not invent ports or hostnames.
3. These checks are diagnostic. Do not change firewall rules, routes, or DNS in this skill.
4. Say whether the application failed or the network failed, and cite the check that shows which one.
