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
    <section className="heroPanel" aria-label="New game">
      <header className="landingIntroduction">
        <h1 className="landingIntro">Your opponent could be a person or an AI. Ask a few questions and see what gives them away.</h1>
      </header>
      <ol className="playSteps" aria-label="How to play">
        <li>
          <h2>Chat anonymously</h2>
          <p>Take turns with your opponent. You have a little over two minutes to find the tell.</p>
        </li>
        <li>
          <h2>Make your read</h2>
          <p>Decide who you were talking to: human or AI.</p>
        </li>
        <li>
          <h2>Go one step further</h2>
          <p>Human? Pin their rough location. AI? Pick the model: ChatGPT, Claude, Gemini, or Grok.</p>
        </li>
      </ol>
      <div className="playSetup">
        <IpLocationConsentCard
          agreed={locationConsent}
          location={ipLocation}
          onAgreement={onLocationAgreement}
          status={locationStatus}
        />
        <button className="primaryButton" type="button" disabled={!canUsePrimaryAction} onClick={onStart} aria-describedby="locationStatus">
          {locationStatus === "checking" ? "Checking location…" : hasLocation ? "Start matchmaking" : "Check location"}
        </button>
      </div>
      <PersistentScoreboard score={persistentScore} />
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
    <div className="locationConsent">
      <div className="locationExplanation">
        <h2>Share your rough location</h2>
        <p>The location guess uses a rough estimate from your IP address.</p>
      </div>
      <div className="locationStatus" id="locationStatus" role="status">
        <span>{hasValidIpLocation(location) ? location?.country : status === "checking" ? "Checking location…" : status === "unavailable" || status === "invalid" ? "Location unavailable" : "Location required"}</span>
        <p>{statusText}</p>
      </div>
      <label className="consentCheck">
        <input
          checked={agreed}
          onChange={(event) => onAgreement(event.target.checked)}
          type="checkbox"
        />
        <span>I agree to a rough IP-based location check while playing.</span>
      </label>
    </div>
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
      <div className="scoreboardHeader">
        <h2>Your scoreboard</h2>
        <p>Saved on this device</p>
      </div>
      <dl className="persistentScoreRows">
        <ScoreLine label="Reads" value={`${score.readEarned}/${score.readPossible}`} detail={`${readPercent}%`} />
        <ScoreLine label="Human score" value={`${roundScore(score.humanEarned)}/${score.humanPossible}`} detail={`${humanAverage}%`} />
        <ScoreLine label="AI score" value={`${score.aiEarned}/${score.aiPossible}`} detail={`${aiPercent}%`} />
      </dl>
    </aside>
  );
}

function roundScore(value: number) {
  return Math.round(value * 10) / 10;
}

function ScoreLine({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><strong>{value}</strong>{detail && <span>{detail}</span>}</dd>
    </div>
  );
}
