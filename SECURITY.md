# Security Policy

## Reporting a vulnerability

Please do not disclose suspected ORVYN vulnerabilities publicly before Kernel
AI Labs has had a reasonable opportunity to investigate and remediate them.

Use GitHub's private security-advisory mechanism for this repository when
available, or use the official Kernel AI Labs / ORVYN support channel.

Include, where possible:

- affected ORVYN version or commit;
- impacted component;
- reproduction steps;
- expected and observed behavior;
- security impact;
- logs or screenshots with secrets removed; and
- any suggested mitigation.

Do not include passwords, API keys, tokens, private keys, customer data, or
other secrets in public issues.

## Scope

Security reports may include issues involving:

- authentication or authorization;
- tenant or workspace isolation;
- sandbox escape or execution-boundary bypass;
- approval-gate bypass;
- remote worker or Tool RPC authentication;
- secret exposure;
- unsafe file-path traversal;
- browser or desktop session isolation;
- MCP/tool permission bypass;
- billing or entitlement bypass; and
- unintended cross-user data access.

## Safe research expectations

Security testing must use systems and accounts you own or are authorized to
test. Do not disrupt production services, access another user's data, perform
denial-of-service testing, or use social engineering.

## Supported versions

Kernel AI Labs prioritizes the current production release and actively
supported release branches. Older development snapshots may not receive
security fixes.

## Security architecture

Technical security architecture and known engineering limitations are
documented separately under `docs/SECURITY.md`. This root policy governs how
security issues should be reported.

This policy does not create a bug-bounty program or promise payment.
