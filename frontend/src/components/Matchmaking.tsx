import React from "react";
import type { QueueStatus } from "../types";
import { formatSeconds } from "../utils";
import { PanelHeading } from "./PanelHeading";

export function Matchmaking({
  actualSeconds,
  connectedProfiles,
  requiredProfiles,
  status,
}: {
  actualSeconds: number;
  connectedProfiles: number;
  requiredProfiles: number;
  status: QueueStatus;
}) {
  const isFound = status === "found";

  return (
    <section className={`queuePanel ${isFound ? "matchFound" : ""}`}>
      <div className="queueFrame">
        <PanelHeading title={isFound ? "Match found" : "Finding an opponent"} description={isFound ? "Your conversation will begin shortly." : "Keep this page open while we connect you."} />

        <div className="summonerSlots" aria-label={`${connectedProfiles} of ${requiredProfiles} profiles connected`}>
          <ProfileSlot label="You" active={connectedProfiles >= 1} />
          <ProfileSlot label="Opponent" active={connectedProfiles >= 2} />
        </div>

        <div className="queueMeter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (connectedProfiles / requiredProfiles) * 100)}%` }} />
        </div>

        <div className="queueStatusLine" role="status">
          <strong>
            {Math.min(connectedProfiles, requiredProfiles)}/{requiredProfiles} profiles connected
          </strong>
          <span>{isFound ? "Starting conversation…" : "Waiting for a connection…"}</span>
        </div>

        <div className="queueTimes">
          <div>
            <span>Time in queue</span>
            <strong>{formatSeconds(actualSeconds)}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProfileSlot({ active, label }: { active: boolean; label: string }) {
  return (
    <div className={`profileSlot ${active ? "active" : ""}`}>
      <span className="profileDot" aria-hidden="true" />
      <strong>{label}</strong>
      <small>{active ? "Connected" : "Waiting"}</small>
    </div>
  );
}
