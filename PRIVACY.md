# ORVYN Privacy Notice — Repository Summary

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
