// Canonical legal bundle presented by ORVYN applications.
// Update LEGAL_VERSION whenever any required acceptance document materially changes.

export const LEGAL_VERSION = "2026-10-01";

export const REQUIRED_LEGAL_DOCUMENTS = [
  "eula",
  "privacy",
  "acceptable_use",
  "ai_agent_disclosure",
] as const;

export type RequiredLegalDocument = (typeof REQUIRED_LEGAL_DOCUMENTS)[number];

export interface LegalDocument {
  id: string;
  title: string;
  requiredForAcceptance: boolean;
  content: string;
}

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    id: "eula",
    title: "Software License Agreement",
    requiredForAcceptance: true,
    content: `# ORVYN Software License Agreement

**Effective Date: October 1, 2026**

This Software License Agreement ("Agreement") is between the person or entity
using ORVYN ("you" or "User") and **Kernel AI Labs** ("Kernel AI Labs," "we,"
"us," or "our"). It governs access to and use of the ORVYN desktop software,
cloud services, artificial-intelligence features, agents, APIs, tools,
integrations, and related services (collectively, the "Software").

By installing, accessing, creating an account for, or using ORVYN, you agree
to this Agreement. If you do not agree, do not use the Software.

## 1. License Grant

Subject to this Agreement and applicable subscription or enterprise terms,
Kernel AI Labs grants you a limited, revocable, non-exclusive,
non-transferable, non-sublicensable license to install and use ORVYN for your
personal or authorized business purposes.

The Software is licensed, not sold. No ownership in ORVYN, its source code,
models, orchestration systems, prompts, interfaces, infrastructure,
trademarks, or other proprietary technology transfers to you.

Plan-specific limits may apply, including model access, usage credits,
concurrent agents, cloud compute, API access, storage, seats, and other
service entitlements.

## 2. Ownership

ORVYN and its proprietary software, interfaces, designs, workflows,
orchestration technology, documentation, branding, and related components are
owned by Kernel AI Labs or its licensors and are protected by intellectual
property laws. All rights not expressly granted are reserved.

## 3. User Content and Project Files

You retain ownership of source code, documents, prompts, files, images, data,
and other materials that you lawfully provide to ORVYN ("User Content").

You grant Kernel AI Labs the limited rights reasonably necessary to process
User Content to operate, secure, maintain, and provide the services you
request. You are responsible for having the rights necessary to submit and
process User Content.

Kernel AI Labs does not claim ownership of your project source code solely
because ORVYN processes it.

## 4. AI-Generated Output

ORVYN may generate code, text, configurations, documents, images, analyses,
commands, plans, and other output using artificial-intelligence systems.

Subject to applicable law and third-party rights, Kernel AI Labs does not
claim ownership of AI-generated output created specifically for you through
your use of ORVYN.

AI output can be inaccurate, incomplete, insecure, non-functional, or similar
to output produced for others. You are responsible for reviewing, testing,
validating, and determining whether output is appropriate for your use.

Important code, security changes, production deployments, infrastructure
changes, legal information, financial information, and other high-impact
outputs should be independently reviewed before reliance.

## 5. Agentic and Autonomous Actions

ORVYN may include autonomous or semi-autonomous agents capable of reading and
modifying project files, executing commands, running tests and builds,
interacting with websites and browsers, connecting to servers, using SSH or
remote execution, deploying software, using APIs, installing or invoking
tools, skills, plugins, or MCP servers, and operating sandbox or cloud
environments.

Certain actions may require approval based on access mode, organizational
policy, permissions, or assessed risk. Kernel AI Labs may require confirmation
for or refuse actions that present elevated security, safety, legal,
compliance, or operational risk.

You remain responsible for environments, credentials, systems, repositories,
accounts, and resources that you authorize ORVYN to access.

## 6. Access Modes and Permissions

ORVYN may provide read-only, approval-required, balanced, autonomous,
full-access, or similar permission modes. Your selected mode determines the
authority ORVYN may exercise within supported environments.

Certain high-risk or destructive actions may require explicit approval
regardless of the selected mode.

## 7. Accounts and Credentials

You are responsible for safeguarding your account credentials and for
authorized activity under your account. Do not share credentials contrary to
your subscription or organization terms.

Third-party credentials should be scoped to the minimum permissions necessary.
Promptly notify Kernel AI Labs through official support channels if you
believe an account or credential has been compromised.

## 8. Third-Party AI Models and Services

ORVYN may route requests to third-party AI providers, model hosts, cloud
platforms, infrastructure providers, search providers, APIs, and other
services.

Specific models and providers are not guaranteed. Kernel AI Labs may add,
remove, replace, reroute, or discontinue providers or models while maintaining
the service as reasonably practicable.

Third-party services may be subject to their own terms and privacy practices.

## 9. Tools, Plugins, Skills, and Integrations

ORVYN may support third-party tools, plugins, MCP servers, APIs, extensions,
skills, repositories, and integrations. Kernel AI Labs does not control all
third-party services and is not responsible for their independent operation,
security, availability, accuracy, or data practices.

## 10. Cloud Compute and Remote Execution

ORVYN may provide hosted workers, sandboxes, browser sessions, virtual
desktops, and other compute resources. Such environments may be temporary,
restricted, automatically terminated, or subject to usage limits.

Do not rely on temporary execution environments as the sole storage location
for critical data unless ORVYN expressly identifies the storage as persistent.

## 11. Subscriptions, Credits, and Usage

Paid features may require a subscription, credits, purchased capacity, or
other entitlement. Usage may be measured using factors such as AI model
consumption, token usage, worker time, browser or desktop compute, image
generation, search-provider usage, storage, and third-party API usage.

Billing, renewal, refunds, expiration, and top-up rules are governed by the
terms presented at purchase or in an applicable enterprise agreement.

## 12. Acceptable Use

You may not use ORVYN to violate law; gain unauthorized access to systems,
accounts, devices, or networks; distribute malware; disrupt services;
circumvent security, authentication, authorization, billing, or usage controls;
infringe intellectual-property, privacy, or other rights; or create
unreasonable security, legal, operational, or infrastructure risk.

You may not reverse engineer proprietary ORVYN components except where
applicable law expressly permits it, remove proprietary notices, sublicense or
resell ORVYN without written authorization, or use non-public ORVYN source,
prompts, routing logic, or proprietary technology to build a competing service.

Additional restrictions are stated in ACCEPTABLE_USE.md.

## 13. Updates

Kernel AI Labs may update ORVYN to add features, improve security, modify model
routing, correct defects, or maintain compatibility. Features may be changed,
replaced, or discontinued as the platform evolves.

## 14. Beta and Experimental Features

Features identified as beta, preview, experimental, or early access may
contain errors, change materially, or be discontinued. Do not rely on them for
mission-critical workloads unless expressly approved for production use.

## 15. Security and Backups

ORVYN may use access controls, approval gates, permission profiles,
sandboxing, isolation, and encrypted communications, but no system can
guarantee complete security.

You are responsible for appropriate backups, source-control practices,
disaster recovery, credential management, and access controls for your
projects and infrastructure.

## 16. No Warranty

TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SOFTWARE IS PROVIDED "AS IS" AND
"AS AVAILABLE." KERNEL AI LABS DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED,
INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
NON-INFRINGEMENT, ACCURACY, RELIABILITY, AVAILABILITY, AND ERROR-FREE
OPERATION.

KERNEL AI LABS DOES NOT WARRANT THAT AI-GENERATED OUTPUT WILL BE ACCURATE,
SECURE, COMPLETE, UNIQUE, OR SUITABLE FOR YOUR INTENDED USE.

## 17. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, KERNEL AI LABS AND ITS AFFILIATES,
OFFICERS, EMPLOYEES, CONTRACTORS, PROVIDERS, AND LICENSORS WILL NOT BE LIABLE
FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE
DAMAGES, INCLUDING LOST PROFITS, REVENUE, DATA, BUSINESS OPPORTUNITIES, OR
GOODWILL.

TO THE MAXIMUM EXTENT PERMITTED BY LAW, KERNEL AI LABS' TOTAL AGGREGATE
LIABILITY ARISING FROM OR RELATED TO THE SOFTWARE OR THIS AGREEMENT WILL NOT
EXCEED THE AMOUNT YOU PAID TO KERNEL AI LABS FOR ORVYN DURING THE TWELVE
MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.

Some jurisdictions do not allow certain exclusions or limitations, so parts of
this section may not apply to you.

## 18. Indemnification

To the extent permitted by law, you agree to defend, indemnify, and hold
harmless Kernel AI Labs and its affiliates, personnel, contractors, and
licensors from claims, liabilities, losses, damages, and expenses arising from
your unlawful use of ORVYN, violation of this Agreement, User Content,
violation of third-party rights, or actions performed through systems,
accounts, credentials, or infrastructure you authorized ORVYN to access.

## 19. Suspension and Termination

Kernel AI Labs may suspend or terminate access for material violation of this
Agreement, nonpayment, fraud, abuse, security risk, or unlawful use. You may
stop using ORVYN at any time.

Upon termination, the license ends. Provisions that by their nature should
survive termination remain effective.

## 20. Export and Sanctions Compliance

You may not use, export, re-export, transfer, or make ORVYN available in
violation of applicable export-control, sanctions, or trade laws.

## 21. Governing Law

This Agreement is governed by the laws of the United States and the applicable
laws of the state in which Kernel AI Labs is organized, without regard to
conflict-of-law principles.

Any separately presented dispute-resolution, venue, arbitration, or
class-action-waiver terms apply where valid and applicable.

## 22. Changes to this Agreement

Kernel AI Labs may update this Agreement as ORVYN evolves. Material changes
may be communicated through the application, website, email, account portal,
or another reasonable method. Continued use after the effective date
constitutes acceptance where permitted by law.

## 23. Entire Agreement

This Agreement, together with applicable Terms of Service, Privacy Policy,
billing terms, Acceptable Use Policy, subscription terms, and any enterprise
agreement, governs licensed use of ORVYN. A separately signed agreement
controls to the extent of a conflict.

## 24. Contact

Questions about licensing should be directed through the official Kernel AI
Labs / ORVYN support or account channels.

---

**© 2026 Kernel AI Labs. All rights reserved.**

ORVYN, ORION, Kernel AI Labs, associated logos, and related product names are
trademarks or proprietary marks of Kernel AI Labs or their respective owners.
`,
  },
  {
    id: "privacy",
    title: "Privacy Policy",
    requiredForAcceptance: true,
    content: `# ORVYN Privacy Notice — Repository Summary

**Effective Date: October 1, 2026**

This document summarizes privacy principles relevant to the ORVYN software
repository. The production service should also publish a customer-facing
Privacy Policy describing the actual deployed service, subprocessors,
retention periods, regional requirements, and contact information.

## Information ORVYN may process

Depending on enabled features and the user's instructions, ORVYN may process:

- account and organization information;
- prompts, chat messages, instructions, and feedback;
- project files, source code, documents, images, and other User Content;
- model requests and responses;
- tool, browser, desktop, sandbox, server, and agent execution events;
- usage, billing, entitlement, and credit information;
- device, application, reliability, security, and diagnostic information; and
- credentials or integration tokens supplied for connected services.

## Why information is processed

Information may be processed to provide requested functionality, maintain
session and project continuity, operate agent and model routing, execute tools,
provide connected integrations, secure the service, diagnose failures,
enforce entitlements, and support billing and customer support.

## AI and third-party providers

ORVYN may send information necessary to complete a request to selected AI
model providers, cloud infrastructure providers, search providers, or other
connected services. Only information reasonably required for the selected
feature should be transmitted.

Third-party services may have their own terms and privacy practices.

## Credentials and secrets

Credentials should be limited to the minimum permissions required. ORVYN
components must not intentionally expose secrets in logs, user-visible event
streams, generated artifacts, or public issue reports.

## User Content

Kernel AI Labs does not claim ownership of User Content solely because ORVYN
processes it. Handling of User Content is subject to the applicable EULA,
service terms, enterprise agreement, and production Privacy Policy.

## Retention and deletion

Retention must follow the production service's configured retention,
security, billing, contractual, and legal requirements. Temporary execution
environments should not be treated as permanent storage unless specifically
identified as persistent.

## Security

ORVYN uses technical controls intended to separate tenants, projects,
workspaces, tools, and execution environments. No system is completely secure.
See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Production-policy requirement

Before public commercial launch, Kernel AI Labs should review and publish a
production Privacy Policy that accurately reflects deployed infrastructure,
providers, data flows, retention, deletion, user rights, and applicable
jurisdictions.

This repository summary is not a substitute for that deployment-specific
privacy policy.
`,
  },
  {
    id: "acceptable_use",
    title: "Acceptable Use Policy",
    requiredForAcceptance: true,
    content: `# ORVYN Acceptable Use Policy

**Effective Date: October 1, 2026**

This Acceptable Use Policy applies to use of ORVYN software, agents, tools,
cloud resources, APIs, integrations, and connected environments.

Users may not use ORVYN to:

1. violate applicable law, regulation, sanctions, or court orders;
2. access systems, accounts, devices, networks, data, or credentials without
   authorization;
3. create, deploy, distribute, or operate malware or malicious infrastructure;
4. disrupt, overload, damage, or interfere with systems or services;
5. bypass authentication, authorization, approval, billing, entitlement,
   sandbox, rate-limit, or other security controls;
6. steal, expose, or misuse credentials, secrets, private keys, personal data,
   confidential information, or proprietary information;
7. infringe intellectual-property, privacy, publicity, contractual, or other
   legal rights;
8. use ORVYN to facilitate fraud, impersonation, deceptive abuse, or unlawful
   surveillance;
9. intentionally defeat ORVYN safety controls or use the platform in a manner
   that creates unreasonable security, operational, legal, or infrastructure
   risk; or
10. resell, sublicense, redistribute, or commercially exploit proprietary
    ORVYN software except under written authorization from Kernel AI Labs.

## Authorized security and administrative use

Legitimate development, infrastructure administration, security testing, and
automation are permitted when the user owns the target systems or has explicit
authorization to operate on them.

## High-risk actions

ORVYN may require approval, refuse execution, restrict network access, limit
tool use, isolate execution, or suspend a session when an action presents
elevated security or operational risk.

## Enforcement

Kernel AI Labs may investigate suspected abuse and may restrict, suspend, or
terminate access where reasonably necessary to protect users, systems, the
service, or third parties.

This policy supplements the ORVYN EULA and applicable service or enterprise
terms.
`,
  },
  {
    id: "ai_agent_disclosure",
    title: "AI & Agent Disclosure",
    requiredForAcceptance: true,
    content: `# ORVYN AI and Agent Disclosure

**Effective Date: October 1, 2026**

ORVYN uses artificial-intelligence models and agentic software to assist with
software engineering, research, automation, infrastructure, browser, desktop,
and related tasks.

## AI output is not guaranteed

AI-generated code, text, analysis, plans, commands, configurations, images,
and recommendations may be inaccurate, incomplete, insecure, outdated, or
unsuitable for a particular purpose.

Users should independently review and test important outputs before relying on
them, particularly for production systems, security controls, deployments,
data handling, legal obligations, and other high-impact uses.

## Model routing

ORVYN may dynamically select among supported AI models and providers based on
capability, cost, latency, service health, user settings, plan entitlements,
and task requirements. A specific underlying model or provider is not
guaranteed unless a product feature expressly says otherwise.

## Agent actions

Depending on enabled features and permissions, ORVYN agents may read or modify
files, execute commands, run tests, use browsers, operate desktop sessions,
access connected services, interact with servers, use remote execution,
invoke APIs or MCP tools, and perform deployment-related actions.

## Approval and autonomy

Some actions may require explicit approval. Other actions may execute
automatically when authorized by the selected access mode or organizational
policy. Certain dangerous actions may require approval regardless of the
selected autonomy level.

## Verification

ORVYN may use deterministic checks, tests, browser or desktop evidence, and
independent AI verification before reporting autonomous work as complete.
Verification reduces risk but does not guarantee correctness or security.

## Third-party services

Some requests may be processed through third-party AI, cloud, search, or
integration providers. Their services may be subject to separate terms and
privacy practices.

## User responsibility

Users remain responsible for deciding whether to use, accept, deploy, publish,
or rely on ORVYN output and for maintaining suitable backups, source control,
access controls, and review processes.

This disclosure supplements the ORVYN EULA, Privacy Policy, Acceptable Use
Policy, and any enterprise agreement.
`,
  },
  {
    id: "security",
    title: "Security Policy",
    requiredForAcceptance: false,
    content: `# Security Policy

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
documented separately under \`docs/SECURITY.md\`. This root policy governs how
security issues should be reported.

This policy does not create a bug-bounty program or promise payment.
`,
  },
  {
    id: "notice",
    title: "Proprietary Notice",
    requiredForAcceptance: false,
    content: `# ORVYN Proprietary Notice

Copyright © 2026 Kernel AI Labs. All rights reserved.

ORVYN and ORION are proprietary products of Kernel AI Labs.

Unless a file or component expressly states otherwise, the ORVYN codebase,
documentation, user interface, product designs, orchestration logic, model
routing logic, workflows, and related materials are proprietary and are not
licensed as open-source software.

Access to this repository does not grant a license to reproduce, distribute,
sublicense, sell, host, commercialize, or create competing products from
Kernel AI Labs proprietary materials.

Authorized use is governed by:

- [LICENSE](LICENSE)
- [EULA.md](EULA.md)
- [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)
- [AI_AGENT_DISCLOSURE.md](AI_AGENT_DISCLOSURE.md)
- [PRIVACY.md](PRIVACY.md)

Third-party components remain subject to their respective licenses and notices.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Nothing in this notice modifies or removes third-party license rights.
`,
  },
  {
    id: "third_party",
    title: "Third-Party Notices",
    requiredForAcceptance: false,
    content: `# Third-party notices

## claude-skills

Upstream project: https://github.com/alirezarezvani/claude-skills

Imported skills under \`resources/imported-skills/claude-skills/\` are adapted from that repository. The upstream project is MIT licensed. Copyright remains with the upstream author. This notice and the upstream license terms must stay with those skills.

\`\`\`
MIT License

Copyright (c) 2025 Alireza Rezvani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`

## NVIDIA OpenShell (TypeScript SDK and provider profile)

Upstream project: https://github.com/NVIDIA/OpenShell (tag \`v0.1.2\`)

\`apps/worker/vendor/nvidia-openshell-sdk-0.1.2.tgz\` is the \`@nvidia/openshell-sdk\` package built unmodified from \`sdk/typescript\` at that tag; its \`LICENSE\` file is inside the archive. \`infrastructure/openshell/provider-profiles/orvyn-github.yaml\` is adapted from \`providers/github.yaml\` at the same tag. Both are licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES.
`,
  }
];

export function publicLegalBundle() {
  return {
    version: LEGAL_VERSION,
    requiredDocuments: REQUIRED_LEGAL_DOCUMENTS,
    documents: LEGAL_DOCUMENTS,
  };
}
