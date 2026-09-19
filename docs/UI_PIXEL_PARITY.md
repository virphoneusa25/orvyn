# ORVYN UI Pixel Parity — pass 1 measurements (2026-09-19)

Compared at the app window's actual size (1440×816 logical ≈ target aspect).
Target values derive from the approved mockup; current values from the live
capture (`docs/ui-parity-pass1.png`, reviewed programmatically).

| Region | Target (mockup) | Current (pass 1) | Δ / verdict |
|---|---|---|---|
| TopBar | ~56–64px, search centered, credits/plan/user right | 52px, search centered, usage + LOCAL + bell + avatar | aligned; height token `--orvyn-topbar-height` |
| Left nav | ~215–230px; starts Home/New Task/Missions/Automations; sections WORK/INFRA/INFRA/AI/ACCOUNT bottom | 222px; Chats item REMOVED; Home selected w/ purple bar; ACCOUNT pinned | parity |
| Center | minmax(0,1fr); no horizontal scroll; never under AI panel | quick grid `repeat(6, minmax(0,1fr))` — **all six cards fully visible, no scrollbar** | fixed |
| Hero | ~290–320px; glow + network; centered logo/greeting/composer | 46px logo, 22px greeting, composer ≤760px, paddings 26/20 | parity |
| Quick actions | one row of six, icon tiles, ~60–64px tall | one row, colored tiles, minmax(0,1fr) | fixed (was clipped) |
| Missions/Systems | side-by-side ≈62/38, aligned bottoms | grid `minmax(0,62fr) minmax(0,38fr)` | parity |
| Bottom work panel | tab bar Terminal/Logs/Build Output/Agent Activity/Problems; Terminal default; modest height | BottomWorkPanel 176px, Terminal default (honest no-pty state), real activity feed, problems count badge | fixed (was giant AGENT ACTIVITY) |
| Right AI panel | ~390–430px; tabs; Astra identity; composer | 400px default (resizable), identity row, Build empty state added | parity |
| StatusBar | 28–34px; connection/version left; CPU RAM Disk agents missions right | 28px; live CPU/RAM/Disk via new `system:getStats` IPC (real samples) | parity |

## Verified in pass-1 capture

- All six quick-action cards fully visible in one row; nothing under the AI panel
- No horizontal scrollbar anywhere in the center workspace
- Nav begins at Home (no Chats item); ACCOUNT pinned bottom
- Bottom tab bar present with **Terminal** active by default
- Hero glow/network/logo/composer intact
- Status bar shows live CPU/RAM/Disk + agents + missions

## Known intentional deviations

- Search chip reads `Ctrl+Shift+P` (real binding; `Ctrl+K` remains inline-AI edit)
- Terminal tab shows a truthful "needs pty backend" pane — real agent output
  lives in Agent Activity; nothing simulated
- Credits capsule shows metered tokens + LOCAL (truthful) until the account
  backend exists
