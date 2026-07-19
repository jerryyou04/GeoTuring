import React, { useCallback, useEffect, useState } from "react";
import { API_URL } from "../config";
import { loadName, loadOrCreatePlayerId, saveName } from "../storage";
import type { LeaderboardEntry, LeaderboardResponse } from "../types";
import { HistoryIcon, LeaderboardIcon } from "./NavIcons";

type LoadState = "loading" | "ready" | "empty" | "disabled" | "error";
const LEADERBOARD_PAGE_SIZE = 25;

export function Leaderboard() {
  const [state, setState] = useState<LoadState>("loading");
  const [players, setPlayers] = useState<LeaderboardEntry[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [name, setName] = useState(() => loadName());
  const [saving, setSaving] = useState(false);

  const autoName = `Player-${loadOrCreatePlayerId().slice(0, 4)}`;

  const load = useCallback(() => {
    let active = true;
    setState("loading");

    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(LEADERBOARD_PAGE_SIZE),
    });

    fetch(`${API_URL}/api/leaderboard?${params.toString()}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("bad status"))))
      .then((data: LeaderboardResponse) => {
        if (!active) {
          return;
        }

        if (data.enabled === false) {
          setPlayers([]);
          setTotal(0);
          setTotalPages(0);
          setState("disabled");
          return;
        }

        const list = data.players || [];
        const responseTotal = Number.isFinite(data.total) ? data.total : list.length;
        const responseTotalPages = Number.isFinite(data.totalPages)
          ? data.totalPages
          : Math.ceil(responseTotal / LEADERBOARD_PAGE_SIZE);
        const responsePage = Number.isFinite(data.page) ? Math.max(1, data.page) : page;

        if (responsePage !== page) {
          setPage(responsePage);
          return;
        }

        setPlayers(list);
        setTotal(responseTotal);
        setTotalPages(responseTotalPages);
        setState(responseTotal > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (active) {
          setState("error");
        }
      });

    return () => {
      active = false;
    };
  }, [page]);

  useEffect(() => load(), [load]);

  async function handleSaveName() {
    const trimmed = name.trim().slice(0, 20);
    setSaving(true);
    saveName(trimmed);

    try {
      await fetch(`${API_URL}/api/name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: loadOrCreatePlayerId(), name: trimmed }),
      });
    } catch {
      // Name is still saved locally; ignore network failure.
    }

    setSaving(false);
    load(); // refresh the board so the new name shows
  }

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
          <a className="navItem" href="/history">
            <span className="navIcon ghost"><HistoryIcon /></span>
            History
          </a>
          <a className="navItem active" href="/leaderboard">
            <span className="navIcon ghost"><LeaderboardIcon /></span>
            Leaderboard
          </a>
        </nav>
      </aside>

      <main className="appMain">
        <header className="topbar">
          <div>
            <p className="eyebrow">Most games played</p>
            <h1>Leaderboard</h1>
          </div>
        </header>

        <section className="gamePanel historyPanel">
          <div className="nameEditor">
            <label htmlFor="displayName">Your display name</label>
            <div className="nameEditorRow">
              <input
                id="displayName"
                maxLength={20}
                value={name}
                placeholder={autoName}
                onChange={(event) => setName(event.target.value)}
              />
              <button className="secondaryButton" type="button" disabled={saving} onClick={handleSaveName}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="nameHint">Shown on the leaderboard. Leave blank to use your auto-name ({autoName}).</p>
          </div>

          {state === "loading" && <p className="historyNote">Loading leaderboard…</p>}
          {state === "error" && <p className="historyNote">Couldn't load the leaderboard right now.</p>}
          {state === "disabled" && (
            <p className="historyNote">The leaderboard isn't set up on the server yet.</p>
          )}
          {state === "empty" && (
            <div className="historyNote">
              <p>No games played yet.</p>
              <a className="primaryButton" href="/">Play the first round</a>
            </div>
          )}
          {state === "ready" && (
            <>
              <LeaderboardList players={players} />
              <LeaderboardPager
                page={page}
                total={total}
                totalPages={totalPages}
                onPageChange={(nextPage) => {
                  setState("loading");
                  setPage(nextPage);
                }}
              />
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function LeaderboardPager({
  page,
  total,
  totalPages,
  onPageChange,
}: {
  page: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <nav className="leaderboardPager" aria-label="Leaderboard pages">
      <button
        className="secondaryButton"
        disabled={page <= 1}
        onClick={() => onPageChange(Math.max(1, page - 1))}
        type="button"
      >
        Previous
      </button>
      <span aria-live="polite">
        Page {page} of {totalPages} ({total} player{total === 1 ? "" : "s"})
      </span>
      <button
        className="secondaryButton"
        disabled={page >= totalPages}
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        type="button"
      >
        Next
      </button>
    </nav>
  );
}

function LeaderboardList({ players }: { players: LeaderboardEntry[] }) {
  return (
    <div className="leaderboardList">
      <div className="leaderboardRow leaderboardHead">
        <span>#</span>
        <span>Player</span>
        <span>Games</span>
        <span>Read accuracy</span>
      </div>
      {players.map((player) => (
        <div className="leaderboardRow" key={`${player.rank}:${player.name}`}>
          <span className="leaderboardRank">{player.rank}</span>
          <span className="leaderboardName">{player.name}</span>
          <span className="historyMono">{player.games}</span>
          <span className="historyMono">{Math.round(player.readAccuracy * 100)}%</span>
        </div>
      ))}
    </div>
  );
}
