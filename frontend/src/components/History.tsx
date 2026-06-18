import React, { useEffect, useState } from "react";
import { API_URL } from "../config";
import { loadOrCreatePlayerId } from "../storage";
import type { GameHistoryEntry } from "../types";
import { TranscriptView } from "./TranscriptView";
import { GuessSummary, roundStatus } from "./HistoryDetail";

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
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brandMark" src="/geoturing-logo.png" alt="GeoTuring logo" />
          <div className="brandText">
            <strong>GeoTuring</strong>
          </div>
        </div>
        <nav className="sidebarNav">
          <a className="navItem primary" href="/">
            <span className="navIcon">+</span>
            New game
          </a>
          <a className="navItem active" href="/history">
            <span className="navIcon ghost" aria-hidden="true">↺</span>
            History
          </a>
          <a className="navItem" href="/leaderboard">
            <span className="navIcon ghost" aria-hidden="true">★</span>
            Leaderboard
          </a>
        </nav>
      </aside>

      <main className="appMain">
        <header className="topbar">
          <div>
            <p className="eyebrow">Your games</p>
            <h1>History</h1>
          </div>
        </header>

        <section className="gamePanel historyPanel">
          {state === "loading" && <p className="historyNote">Loading your games…</p>}
          {state === "error" && <p className="historyNote">Couldn't load history right now. Try again later.</p>}
          {state === "disabled" && (
            <p className="historyNote">History storage isn't configured on the server yet.</p>
          )}
          {state === "empty" && (
            <div className="historyNote">
              <p>No finished games yet.</p>
              <a className="primaryButton" href="/">Play your first round</a>
            </div>
          )}
          {state === "ready" && <HistoryList games={games} />}
        </section>
      </main>
    </div>
  );
}

function HistoryList({ games }: { games: GameHistoryEntry[] }) {
  return (
    <div className="historyList">
      <div className="historyRow historyHead">
        <span>When</span>
        <span>Opponent</span>
        <span>Your read</span>
        <span>Identity</span>
        <span>Round</span>
        <span>Detail</span>
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
  const messageCount = game.messageCount ?? game.transcript?.length ?? 0;

  return (
    <div className={`historyEntry ${expanded ? "expanded" : ""}`}>
      <button
        className="historyRow historyRowButton"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="historyWhen">{formatPlayedAt(game.playedAt)}</span>
        <span>
          <span className={`historyTag ${isHuman ? "human" : "ai"}`}>{game.opponentType}</span>
        </span>
        <span className="historyMono">{formatScore(game.readEarned)}/{game.readPossible}</span>
        <span className={`historyVerdict ${game.correctIdentity ? "correct" : "wrong"}`}>
          {game.correctIdentity ? "✓ Correct" : "✗ Wrong"}
        </span>
        <span className={`historyMono roundStatus-${roundStatus(game)}`}>
          {formatScore(game.roundEarned)}/{game.roundPossible}
        </span>
        <span className="historyDetail">
          {formatDetail(game)}
          <span className="historyChevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </span>
      </button>
      {expanded && (
        <div className="historyChat">
          <GuessSummary game={game} />
          <p className="historyChatMeta">
            {messageCount > 0 ? `${messageCount} message${messageCount === 1 ? "" : "s"}` : "Transcript"}
          </p>
          <TranscriptView
            transcript={game.transcript}
            partnerLabel={isHuman ? "Opponent" : game.modelFamily || "AI"}
          />
        </div>
      )}
    </div>
  );
}

function formatDetail(game: GameHistoryEntry) {
  if (game.opponentType === "AI") {
    if (!game.modelFamily) {
      return "AI opponent";
    }

    if (!game.modelFamilyGuess) {
      return `Was ${game.modelFamily}`;
    }

    return game.modelFamilyGuess === game.modelFamily
      ? `${game.modelFamily} ✓`
      : `Guessed ${game.modelFamilyGuess} · was ${game.modelFamily}`;
  }

  const place = [game.actualRegion, game.actualCountry].filter(Boolean).join(", ");
  const distance = game.distanceKm === null ? null : `${game.distanceKm.toLocaleString()} km off`;

  return [place, distance].filter(Boolean).join(" · ") || "Human opponent";
}

function formatScore(value: number) {
  return Math.round(value * 10) / 10;
}

function formatPlayedAt(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
