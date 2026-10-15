import React, { useEffect, useId, useState } from "react";
import { API_URL } from "../config";
import { loadOrCreatePlayerId } from "../storage";
import type { GameHistoryEntry } from "../types";
import { formatDetail, formatPlayedAt } from "../utils";
import { roundStatus } from "./HistoryDetail";
import { CollectionPage, CollectionState } from "./CollectionPage";
import { HistoryRoundDetails } from "./HistoryRoundDetails";

type LoadState = "loading" | "ready" | "empty" | "disabled" | "error";

export function History() {
  const [state, setState] = useState<LoadState>("loading");
  const [games, setGames] = useState<GameHistoryEntry[]>([]);

  useEffect(() => {
    const playerId = loadOrCreatePlayerId();
    let active = true;

    fetch(`${API_URL}/api/history?playerId=${encodeURIComponent(playerId)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("bad status"))))
      .then((data: { enabled?: boolean; games?: GameHistoryEntry[] }) => {
        if (!active) {
          return;
        }

        if (data.enabled === false) {
          setState("disabled");
          return;
        }

        const list = data.games || [];

        setGames(list);
        setState(list.length ? "ready" : "empty");
      })
      .catch(() => {
        if (active) {
          setState("error");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <CollectionPage
      active="history"
      title="History"
      description="Your finished rounds, reads, and conversations."
      count={state === "ready" ? `${games.length} round${games.length === 1 ? "" : "s"}` : undefined}
    >
      {state === "loading" && <CollectionState>Loading your games…</CollectionState>}
      {state === "error" && <CollectionState>Couldn't load history right now. Try again later.</CollectionState>}
      {state === "disabled" && <CollectionState>History isn't available on this server yet.</CollectionState>}
      {state === "empty" && (
        <CollectionState>
          <p>No finished games yet.</p>
          <a className="primaryButton" href="/">Play your first round</a>
        </CollectionState>
      )}
      {state === "ready" && <HistoryList games={games} />}
    </CollectionPage>
  );
}

function HistoryList({ games }: { games: GameHistoryEntry[] }) {
  return (
    <div className="historyList">
      <div className="historyRow historyHead" aria-hidden="true">
        <span>When</span>
        <span>Opponent</span>
        <span>Read</span>
        <span>Round score</span>
        <span>Detail</span>
        <span />
      </div>
      {games.map((game) => (
        <HistoryRow key={game.sessionId} game={game} />
      ))}
    </div>
  );
}

function HistoryRow({ game }: { game: GameHistoryEntry }) {
  const isHuman = game.opponentType === "Human";
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  return (
    <div className={`historyEntry ${expanded ? "expanded" : ""}`}>
      <button
        className="historyRow historyRowButton"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
      >
        <time className="historyWhen" dateTime={game.playedAt}>{formatPlayedAt(game.playedAt)}</time>
        <span className="historyOpponent">{game.opponentType}</span>
        <span className="historyRead">
          <span className="historyFieldLabel">Read</span>
          <span className="historyReadValue">
            <span className={`historyVerdict ${game.correctIdentity ? "correct" : "wrong"}`}>
              {game.correctIdentity ? "✓ Correct" : "✗ Wrong"}
            </span>
            <span className="historyMono">{formatScore(game.readEarned)}/{game.readPossible}</span>
          </span>
        </span>
        <span className="historyRound">
          <span className="historyFieldLabel">{isHuman ? "Location score" : "Model score"}</span>
          <span className={`historyMono roundStatus-${roundStatus(game)}`}>{formatScore(game.roundEarned)}/{game.roundPossible}</span>
        </span>
        <span className="historyDetail">{formatDetail(game)}</span>
        <span className="historyChevron" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </button>
      {expanded && (
        <div className="historyChat" id={detailsId} role="region" aria-label={`Round details for ${formatPlayedAt(game.playedAt)}`}>
          <HistoryRoundDetails game={game} />
        </div>
      )}
    </div>
  );
}

function formatScore(value: number) {
  return Math.round(value * 10) / 10;
}
