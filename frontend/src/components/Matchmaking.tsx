import React from "react";
import type { QueueStatus } from "../types";
import { formatSeconds } from "../utils";

export function Matchmaking({
  actualSeconds,
  connectedProfiles,
  estimatedSeconds,
  requiredProfiles,
  status,
}: {
  actualSeconds: number;
  connectedProfiles: number;
  estimatedSeconds: number;
  requiredProfiles: number;
  status: QueueStatus;
}) {
  const isFound = status === "found";

  return (
    <section className={`queuePanel ${isFound ? "matchFound" : ""}`}>
      <div className="queueFrame">
        <div className="queueHeader">
          <h2>{isFound ? "Match found!" : "Finding match"}</h2>
        </div>

        <div className="summonerSlots" aria-label={`${connectedProfiles} of ${requiredProfiles} profiles connected`}>
          <ProfileSlot label="You" active={connectedProfiles >= 1} />
          <ProfileSlot label="Unknown" active={connectedProfiles >= 2} />
        </div>

        <div className="queueMeter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (connectedProfiles / requiredProfiles) * 100)}%` }} />
        </div>

        <div className="queueStatusLine">
          <strong>
            {Math.min(connectedProfiles, requiredProfiles)}/{requiredProfiles} profiles connected
          </strong>
          <span>{isFound ? "Entering game..." : "Searching for a worthy opponent"}</span>
        </div>

        <div className="queueTimes">
          <div>
            <span>Actual Queue Time</span>
            <strong>{formatSeconds(actualSeconds)}</strong>
          </div>
          <div>
            <span>Estimated Queue Time</span>
            <strong>{formatSeconds(estimatedSeconds)}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProfileSlot({ active, label }: { active: boolean; label: string }) {
  return (
    <div className={`profileSlot ${active ? "active" : ""}`}>
      <div className="portrait">
        {active ? <span className="profileIcon" /> : <span className="unknownIcon">?</span>}
      </div>
      <strong>{active ? label : "Waiting..."}</strong>
      <small>{active ? "Connected" : "Pending"}</small>
    </div>
  );
}
