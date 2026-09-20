// apps/desktop/src/renderer/components/redesign/RedesignPreview.tsx
// Renders both redesigned screens with the mockup's demo data, fully clickable:
// click a mission title / "Review" to open the detail, "Missions" to go back.
// Use it to see the design in the real app, then wire real data (README).
import React, { useState } from "react";
import type { ViewId } from "../Navigation";
import { HomeScreen } from "./HomeScreen";
import { MissionDetail } from "./MissionDetail";
import { IconRail, Sidebar, StatusFooter } from "./Shell";
import {
  demoMission,
  demoMissions,
  demoStatus,
  demoSystems,
  demoUsage,
  demoUser,
  demoWorkspace,
} from "./demoData";

export function RedesignPreview() {
  const [view, setView] = useState<ViewId>("home");
  const [openMission, setOpenMission] = useState<string | null>(null);
  const needsYou = demoMissions.filter((m) => ["approval", "blocked", "paused"].includes(m.tone)).length;

  const navigate = (v: ViewId) => {
    setView(v);
    setOpenMission(null);
  };

  return (
    <div className="ov-app">
      <div className="ov-body">
        {openMission ? (
          <>
            <IconRail view="missions" onChange={navigate} />
            <MissionDetail
              mission={demoMission}
              onBack={() => setOpenMission(null)}
              onApprove={(id, remember) => console.log("approve", id, { remember })}
              onDeny={(id) => console.log("deny", id)}
              onReply={(t) => console.log("reply", t)}
            />
          </>
        ) : (
          <>
            <Sidebar
              view={view}
              onChange={navigate}
              workspace={demoWorkspace}
              user={demoUser}
              usage={demoUsage}
              missionsNeedingYou={needsYou}
            />
            <HomeScreen
              userName={demoUser.name}
              workspaceName={demoWorkspace.name}
              status={demoStatus}
              missions={demoMissions}
              systems={demoSystems}
              onRun={(prompt, mode) => console.log("run", { prompt, mode })}
              onOpenMission={(id) => setOpenMission(id)}
              onMissionAction={(id) => setOpenMission(id)}
            />
          </>
        )}
      </div>
      {!openMission && <StatusFooter status={demoStatus} />}
    </div>
  );
}
