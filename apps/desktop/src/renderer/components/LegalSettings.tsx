import React, { useMemo, useState } from "react";

export const LEGAL_VERSION = "2026-10-01";

type Doc = {
  id: string;
  title: string;
  summary: string;
  body: string;
};

const DOCS: Doc[] = [
  {
    id: "eula",
    title: "Software License Agreement",
    summary: "ORVYN is proprietary commercial software licensed by Kernel AI Labs.",
    body: `ORVYN is licensed, not sold. Kernel AI Labs retains ownership of ORVYN, ORION, the software, orchestration systems, interfaces, documentation, and proprietary technology. Users retain ownership of their own project files and other lawful User Content. AI-generated output must be reviewed and validated before reliance. ORVYN may perform agentic actions such as editing files, executing commands, using browsers, connecting to servers, invoking tools, and operating sandboxes when authorized by the selected access mode and applicable approval rules. Third-party models and services may be used to complete requests. Use is subject to the full ORVYN Software License Agreement, applicable subscription or enterprise terms, and law.`,
  },
  {
    id: "privacy",
    title: "Privacy",
    summary: "Explains the categories of information ORVYN may process to provide the service.",
    body: `ORVYN may process account information, prompts, chat messages, project files, source code, documents, images, model requests and responses, tool and agent events, usage information, diagnostics, and credentials supplied for connected services. Information may be processed to provide requested functionality, maintain continuity, secure the service, diagnose failures, enforce entitlements, and support billing. Requests may be routed to third-party AI, cloud, search, or integration providers when needed. Credentials should be scoped to the minimum necessary permissions.`,
  },
  {
    id: "acceptable_use",
    title: "Acceptable Use",
    summary: "Sets restrictions for lawful and authorized use of ORVYN.",
    body: `You may not use ORVYN to violate law, access systems or data without authorization, distribute malware, disrupt services, bypass authentication or security controls, expose credentials or confidential information, infringe third-party rights, facilitate fraud or unlawful surveillance, defeat safety controls, or commercially exploit proprietary ORVYN software without written authorization. Legitimate development, administration, automation, and security testing are permitted when you own the target systems or are authorized to test them.`,
  },
  {
    id: "ai_agent_disclosure",
    title: "AI & Agent Disclosure",
    summary: "Explains model routing, autonomous actions, approvals, and verification.",
    body: `ORVYN uses AI models and agentic software. AI-generated code, analysis, plans, commands, and recommendations may be inaccurate, insecure, incomplete, or unsuitable. ORVYN may dynamically select among supported models and providers. Depending on enabled features and permissions, agents may read or modify files, execute commands, run tests, use browsers or desktop sessions, access connected services, interact with servers, invoke APIs or MCP tools, and perform deployment-related actions. Some actions require explicit approval. Verification reduces risk but does not guarantee correctness.`,
  },
  {
    id: "security",
    title: "Security Policy",
    summary: "How to report suspected ORVYN vulnerabilities.",
    body: `Do not disclose suspected ORVYN vulnerabilities publicly before Kernel AI Labs has had a reasonable opportunity to investigate and remediate them. Use GitHub private security advisories when available or the official Kernel AI Labs / ORVYN support channel. Do not include passwords, API keys, tokens, private keys, customer data, or other secrets in public reports.`,
  },
];

export function LegalSettings({
  acceptance,
  onAccept,
  accepting = false,
}: {
  acceptance?: { version: string; acceptedAt: number } | null;
  onAccept?: () => void;
  accepting?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const acceptedLabel = useMemo(() => {
    if (!acceptance) return "No acceptance recorded for this account.";
    return `Accepted version ${acceptance.version} on ${new Date(acceptance.acceptedAt).toLocaleString()}.`;
  }, [acceptance]);

  return (
    <div style={{ marginTop: 30 }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Legal & Privacy</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 10 }}>
        Current legal version: {LEGAL_VERSION}. Full source documents are also maintained under docs/legal/ and at the repository root.
      </div>
      <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 12 }}>{acceptedLabel}</div>
      {onAccept && (!acceptance || acceptance.version !== LEGAL_VERSION) && (
        <button
          onClick={onAccept}
          disabled={accepting}
          style={{
            background: "#3b5bfd",
            border: "none",
            borderRadius: 6,
            color: "white",
            padding: "6px 12px",
            fontSize: 12,
            cursor: accepting ? "default" : "pointer",
            opacity: accepting ? 0.6 : 1,
            marginBottom: 12,
          }}
        >
          {accepting ? "Recording acceptance…" : "Accept current legal terms"}
        </button>
      )}
      {DOCS.map((doc) => {
        const open = openId === doc.id;
        return (
          <div key={doc.id} style={{ border: "1px solid #1c2330", borderRadius: 6, background: "#0f1420", marginBottom: 8 }}>
            <button
              onClick={() => setOpenId(open ? null : doc.id)}
              style={{
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                color: "#e6e9f0",
                padding: "10px 12px",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{doc.title}</div>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{doc.summary}</div>
            </button>
            {open && (
              <div style={{ borderTop: "1px solid #1c2330", padding: "10px 12px", fontSize: 11.5, lineHeight: 1.55, color: "#c9d1e0", whiteSpace: "pre-wrap" }}>
                {doc.body}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ fontSize: 10.5, opacity: 0.5, lineHeight: 1.5, marginTop: 8 }}>
        These in-app summaries do not replace the complete EULA, Privacy, Acceptable Use, AI disclosure, Security Policy, and third-party notices distributed with ORVYN.
      </div>
    </div>
  );
}
