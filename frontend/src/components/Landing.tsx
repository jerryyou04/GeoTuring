import React from "react";
import type { IpLocation, PersistentScore } from "../types";
import { getIpLocationStatusText, hasValidIpLocation } from "../utils";

export function Landing({
  ipLocation,
  locationConsent,
  locationStatus,
  onLocationAgreement,
  onStart,
  persistentScore,
}: {
  ipLocation: IpLocation | null;
  locationConsent: boolean;
  locationStatus: string;
  onLocationAgreement: (agreed: boolean) => void;
  onStart: () => void;
  persistentScore: PersistentScore;
}) {
  const hasLocation = hasValidIpLocation(ipLocation);
  const canUsePrimaryAction = locationConsent && locationStatus !== "checking";

  return (
    <section className="heroPanel">
      <div className="heroCopy">
        <p className="roundLabel">Real-time deduction MVP</p>
        <h2>Chat anonymously with a stranger or a machine.</h2>
        <p>
          Ask a few questions, decide whether your partner is human or AI, then
          make the second guess: place their location on the world map or call
          the model family.
        </p>
        <button className="primaryButton" disabled={!canUsePrimaryAction} onClick={onStart}>
          {locationStatus === "checking" ? "Checking location" : hasLocation ? "Start matchmaking" : "Check location"}
        </button>
      </div>
      <div className="scoreSidebar">
        <IpLocationConsentCard
          agreed={locationConsent}
          location={ipLocation}
          onAgreement={onLocationAgreement}
          status={locationStatus}
        />
        <PersistentScoreboard score={persistentScore} />
        <div className="scorePreview" aria-label="Scoring preview">
          <div>
            <span>Read score</span>
            <strong>0/1 or 1/1</strong>
          </div>
          <div>
            <span>Human round</span>
            <strong>0-100</strong>
          </div>
          <div>
            <span>AI round</span>
            <strong>0/1 or 1/1</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function IpLocationConsentCard({
  agreed,
  location,
  onAgreement,
  status,
}: {
  agreed: boolean;
  location: IpLocation | null;
  onAgreement: (agreed: boolean) => void;
  status: string;
}) {
  const statusText = getIpLocationStatusText(status, agreed, location);

  return (
    <aside className="locationCard" aria-label="Rough location">
      <div>
        <p className="roundLabel">Rough location consent</p>
        <strong>{location ? location.country : agreed ? "Checking IP" : "Required"}</strong>
        <span>{statusText}</span>
      </div>
      <label className="consentCheck">
        <input
          checked={agreed}
          onChange={(event) => onAgreement(event.target.checked)}
          type="checkbox"
        />
        <span>I agree to a rough IP-based location check while playing.</span>
      </label>
    </aside>
  );
}

function PersistentScoreboard({ score }: { score: PersistentScore }) {
  const readPercent =
    score.readPossible === 0 ? 0 : Math.round((score.readEarned / score.readPossible) * 100);
  const humanAverage =
    score.humanPossible === 0 ? 0 : Math.round((score.humanEarned / score.humanPossible) * 100);
  const aiPercent = score.aiPossible === 0 ? 0 : Math.round((score.aiEarned / score.aiPossible) * 100);

  return (
    <aside className="persistentScore" aria-label="Persistent score">
      <p className="roundLabel">Your scoreboard</p>
      <div className="persistentScoreRows">
        <ScoreLine label="Reads" value={`${score.readEarned}/${score.readPossible}`} detail={`${readPercent}%`} />
        <ScoreLine label="Human score" value={`${score.humanEarned}/${score.humanPossible}`} detail={`${humanAverage}% avg`} />
        <ScoreLine label="AI score" value={`${score.aiEarned}/${score.aiPossible}`} detail={`${aiPercent}%`} />
      </div>
    </aside>
  );
}

function ScoreLine({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
