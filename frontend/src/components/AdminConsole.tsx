import React, { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ADMIN_API_PATH,
  ADMIN_TOKEN_STORAGE_KEY,
  API_URL,
} from "../config";
import type {
  AdminHistoryEntry,
  AdminHistoryResponse,
  AdminRoom,
  AdminSnapshot,
} from "../types";
import {
  formatAiSource,
  formatAiState,
  formatDetail,
  formatMs,
  formatPlayedAt,
  formatTimestamp,
  locationText,
  shortSocketId,
} from "../utils";
import { StatusPill } from "./StatusPill";
import { TranscriptView } from "./TranscriptView";
import { GuessSummary, roundStatus } from "./HistoryDetail";

export function AdminConsole() {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "");
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(token ? "Connecting" : "Locked");

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;

    async function loadRooms() {
      try {
        const response = await fetch(`${API_URL}${ADMIN_API_PATH}/rooms`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.status === 401) {
          sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
          setToken("");
          setSnapshot(null);
          setStatus("Locked");
          setError("Admin session expired. Log in again.");
          return;
        }

        if (!response.ok) {
          throw new Error(`Room snapshot failed with ${response.status}`);
        }

        const payload = (await response.json()) as AdminSnapshot;

        if (!cancelled) {
          setSnapshot(payload);
          setStatus("Live");
          setError("");
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus("Offline");
          setError(loadError instanceof Error ? loadError.message : "Could not load rooms.");
        }
      }
    }

    loadRooms();
    const timer = window.setInterval(loadRooms, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Checking");
    setError("");

    try {
      const response = await fetch(`${API_URL}${ADMIN_API_PATH}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || `Login failed with ${response.status}`);
      }

      sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, payload.token);
      setToken(payload.token);
      setPassword("");
      setStatus("Live");
    } catch (loginError) {
      setStatus("Locked");
      setError(loginError instanceof Error ? loginError.message : "Login failed.");
    }
  }

  function logout() {
    sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    setToken("");
    setSnapshot(null);
    setStatus("Locked");
  }

  return (
    <main className="appShell adminShell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Operations console</p>
          <h1>Room monitor</h1>
        </div>
        <div className="adminTopActions">
          <StatusPill value={status} />
          {token && (
            <button className="secondaryButton" onClick={logout}>
              Log out
            </button>
          )}
        </div>
      </header>

      {!token ? (
        <section className="centerPanel adminLogin">
          <p className="roundLabel">Admin login</p>
          <h2>Enter the monitor password.</h2>
          <form onSubmit={login}>
            <input
              autoComplete="current-password"
              autoFocus
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              type="password"
              value={password}
            />
            <button className="primaryButton" disabled={!password} type="submit">
              Unlock
            </button>
          </form>
          {error && <p className="adminError">{error}</p>}
        </section>
      ) : (
        <AdminDashboard error={error} snapshot={snapshot} token={token} />
      )}
    </main>
  );
}

function AdminDashboard({
  error,
  snapshot,
  token,
}: {
  error: string;
  snapshot: AdminSnapshot | null;
  token: string;
}) {
  return (
    <section className="adminDashboard">
      <div className="adminSummary">
        <AdminMetric label="Active rooms" value={snapshot ? snapshot.rooms.length : 0} />
        <AdminMetric label="Waiting players" value={snapshot ? snapshot.waiting.length : 0} />
        <AdminMetric label="Last refresh" value={snapshot ? formatTimestamp(snapshot.generatedAt) : "Pending"} />
      </div>

      {error && <p className="adminError">{error}</p>}

      {snapshot && snapshot.waiting.length > 0 && (
        <section className="adminPanel">
          <div className="adminPanelHeader">
            <p className="roundLabel">Queue</p>
            <h2>Waiting players</h2>
          </div>
          <div className="adminQueueList">
            {snapshot.waiting.map((entry) => (
              <div className="adminQueueRow" key={entry.socketId}>
                <strong>{shortSocketId(entry.socketId)}</strong>
                <span>{entry.connected ? "Connected" : "Disconnected"}</span>
                <span>{locationText(entry.location)}</span>
                <time>{formatTimestamp(entry.queuedAt)}</time>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="adminRooms">
        {snapshot?.rooms.length ? (
          snapshot.rooms.map((room) => <AdminRoomCard key={room.id} room={room} />)
        ) : (
          <div className="adminPanel emptyRooms">
            <p className="roundLabel">Rooms</p>
            <h2>No active rooms.</h2>
          </div>
        )}
      </section>

      <AdminHistoryPanel token={token} />
    </section>
  );
}

const HISTORY_PAGE_SIZE = 25;

function AdminHistoryPanel({ token }: { token: string }) {
  const [page, setPage] = useState(1);
  const [filterInput, setFilterInput] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [data, setData] = useState<AdminHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(HISTORY_PAGE_SIZE),
    });

    if (appliedFilter) {
      params.set("playerId", appliedFilter);
    }

    fetch(`${API_URL}${ADMIN_API_PATH}/history?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`status ${response.status}`))))
      .then((payload: AdminHistoryResponse) => {
        if (!cancelled) {
          setData(payload);
          setError("");
          setLoading(false);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Could not load history.");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token, page, appliedFilter]);

  function applyFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAppliedFilter(filterInput.trim());
  }

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const games = data?.games ?? [];
  const dbDisabled = data ? data.enabled === false : false;

  // Human-vs-human games store two rows under one session id. When both
  // perspectives land on the same page, mark them as a matched pair.
  const sessionCounts = new Map<string, number>();
  games.forEach((game) => sessionCounts.set(game.sessionId, (sessionCounts.get(game.sessionId) || 0) + 1));
  const pairedSessions = new Set(
    [...sessionCounts.entries()].filter(([, count]) => count > 1).map(([sessionId]) => sessionId),
  );

  return (
    <section className="adminPanel adminHistory">
      <div className="adminPanelHeader">
        <div>
          <p className="roundLabel">Archive</p>
          <h2>Game history</h2>
        </div>
        <form className="adminHistoryFilter" onSubmit={applyFilter}>
          <input
            onChange={(event) => setFilterInput(event.target.value)}
            placeholder="Filter by player id…"
            value={filterInput}
          />
          <button className="secondaryButton" type="submit">Search</button>
          {appliedFilter && (
            <button
              className="secondaryButton"
              type="button"
              onClick={() => {
                setFilterInput("");
                setAppliedFilter("");
                setPage(1);
              }}
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {dbDisabled ? (
        <p className="emptyTranscript">History storage isn't configured on the server.</p>
      ) : error ? (
        <p className="adminError">{error}</p>
      ) : loading && !data ? (
        <p className="emptyTranscript">Loading history…</p>
      ) : games.length === 0 ? (
        <p className="emptyTranscript">No games recorded{appliedFilter ? " for that player" : ""} yet.</p>
      ) : (
        <>
          <div className="adminHistoryList">
            {games.map((game) => (
              <AdminHistoryRow
                key={`${game.playerId}:${game.sessionId}`}
                game={game}
                pairedOnPage={pairedSessions.has(game.sessionId)}
              />
            ))}
          </div>

          <div className="adminHistoryPager">
            <button
              className="secondaryButton"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              type="button"
            >
              ← Prev
            </button>
            <span>
              Page {page} of {totalPages} · {total} game{total === 1 ? "" : "s"}
            </span>
            <button
              className="secondaryButton"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              type="button"
            >
              Next →
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function AdminHistoryRow({ game, pairedOnPage }: { game: AdminHistoryEntry; pairedOnPage: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isHuman = game.opponentType === "Human";
  const messageCount = game.messageCount ?? game.transcript?.length ?? 0;

  return (
    <div className={`adminHistoryEntry ${expanded ? "expanded" : ""} ${pairedOnPage ? "paired" : ""}`}>
      <button
        className="adminHistoryRow"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="adminHistoryWhen">{formatPlayedAt(game.playedAt)}</span>
        <code className="adminHistoryPlayer">{game.playerId}</code>
        <span className="adminHistoryTagCell">
          <span className={`historyTag ${isHuman ? "human" : "ai"}`}>{game.opponentType}</span>
          {isHuman && (
            <span
              className={`historyLinkGlyph ${pairedOnPage ? "matched" : ""}`}
              title={
                pairedOnPage
                  ? "Same human-vs-human chat — both perspectives are on this page"
                  : "Human-vs-human chat — the other player's perspective is a separate entry"
              }
              aria-label="Two-perspective human chat"
            >
              ⇌
            </span>
          )}
        </span>
        <span className="historyMono">read {round1(game.readEarned)}/{game.readPossible}</span>
        <span className={`historyVerdict ${game.correctIdentity ? "correct" : "wrong"}`}>
          {game.correctIdentity ? "✓" : "✗"}
        </span>
        <span className={`historyMono roundStatus-${roundStatus(game)}`}>
          {round1(game.roundEarned)}/{game.roundPossible}
        </span>
        <span className="historyDetail">{formatDetail(game)}</span>
        <span className="adminHistoryCount">{messageCount} msg{expanded ? " ▾" : " ▸"}</span>
      </button>
      {expanded && (
        <div className="historyChat">
          <GuessSummary game={game} />
          <TranscriptView
            transcript={game.transcript}
            partnerLabel={isHuman ? "Opponent" : game.modelFamily || "AI"}
          />
        </div>
      )}
    </div>
  );
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function AdminMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AdminRoomCard({ room }: { room: AdminRoom }) {
  return (
    <article className="adminPanel roomCard">
      <div className="adminPanelHeader">
        <div>
          <p className="roundLabel">{room.mode === "human" ? "Human room" : "AI room"}</p>
          <h2>{room.id}</h2>
        </div>
        <div className="roomTimes">
          <span>Created {formatTimestamp(room.createdAt)}</span>
          <span>Ends {formatTimestamp(room.chatEndsAt)}</span>
        </div>
      </div>

      {room.aiResponseStatus && (
        <div className={`aiAdminStatus ${room.aiResponseStatus.failed ? "failed" : ""}`}>
          <div>
            <span>AI status</span>
            <strong>{formatAiState(room.aiResponseStatus.state)}</strong>
          </div>
          <div>
            <span>Source</span>
            <strong>{formatAiSource(room.aiResponseStatus.source)}</strong>
          </div>
          {room.aiResponseStatus.delayMs !== null && (
            <div>
              <span>Typing delay</span>
              <strong>{formatMs(room.aiResponseStatus.delayMs)}</strong>
            </div>
          )}
          {room.aiResponseStatus.error && (
            <div className="aiAdminError">
              <span>Failure</span>
              <strong>{room.aiResponseStatus.error}</strong>
            </div>
          )}
          {room.aiResponseStatus.responseText && (
            <div className="aiAdminResponse">
              <span>Exact response</span>
              <strong>{room.aiResponseStatus.responseText}</strong>
            </div>
          )}
        </div>
      )}

      <div className="participantGrid">
        {room.participants.map((participant) => (
          <div className="participantCard" key={`${room.id}:${participant.label}`}>
            <div>
              <strong>{participant.label}</strong>
              <span>{participant.type}</span>
            </div>
            <small>{participant.socketId ? shortSocketId(participant.socketId) : participant.modelFamily}</small>
            <small>{participant.location ? locationText(participant.location) : "Model family monitor"}</small>
            <div className="adminFlags">
              <span>{participant.submitted ? "Submitted" : "Open"}</span>
              <span>{participant.disconnected ? "Left" : "Connected"}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="transcript">
        {room.messages.length ? (
          room.messages.map((message) => (
            <div className="transcriptMessage" key={message.id}>
              <div>
                <strong>{message.authorLabel}</strong>
                <time>{formatTimestamp(message.sentAt)}</time>
              </div>
              {message.ai && (
                <div className={`aiTranscriptMeta ${message.ai.failed ? "failed" : ""}`}>
                  <span>{formatAiSource(message.ai.source)}</span>
                  <span>{message.ai.failed ? "Fallback after failure" : "Delivered"}</span>
                  <span>{formatMs(message.ai.typingDelayMs)} delay</span>
                  {message.ai.error && <span>{message.ai.error}</span>}
                </div>
              )}
              <p>{message.text}</p>
            </div>
          ))
        ) : (
          <p className="emptyTranscript">No chat messages yet.</p>
        )}
      </div>
    </article>
  );
}
