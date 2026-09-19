// apps/desktop/src/renderer/components/Icons.tsx
// Stroke-based icons at a consistent 1.5px weight, sized by the `size` prop
// and inheriting `currentColor`. Replaces the emoji glyphs, which render
// differently per-OS and read as unfinished.
import React from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconFiles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l.8 1.2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="m21 16-4.5-4.5L9 19" />
  </Svg>
);

export const IconSparkles = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.3l-1.8-5.7L4.5 10.8 10.2 9Z" />
    <path d="M18.5 4v3M20 5.5h-3" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Svg>
);

export const IconGit = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <path d="M6 8.5v7M8.5 6.8A5.5 5.5 0 0 0 15.5 9M18 11.5c0 3-2.5 4.5-6 4.5" />
  </Svg>
);

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 13 4 4L19 7" />
  </Svg>
);

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3v5h5" />
    <path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7Z" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12h15M13 5.5 19.5 12 13 18.5" />
  </Svg>
);

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
  </Svg>
);

export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21.4 11.6 12 21a5 5 0 0 1-7-7l9.5-9.5a3.5 3.5 0 0 1 5 5L10 19" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4.5 10.5 19.5" />
  </Svg>
);

export const IconReport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M15 3v4h4" />
    <path d="M9.5 12h6M9.5 15.5h6M9.5 8.5h3" />
  </Svg>
);

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11 12 4l8 7" />
    <path d="M6 10v9h4v-5h4v5h4v-9" />
  </Svg>
);

export const IconRocket = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" />
    <path d="M13.5 4.5C16 2 20 2.5 20 2.5s.5 4-2 6.5l-4.5 4.5-3-3z" />
    <path d="M9 12 6 11l-2 2 3 1M12 15l1 3 2-2-1-3" />
  </Svg>
);

export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" />
    <circle cx="4.5" cy="12" r="1" />
    <circle cx="4.5" cy="18" r="1" />
  </Svg>
);

export const IconZap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13z" />
  </Svg>
);

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
  </Svg>
);

export const IconServer = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" />
    <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" />
    <path d="M7 7.2h.01M7 16.8h.01" />
  </Svg>
);

export const IconBox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5 12 12l8-4.5M12 12v9" />
  </Svg>
);

export const IconDatabase = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
    <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
    <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
  </Svg>
);

export const IconCloud = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8.5 3.8 3.8 0 0 1 17.5 16H7z" />
  </Svg>
);

export const IconWrench = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 6.5a4 4 0 0 0 5 5L21 19a2 2 0 0 1-3 3l-7.5-1.5a4 4 0 0 0-5-5z" />
    <path d="m10 14-6-6 2-2 6 6" />
  </Svg>
);

export const IconCard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5.5" width="18" height="13" rx="2" />
    <path d="M3 10h18M7 14.5h4" />
  </Svg>
);

export const IconSearchGlass = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);

export const IconAgents = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="6" r="2.5" />
    <circle cx="5.5" cy="17" r="2.5" />
    <circle cx="18.5" cy="17" r="2.5" />
    <path d="M10.5 7.8 7 14.7M13.5 7.8l3.5 6.9M8 17h8" />
  </Svg>
);
