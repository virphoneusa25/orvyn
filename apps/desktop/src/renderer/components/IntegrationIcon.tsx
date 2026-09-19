// apps/desktop/src/renderer/components/IntegrationIcon.tsx
//
// Recognizable integration marks, centralized so provider iconography lives
// in one mapping instead of scattered SVGs. Marks are simplified line
// renditions in each brand's color — no hotlinked images, no emoji.
import React from "react";
import appIconFallback from "../assets/icon.png";

export type IntegrationProvider =
  | "orvyn"
  | "github"
  | "docker"
  | "postgresql"
  | "stripe"
  | "ovh"
  | "server"
  | "api";

export function IntegrationIcon({ provider, size = 30 }: { provider: IntegrationProvider; size?: number }) {
  switch (provider) {
    // The classic GitHub octocat silhouette.
    case "github":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="#E6EDF7" aria-label="GitHub">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
        </svg>
      );

    // Docker: the stacked containers silhouette in Docker blue.
    case "docker":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Docker">
          <g fill="#1D63ED">
            <rect x="3" y="10" width="3" height="3" />
            <rect x="7" y="10" width="3" height="3" />
            <rect x="11" y="10" width="3" height="3" />
            <rect x="15" y="10" width="3" height="3" />
            <rect x="7" y="6.5" width="3" height="3" />
            <rect x="11" y="6.5" width="3" height="3" />
            <rect x="11" y="3" width="3" height="3" />
            <path d="M2 14.5h17.5c-.2 2.2-1.6 4.4-4 5.5-2 1-4.6 1-6.7.1C5.6 18.9 3.6 16.7 2 14.5z" />
            <path d="M21 13.2c.9.2 1.6 1 2 1.9-.9.5-1.9.6-2.8.3-.2-.8-.1-1.6.8-2.2z" opacity="0.85" />
          </g>
        </svg>
      );

    // PostgreSQL: the elephant head glyph in PG blue.
    case "postgresql":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="PostgreSQL">
          <path
            d="M17.4 3.4c-.7-.5-2.2-.8-3.6-.7-1.5.1-3.1.5-4.1 1.2-.3.2-.6.5-.9.9-1 .1-2.2.5-2.9 1.6C4.6 8.2 4.9 12 5.6 15c.3 1.4.7 2.9 1.6 3.6.4.3 1.2.4 1.7-.3.5-.8 1-1.9 1.6-2.5 1 .6 2 1 3.4 1 1.4 0 2.4-.4 3.4-1 .6.6 1.1 1.7 1.6 2.5.5.7 1.3.6 1.7.3.9-.7 1.3-2.2 1.6-3.6.7-3 1-6.8-.3-8.6-.7-1.1-1.9-1.5-2.9-1.6-.3-.4-.6-.7-.9-.9-.3-.2-.7-.4-1.1-.5z"
            stroke="#699ECA"
            strokeWidth="1.4"
          />
          <circle cx="9" cy="10" r="1.1" fill="#699ECA" />
          <circle cx="15" cy="10" r="1.1" fill="#699ECA" />
        </svg>
      );

    // Stripe wordmark "S" in Stripe indigo.
    case "stripe":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Stripe">
          <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="#635BFF" />
          <path
            d="M15.6 11.4c-.4-.2-1-.3-1.6-.3-.8 0-1.2.2-1.2.6 0 .9 3.3.5 3.3 2.7 0 1.4-1.2 2.1-2.9 2.1-.9 0-1.8-.2-2.4-.5l.4-1.5c.5.3 1.3.5 2 .5.8 0 1.3-.2 1.3-.7 0-1-3.4-.6-3.4-2.7 0-1.3 1.1-2 2.8-2 .9 0 1.7.2 2.2.4l-.5 1.4zM10.2 8.4l-1.9.4v6.9c0 1.3.9 2.1 2.3 2.1.5 0 1-.1 1.2-.2v-1.5c-.2.1-.5.1-.8.1-.5 0-.8-.2-.8-.8v-2.9h1.6v-1.6h-1.6V8.4z"
            fill="#fff"
          />
        </svg>
      );

    // OVH: the stylized O.
    case "ovh":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="OVHcloud">
          <circle cx="12" cy="12" r="8.6" stroke="#0000CC" strokeWidth="2.2" />
          <path d="M7 12h3.2M14 12h3" stroke="#0000CC" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );

    // A rack server for generic SSH hosts.
    case "server":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#22D3EE" strokeWidth="1.5" aria-label="Server">
          <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" />
          <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" />
          <path d="M7 7.2h.01M7 16.8h.01" strokeLinecap="round" strokeWidth="2" />
        </svg>
      );

    case "api":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#4DA3FF" strokeWidth="1.5" aria-label="API">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9 9l6 6M15 9l-6 6" strokeLinecap="round" />
        </svg>
      );

    // ORVYN's own mark — the app icon.
    case "orvyn":
    default:
      return (
        <img
          src={appIconFallback}
          alt="ORVYN"
          width={size}
          height={size}
          style={{ borderRadius: Math.round(size * 0.26), display: "block" }}
        />
      );
  }
}
