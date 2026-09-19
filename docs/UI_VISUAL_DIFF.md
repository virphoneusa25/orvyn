# ORVYN UI Visual Diff — correction pass 2026-09-19

Method: rebuilt → launched packaged app → captured the live window
(`docs/ui-orvyn-window.png`) → reviewed against the approved mockup.
One earlier capture pass was invalid (screen capture had focused a Chrome
tab whose *title* contains "ORVYN"); the corrected capture is the real app
window and is the basis of this diff.

## Fixed in this pass (verified in capture)

- **Hero**: flat greeting → prominent hero panel with radial purple
  illumination, subtle SVG node network, centered ORVYN mark, centered
  greeting/subtitle, large elevated composer with mode chips, Astra label,
  purple Run button.
- **Quick actions**: text rectangles → six cards in ONE row, colored icon
  tiles (purple/red/cyan/green/blue/amber), consistent height, hover lift.
- **Home grid**: stacked panels → Recent Missions (≈62%) and Connected
  Systems (≈38%) side by side; rows upgraded to ID · steps · status badge ·
  progress bar · % · relative time; system rows get icon tiles + status dots.
- **Terminal dock**: restored to the Home composition — the real activity
  feed (BottomPanel) is docked in the lower center pane.
- **Header**: usage capsule + purple LOCAL capsule + notification icon +
  dividers + avatar circle ("O") with truthful "Local Mode / connect
  account →" — approved visual shapes, honest content.
- **Navigation**: 222px, section headers, selected item = purple left bar +
  tinted background + accented icon; ACCOUNT pinned to the bottom.
- **Right panel**: Astra identity row (mark, "Astra AI", ORCHESTRATOR badge,
  New Chat) added beneath the tabs.
- **Vertical fit**: hero/quick/panels/dock compose within the viewport.

## Remaining (accepted or future)

- Search bar chip reads `Ctrl+Shift+P` (the working binding). The mockup
  shows `Ctrl+K`; that key is the editor's inline-AI edit and is preserved.
- Interactive Terminal/Logs/Problems tabs beyond Agent Activity need a pty
  backend (documented gap; no fake tabs rendered).
- Header menu spacing can tighten ~2px; sub-pixel font antialiasing differs
  from the mockup (generated image vs. live text) — acceptable.
- Credits/plan capsules show truthful local data until the commercial
  account backend exists.
