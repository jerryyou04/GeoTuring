import React, { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ADMIN_API_PATH,
  ADMIN_TOKEN_STORAGE_KEY,
  API_URL,
} from "../config";
import type { AdminRoom, AdminSnapshot } from "../types";
import {
  formatAiSource,
  formatAiState,
  formatMs,
  formatTimestamp,
  locationText,
  shortSocketId,
} from "../utils";
import { StatusPill } from "./StatusPill";

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
        <AdminDashboard error={error} snapshot={snapshot} />
      )}
    </main>
  );
}

function AdminDashboard({ error, snapshot }: { error: string; snapshot: AdminSnapshot | null }) {
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
    </section>
  );
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
