import React, { useCallback, useEffect, useState } from "react";
import { API_URL } from "../config";
import { loadName, loadOrCreatePlayerId, saveName } from "../storage";
import type { LeaderboardEntry, LeaderboardResponse } from "../types";
import { CollectionPage, CollectionState } from "./CollectionPage";

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
  const [nameFeedback, setNameFeedback] = useState("");

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
    if (saving) return;
    const trimmed = name.trim().slice(0, 20);
    setSaving(true);
    setNameFeedback("");
    saveName(trimmed);
    setName(trimmed);

    try {
      const response = await fetch(`${API_URL}/api/name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: loadOrCreatePlayerId(), name: trimmed }),
      });
      if (!response.ok) throw new Error("Name update failed");
      const payload = await response.json();
      setNameFeedback(payload.enabled === false ? "Saved on this device." : "Name saved.");
    } catch {
      setNameFeedback("Saved on this device. Server update unavailable.");
    }

    setSaving(false);
    load(); // refresh the board so the new name shows
  }

  return (
    <CollectionPage
      active="leaderboard"
      title="Leaderboard"
      description="Players ranked by games played."
      count={total > 0 ? `${total} player${total === 1 ? "" : "s"}` : undefined}
    >
      <form className="nameEditor" onSubmit={(event) => {event.preventDefault(); void handleSaveName();}}>
        <div className="nameEditorCopy">
          <label htmlFor="displayName">Your display name</label>
          <p className="nameHint" id="nameHint">Shown on the leaderboard. Leave blank to use {autoName}.</p>
        </div>
        <div className="nameEditorControls">
          <div className="nameEditorRow">
            <input
              id="displayName"
              maxLength={20}
              value={name}
              placeholder={autoName}
              aria-describedby="nameHint nameFeedback"
              onChange={(event) => {
                setName(event.target.value);
                setNameFeedback("");
              }}
            />
            <button className="secondaryButton" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="nameFeedback" id="nameFeedback" role="status">{nameFeedback || "\u00a0"}</p>
        </div>
      </form>

      {state === "loading" && <CollectionState>Loading leaderboard…</CollectionState>}
      {state === "error" && <CollectionState>Couldn't load the leaderboard right now.</CollectionState>}
      {state === "disabled" && <CollectionState>The leaderboard isn't available on this server yet.</CollectionState>}
      {state === "empty" && (
        <CollectionState>
          <p>No games played yet.</p>
          <a className="primaryButton" href="/">Play the first round</a>
        </CollectionState>
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
    </CollectionPage>
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
        Page {page} of {totalPages} · {total} player{total === 1 ? "" : "s"}
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
    <table className="leaderboardList">
      <caption className="srOnly">Players ranked by games played, with read accuracy.</caption>
      <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Games</th><th scope="col">Read accuracy</th></tr></thead>
      <tbody>
      {players.map((player) => (
        <tr key={`${player.rank}:${player.name}`}>
          <td className="leaderboardRank">{player.rank}</td>
          <th scope="row" className="leaderboardName">{player.name}</th>
          <td className="historyMono">{player.games}</td>
          <td className="historyMono">{Math.round(player.readAccuracy * 100)}%</td>
        </tr>
      ))}
      </tbody>
    </table>
  );
}
