# ORVYN Home Visual Parity — approved mockup pass (2026-09-19)

Compared against the approved Home mockup; verified by live window capture.

| Region | Target (mockup) | Current | Diff → fix | Done |
|---|---|---|---|---|
| Right panel on Home | none — dashboard owns full center | ContextPanel showed even when idle | gate to work/editor/terminal only | ✅ |
| Hero background | planetary horizon on left, nebula, stars, network | nebula/stars/network only | added horizon sphere + breathing rim + latitude arcs (calm, static body) | ✅ |
| Hero logo | ORVYN mark centered on dark tile | yes | unchanged | ✅ |
| Greeting | ~28–32px bold | 22px | 27px | ✅ |
| Subtitle | muted 14–16px | 12.5px | close enough at target density | ✅ |
| Composer | wide dark elevated; controls bottom; placeholder exact | matched earlier | placeholder already exact | ✅ |
| Mode pills | compact, purple active | matched | unchanged | ✅ |
| Astra selector | icon + Astra + ORCHESTRATOR + dropdown | plain "Agent: Astra" text | real roster dropdown (Astra selected; workers read-only with live models) | ✅ |
| Run button | purple, icon, disabled when empty | matched | unchanged | ✅ |
| Quick actions | six cards, exact copy ("Plan, code & test" etc.) | longer copy | copy updated to target | ✅ |
| Recent Missions | icon + title + project·mission_id + status + progress + % + time | text-only meta | icon tile + `project · mission_xxxx · steps` | ✅ |
| Connected Systems | recognizable icons, real states | done earlier | unchanged (truthful statuses) | ✅ |
| Utility drawer | COLLAPSED ~30px rail; Open Terminal + expand + resize | always-open 176px | collapsed by default; tab/Open-Terminal expands; pointer-drag resize 120–520px | ✅ |
| Problems | real count on tab | done | unchanged | ✅ |
| Left nav | sections + Current Project card at bottom | no project card | added card: real workspace name + live git branch (or "No project open — Open Project") | ✅ |
| Top bar / status bar | preserved | preserved | unchanged | ✅ |
| Hero lifecycle | pause when Home hidden | unmount cancels rAF | already satisfied | ✅ |

## Capture loop (2026-09-19)

Mandatory loop executed: launch → screenshot → compare → correct → test → package.

- **Capture method**: DPI-aware Win32 capture of the window's DWM visible
  bounds (physical pixels). The first capture used logical 1440×816 while the
  window is 1800×1020 physical at 125% scaling — it clipped the right/bottom
  and produced false "missing drawer/status bar" findings. All findings below
  are from the corrected full-window capture, judged by image analysis.
- **Round 1 findings → fixes**:
  - Planetary rim nearly invisible (α 0.26 @ 1.6px on navy) → stacked
    atmosphere: cyan band (9px), purple band (5px), strong lit rim
    `rgba(139,125,255, α 0.5–0.68)` @ 2.2px, breathing.
  - Quick-action descriptions ellipsized ("Create a workflow…") at 1/6 width
    → descriptions now wrap (11px, line-height 1.35); spec copy unchanged.
  - False positives rejected with cause: "placeholder overlaps greeting"
    (block layout, misread), "badge overlaps progress bar" (flex siblings,
    flexShrink 0), status-bar crowding (consistent 16px gaps).
- **Round 2 verification**: horizon clearly visible (bright purple rim +
  cyan glow), all six descriptions fully readable with no truncation, slim
  tab rail, CURRENT PROJECT card, status bar, no right panel — PASS.
- **Tests/typecheck**: 38 pass / 0 fail (1 pre-existing skip); renderer
  `tsc --noEmit` clean.
- **Package**: `dist:win` rebuilt; asar verified to contain CURRENT PROJECT,
  AGENT ROSTER, Open Terminal, the new rim color and quick-action copy.

Known deviations (honest): search chip `Ctrl+Shift+P` (real binding); node-pty
remains the upgrade for fully interactive terminal TUI (pipes terminal is real
today); credits capsule truthful LOCAL/tokens until the account backend.
