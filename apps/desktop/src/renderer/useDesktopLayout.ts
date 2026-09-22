import { useEffect, useMemo, useState } from "react";
import {
  getDesktopLayout,
  setDesktopLayout,
  subscribeDesktopLayout,
  toggleBottomTerminal,
  toggleHelp,
  toggleRightPanel,
  type DesktopLayoutState,
} from "./desktopLayout";

export type { DesktopLayoutState };

export function useDesktopLayout() {
  const [layout, setLayout] = useState<DesktopLayoutState>(getDesktopLayout);
  useEffect(() => subscribeDesktopLayout(setLayout), []);
  return useMemo(
    () => ({
      layout,
      setRightPanelOpen: (rightPanelOpen: boolean) => setDesktopLayout({ rightPanelOpen }),
      setBottomTerminalOpen: (bottomTerminalOpen: boolean) => setDesktopLayout({ bottomTerminalOpen }),
      setBottomTerminalHeight: (bottomTerminalHeight: number) => setDesktopLayout({ bottomTerminalHeight }),
      setHelpOpen: (helpOpen: boolean) => setDesktopLayout({ helpOpen }),
      setWorkspaceLayout: (patch: Partial<DesktopLayoutState>) => setDesktopLayout(patch),
      toggleRightPanel,
      toggleBottomTerminal,
      toggleHelp,
    }),
    [layout]
  );
}
