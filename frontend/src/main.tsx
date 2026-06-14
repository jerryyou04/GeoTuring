import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import { io, Socket } from "socket.io-client";
import "leaflet/dist/leaflet.css";
import "./styles.css";

type Phase = "landing" | "matching" | "chat" | "identity" | "humanGuess" | "aiGuess" | "reveal";
type IdentityGuess = "Human" | "AI";
type ModelFamily = "ChatGPT" | "Gemini" | "Claude" | "Grok";
type QueueStatus = "idle" | "searching" | "found";

interface ChatMessage {
  id: string;
  author: "player" | "partner" | "system";
  text: string;
  sentAt: number;
}

interface SessionCreatedPayload {
  sessionId: string;
  chatEndsAt: number;
  chatSeconds: number;
  intro: string;
}

interface QueueStatusPayload {
  connectedProfiles: number;
  requiredProfiles: number;
  status: QueueStatus;
  queuedAt: number;
  estimatedSeconds: number;
}

interface QueueErrorPayload {
  code?: string;
  message?: string;
}

interface ResultPayload {
  sessionId: string;
  correctIdentity: boolean;
  score: {
    read: {
      earned: number;
      possible: number;
    };
    round: {
      earned: number;
      possible: number;
      type: "location" | "modelFamily";
    };
  };
  distanceKm: number | null;
  guess: {
    identityGuess: IdentityGuess;
    locationGuess: Pin | null;
    modelFamilyGuess: ModelFamily | null;
  };
  actual: {
    participantType: IdentityGuess;
    region?: string;
    country?: string;
    lat?: number;
    lng?: number;
    modelFamily?: ModelFamily;
  };
  explanation: string;
}

interface Pin {
  lat: number;
  lng: number;
}

interface PersistentScore {
  readEarned: number;
  readPossible: number;
  humanEarned: number;
  humanPossible: number;
  aiEarned: number;
  aiPossible: number;
}

interface IpLocation {
  country: string;
  region: string;
  city: string;
  lat: number | null;
  lng: number | null;
  source: "ip";
  updatedAt: number;
}

interface AdminSnapshot {
  generatedAt: number;
  waiting: AdminWaitingEntry[];
  rooms: AdminRoom[];
}

interface AdminLocation {
  country?: string;
  region?: string;
  city?: string;
  lat: number | null;
  lng: number | null;
  source?: "ip";
  updatedAt?: number;
}

interface AdminWaitingEntry {
  socketId: string;
  connected: boolean;
  queuedAt: number;
  location: AdminLocation;
}

interface AdminParticipant {
  label: string;
  socketId: string | null;
  type: IdentityGuess;
  location?: AdminLocation;
  modelFamily?: ModelFamily;
  submitted: boolean;
  disconnected: boolean;
}

interface AdminRoom {
  id: string;
  mode: "human" | "ai";
  createdAt: number;
  chatEndsAt: number;
  participants: AdminParticipant[];
  messages: AdminTranscriptMessage[];
}

interface AdminTranscriptMessage {
  id: string;
  author: string;
  authorLabel: string;
  text: string;
  sentAt: number;
}

const API_URL = resolveServiceUrl(
  import.meta.env.NEXT_PUBLIC_API_URL || import.meta.env.VITE_API_URL,
);

const SOCKET_URL = resolveServiceUrl(
  import.meta.env.NEXT_PUBLIC_SOCKET_URL || import.meta.env.VITE_SOCKET_URL || API_URL,
);

const MODEL_FAMILIES: ModelFamily[] = ["ChatGPT", "Gemini", "Claude", "Grok"];
const SCORE_STORAGE_KEY = "geoturing:scoreboard:v1";
const LOCATION_CONSENT_STORAGE_KEY = "geoturing:location-consent:v1";
const IP_LOCATION_STORAGE_KEY = "geoturing:ip-location:v1";
const ADMIN_CONSOLE_PATH = "/host-monitor";
const ADMIN_API_PATH = "/admin/host-monitor";
const ADMIN_TOKEN_STORAGE_KEY = "geoturing:admin-token:v1";
const EMPTY_PERSISTENT_SCORE: PersistentScore = {
  readEarned: 0,
  readPossible: 0,
  humanEarned: 0,
  humanPossible: 0,
  aiEarned: 0,
  aiPossible: 0,
};
const QUEUE_FOUND_DELAY_MS = 2400;
const MATCH_FOUND_HOLD_MS = 1800;
const GUESS_MARKER = L.divIcon({
  className: "guessMarker",
  html: "<span></span>",
  iconSize: [34, 44],
  iconAnchor: [17, 42],
});

function App() {
  return window.location.pathname === ADMIN_CONSOLE_PATH ? <AdminConsole /> : <GameApp />;
}

function GameApp() {
  const socketRef = useRef<Socket | null>(null);
  const queueStartedAtRef = useRef<number | null>(null);
  const queueTimersRef = useRef<number[]>([]);
  const scoredSessionsRef = useRef<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>("landing");
  const [connection, setConnection] = useState("idle");
  const [sessionId, setSessionId] = useState("");
  const [chatEndsAt, setChatEndsAt] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [identityGuess, setIdentityGuess] = useState<IdentityGuess | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [modelGuess, setModelGuess] = useState<ModelFamily | null>(null);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [now, setNow] = useState(Date.now());
  const [queueStatus, setQueueStatus] = useState<QueueStatus>("idle");
  const [connectedProfiles, setConnectedProfiles] = useState(0);
  const [requiredProfiles, setRequiredProfiles] = useState(2);
  const [queueStartedAt, setQueueStartedAt] = useState<number | null>(null);
  const [estimatedQueueSeconds, setEstimatedQueueSeconds] = useState(8);
  const [persistentScore, setPersistentScore] = useState<PersistentScore>(() => loadPersistentScore());
  const [locationConsent, setLocationConsent] = useState(() => loadLocationConsent());
  const [ipLocation, setIpLocation] = useState<IpLocation | null>(() => loadIpLocation());
  const [locationStatus, setLocationStatus] = useState("idle");

  const secondsLeft = useMemo(() => {
    if (!chatEndsAt) {
      return 0;
    }

    return Math.max(0, Math.ceil((chatEndsAt - now) / 1000));
  }, [chatEndsAt, now]);

  const actualQueueSeconds = useMemo(() => {
    if (!queueStartedAt) {
      return 0;
    }

    return Math.max(0, Math.floor((now - queueStartedAt) / 1000));
  }, [now, queueStartedAt]);

  useEffect(() => {
    if (phase !== "chat" && phase !== "matching") {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 500);

    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase === "chat" && chatEndsAt && secondsLeft === 0) {
      setPhase("identity");
    }
  }, [chatEndsAt, phase, secondsLeft]);

  useEffect(() => {
    if (locationConsent && !ipLocation && locationStatus === "idle") {
      fetchIpLocation();
    }
  }, [locationConsent, ipLocation, locationStatus]);

  useEffect(() => {
    return () => {
      clearQueueUiTimers();
      socketRef.current?.disconnect();
    };
  }, []);

  function clearQueueUiTimers() {
    queueTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    queueTimersRef.current = [];
  }

  function startMatchmaking() {
    if (!locationConsent) {
      setLocationStatus("required");
      return;
    }

    if (!hasValidIpLocation(ipLocation)) {
      setLocationStatus(ipLocation ? "invalid" : "required");
      fetchIpLocation();
      return;
    }

    clearQueueUiTimers();

    const queuedAt = Date.now();

    setPhase("matching");
    setConnection("connecting");
    setResult(null);
    setIdentityGuess(null);
    setPin(null);
    setModelGuess(null);
    setMessages([]);
    setQueueStatus("searching");
    setConnectedProfiles(1);
    setRequiredProfiles(2);
    setQueueStartedAt(queuedAt);
    queueStartedAtRef.current = queuedAt;
    setEstimatedQueueSeconds(8);
    setNow(queuedAt);

    socketRef.current?.disconnect();
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnection("connected");
      socket.emit("queue:join", {
        location: locationConsent ? ipLocation : null,
      });
    });

    socket.on("disconnect", () => {
      setConnection("disconnected");
    });

    socket.on("queue:status", (payload: QueueStatusPayload) => {
      setQueueStatus(payload.status);
      setConnectedProfiles(payload.connectedProfiles);
      setRequiredProfiles(payload.requiredProfiles);
      setQueueStartedAt(payload.queuedAt);
      queueStartedAtRef.current = payload.queuedAt;
      setEstimatedQueueSeconds(payload.estimatedSeconds);
    });

    socket.on("queue:error", (payload: QueueErrorPayload) => {
      clearQueueUiTimers();
      socket.disconnect();
      setPhase("landing");
      setConnection("idle");
      setLocationStatus(payload.code === "location_required" ? "invalid" : "unavailable");
    });

    socket.on("session:created", (payload: SessionCreatedPayload) => {
      queueTimersRef.current.push(
        window.setTimeout(() => enterChat(payload), getQueueTransitionDelay()),
      );
    });

    socket.on("partner:message", (payload: { message: ChatMessage }) => {
      setMessages((current) => [...current, payload.message]);
    });

    socket.on("partner:left", (payload: { message?: string }) => {
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "Your partner disconnected. You can still make your guess.",
          sentAt: Date.now(),
        },
      ]);
    });

    socket.on("session:result", (payload: ResultPayload) => {
      recordPersistentScore(payload);
      setResult(payload);
      setPhase("reveal");
    });

    socket.on("connect_error", () => {
      setConnection("offline");
    });
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();

    if (!text || !sessionId || phase !== "chat") {
      return;
    }

    setMessages((current) => [
      ...current,
      {
        id: `${Date.now()}`,
        author: "player",
        text,
        sentAt: Date.now(),
      },
    ]);
    socketRef.current?.emit("chat:message", {
      sessionId,
      text,
    });
    setDraft("");
  }

  function chooseIdentity(value: IdentityGuess) {
    setIdentityGuess(value);
    setPhase(value === "Human" ? "humanGuess" : "aiGuess");
  }

  function submitGuess(nextModelGuess = modelGuess) {
    if (!identityGuess || !sessionId) {
      return;
    }

    socketRef.current?.emit("guess:submit", {
      sessionId,
      identityGuess,
      locationGuess: identityGuess === "Human" ? pin : null,
      modelFamilyGuess: identityGuess === "AI" ? nextModelGuess : null,
    });
  }

  function restart() {
    clearQueueUiTimers();
    socketRef.current?.disconnect();
    setPhase("landing");
    setConnection("idle");
    setSessionId("");
    setChatEndsAt(null);
    setMessages([]);
    setDraft("");
    setIdentityGuess(null);
    setPin(null);
    setModelGuess(null);
    setResult(null);
    setQueueStatus("idle");
    setConnectedProfiles(0);
    setRequiredProfiles(2);
    setQueueStartedAt(null);
    queueStartedAtRef.current = null;
    setEstimatedQueueSeconds(8);
  }

  function getQueueTransitionDelay() {
    const startedAt = queueStartedAtRef.current || Date.now();
    const elapsed = Date.now() - startedAt;

    return Math.max(0, QUEUE_FOUND_DELAY_MS + MATCH_FOUND_HOLD_MS - elapsed);
  }

  function enterChat(payload: SessionCreatedPayload) {
    setSessionId(payload.sessionId);
    setChatEndsAt(payload.chatEndsAt);
    setNow(Date.now());
    setMessages([
      {
        id: "intro",
        author: "system",
        text: payload.intro,
        sentAt: Date.now(),
      },
    ]);
    setQueueStatus("found");
    setConnectedProfiles(2);
    setPhase("chat");
  }

  function recordPersistentScore(payload: ResultPayload) {
    if (scoredSessionsRef.current.has(payload.sessionId)) {
      return;
    }

    scoredSessionsRef.current.add(payload.sessionId);

    setPersistentScore((current) => {
      const isHumanRound = payload.actual.participantType === "Human";
      const next = {
        readEarned: current.readEarned + payload.score.read.earned,
        readPossible: current.readPossible + payload.score.read.possible,
        humanEarned: current.humanEarned + (isHumanRound ? payload.score.round.earned : 0),
        humanPossible: current.humanPossible + (isHumanRound ? payload.score.round.possible : 0),
        aiEarned: current.aiEarned + (!isHumanRound ? payload.score.round.earned : 0),
        aiPossible: current.aiPossible + (!isHumanRound ? payload.score.round.possible : 0),
      };

      savePersistentScore(next);
      return next;
    });
  }

  function setLocationAgreement(agreed: boolean) {
    setLocationConsent(agreed);
    saveLocationConsent(agreed);

    if (!agreed) {
      setIpLocation(null);
      removeIpLocation();
      setLocationStatus("idle");
      return;
    }

    fetchIpLocation();
  }

  async function fetchIpLocation() {
    setLocationStatus("checking");

    try {
      const response = await fetch("https://ipapi.co/json/");

      if (!response.ok) {
        throw new Error("IP location lookup failed");
      }

      const data = await response.json();
      const lat = toLocationNumber(data.latitude ?? data.lat, -90, 90);
      const lng = toLocationNumber(data.longitude ?? data.lon ?? data.lng, -180, 180);
      const next: IpLocation = {
        country: String(data.country_name || data.country || "Unknown"),
        region: String(data.region || data.region_code || ""),
        city: String(data.city || ""),
        lat,
        lng,
        source: "ip",
        updatedAt: Date.now(),
      };

      if (!hasValidIpLocation(next)) {
        throw new Error("IP location lookup returned no coordinates");
      }

      setIpLocation(next);
      saveIpLocation(next);
      setLocationStatus("ready");
    } catch {
      setLocationStatus("unavailable");
    }
  }

  return (
    <main className="appShell">
      <header className="topbar">
        <div>
          <p className="eyebrow">GeoTuring (Preview)</p>
          <h1>Read the room. Then read the world.</h1>
        </div>
        <StatusPill value={connection} />
      </header>

      {phase === "landing" && (
        <Landing
          locationStatus={locationStatus}
          locationConsent={locationConsent}
          ipLocation={ipLocation}
          onLocationAgreement={setLocationAgreement}
          onStart={startMatchmaking}
          persistentScore={persistentScore}
        />
      )}
      {phase === "matching" && (
        <Matchmaking
          actualSeconds={actualQueueSeconds}
          connectedProfiles={connectedProfiles}
          estimatedSeconds={estimatedQueueSeconds}
          requiredProfiles={requiredProfiles}
          status={queueStatus}
        />
      )}
      {phase === "chat" && (
        <ChatRoom
          draft={draft}
          messages={messages}
          secondsLeft={secondsLeft}
          onDraft={setDraft}
          onSend={sendMessage}
          onGuess={() => setPhase("identity")}
        />
      )}
      {phase === "identity" && <IdentityGuessScreen onPick={chooseIdentity} />}
      {phase === "humanGuess" && (
        <HumanGuessScreen pin={pin} onPin={setPin} onBack={() => setPhase("identity")} onSubmit={() => submitGuess()} />
      )}
      {phase === "aiGuess" && (
        <AiGuessScreen
          selected={modelGuess}
          onBack={() => setPhase("identity")}
          onPick={(family) => {
            setModelGuess(family);
            submitGuess(family);
          }}
        />
      )}
      {phase === "reveal" && result && <Reveal result={result} onRestart={restart} />}
    </main>
  );
}

function AdminConsole() {
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

function StatusPill({ value }: { value: string }) {
  const statusClass = value.toLowerCase();

  return (
    <div className={`statusPill ${statusClass === "connected" || statusClass === "live" ? "online" : ""}`}>
      <span />
      {value}
    </div>
  );
}

function Landing({
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

function Matchmaking({
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
          <p className="roundLabel">Blind pick queue</p>
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

function ChatRoom({
  messages,
  draft,
  secondsLeft,
  onDraft,
  onSend,
  onGuess,
}: {
  messages: ChatMessage[];
  draft: string;
  secondsLeft: number;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onGuess: () => void;
}) {
  return (
    <section className="gamePanel chatLayout">
      <div className="chatHeader">
        <div>
          <p className="roundLabel">Anonymous chat</p>
          <h2>Find the tell.</h2>
        </div>
        <div className="timer">{formatSeconds(secondsLeft)}</div>
      </div>

      <div className="messages" aria-live="polite">
        {messages.map((message) => (
          <div className={`message ${message.author}`} key={message.id}>
            {message.text}
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={onSend}>
        <input
          maxLength={400}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="Ask something revealing..."
        />
        <button type="submit">Send</button>
        <button className="secondaryButton" type="button" onClick={onGuess}>
          Guess
        </button>
      </form>
    </section>
  );
}

function IdentityGuessScreen({ onPick }: { onPick: (value: IdentityGuess) => void }) {
  return (
    <section className="centerPanel">
      <p className="roundLabel">First guess</p>
      <h2>Who were you talking to?</h2>
      <div className="choiceGrid two">
        <button onClick={() => onPick("Human")}>
          <span>Human</span>
          <small>Next: place a map pin</small>
        </button>
        <button onClick={() => onPick("AI")}>
          <span>AI</span>
          <small>Next: pick the model family</small>
        </button>
      </div>
    </section>
  );
}

function HumanGuessScreen({
  pin,
  onPin,
  onBack,
  onSubmit,
}: {
  pin: Pin | null;
  onPin: (pin: Pin) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="gamePanel">
      <div className="chatHeader">
        <div>
          <p className="roundLabel">Human read</p>
          <h2>Place the origin pin.</h2>
        </div>
        <button className="secondaryButton" onClick={onBack}>
          Back
        </button>
      </div>

      <GuessMap pin={pin} onPin={onPin} />

      <div className="mapFooter">
        <span>{pin ? `${pin.lat.toFixed(1)} lat, ${pin.lng.toFixed(1)} lng` : "Tap the map to place a pin."}</span>
        <button className="primaryButton" disabled={!pin} onClick={onSubmit}>
          Lock human guess
        </button>
      </div>
    </section>
  );
}

function GuessMap({ pin, onPin }: { pin: Pin | null; onPin: (pin: Pin) => void }) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onPinRef = useRef(onPin);

  useEffect(() => {
    onPinRef.current = onPin;
  }, [onPin]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapElementRef.current, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: true,
      zoomControl: false,
    });

    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    map.on("click", (event: L.LeafletMouseEvent) => {
      onPinRef.current({
        lat: event.latlng.lat,
        lng: event.latlng.lng,
      });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    window.setTimeout(() => map.invalidateSize(), 0);

    if (!pin) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    const latLng = L.latLng(pin.lat, pin.lng);

    if (!markerRef.current) {
      markerRef.current = L.marker(latLng, {
        icon: GUESS_MARKER,
      }).addTo(map);
    } else {
      markerRef.current.setLatLng(latLng);
    }
  }, [pin]);

  return (
    <div className="guessMapShell">
      <div className="guessMap" ref={mapElementRef} />
      <div className="mapCallout">Click anywhere to place your final guess.</div>
    </div>
  );
}

function AiGuessScreen({
  selected,
  onPick,
  onBack,
}: {
  selected: ModelFamily | null;
  onPick: (family: ModelFamily) => void;
  onBack: () => void;
}) {
  return (
    <section className="centerPanel">
      <div className="chatHeader compact">
        <div>
          <p className="roundLabel">AI read</p>
          <h2>Pick the model family.</h2>
        </div>
        <button className="secondaryButton" onClick={onBack}>
          Back
        </button>
      </div>
      <div className="choiceGrid">
        {MODEL_FAMILIES.map((family) => (
          <button className={selected === family ? "selected" : ""} key={family} onClick={() => onPick(family)}>
            <span>{family}</span>
            <small>Lock answer</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function Reveal({ result, onRestart }: { result: ResultPayload; onRestart: () => void }) {
  const actual =
    result.actual.participantType === "Human"
      ? `${result.actual.region}, ${result.actual.country}`
      : `${result.actual.modelFamily}`;
  const roundLabel = result.score.round.type === "location" ? "Location round" : "AI family round";
  const roundDetail =
    result.score.round.type === "location"
      ? result.distanceKm === null
        ? "No valid location pin"
        : `${result.distanceKm} km away`
      : `You guessed ${result.guess.modelFamilyGuess || "no family"}`;

  return (
    <section className="gamePanel reveal">
      <p className="roundLabel">Reveal</p>
      <div className="revealTop">
        <h2>{result.correctIdentity ? "Correct read." : "Wrong read."}</h2>
        <div className="scoreBadges">
          <div className="scoreBadge">
            <span>Read</span>
            <strong>
              {result.score.read.earned}/{result.score.read.possible}
            </strong>
          </div>
          <div className="scoreBadge">
            <span>Round</span>
            <strong>
              {result.score.round.earned}/{result.score.round.possible}
            </strong>
          </div>
        </div>
      </div>
      <div className="revealGrid">
        <ResultStat label="Actual" value={`${result.actual.participantType}: ${actual}`} />
        <ResultStat label="Your read" value={result.guess.identityGuess} />
        <ResultStat label={roundLabel} value={`${result.score.round.earned}/${result.score.round.possible}`} />
        <ResultStat label="Round detail" value={roundDetail} />
      </div>
      <p className="explanation">{result.explanation}</p>
      <button className="primaryButton" onClick={onRestart}>
        Play again
      </button>
    </section>
  );
}

function ResultStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="resultStat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatSeconds(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatTimestamp(value: number) {
  if (!Number.isFinite(value)) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function shortSocketId(socketId: string) {
  return socketId.length <= 8 ? socketId : `${socketId.slice(0, 8)}...`;
}

function locationText(location?: AdminLocation | null) {
  if (!location) {
    return "Unknown location";
  }

  const place = [location.city, location.region, location.country].filter(Boolean).join(", ");
  const coordinates =
    Number.isFinite(location.lat) && Number.isFinite(location.lng)
      ? `${Number(location.lat).toFixed(2)}, ${Number(location.lng).toFixed(2)}`
      : "";

  return [place, coordinates].filter(Boolean).join(" / ") || "Unknown location";
}

function resolveServiceUrl(configuredUrl?: string) {
  const fallbackUrl =
    typeof window !== "undefined" && isProductionHost(window.location.hostname)
      ? "https://api.geoturing.com"
      : "http://localhost:3000";
  const value = configuredUrl || fallbackUrl;

  if (typeof window === "undefined") {
    return value;
  }

  try {
    const url = new URL(value);
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";

    if (window.location.protocol === "https:" && url.protocol === "http:" && !isLocal) {
      url.protocol = "https:";
    }

    if (window.location.protocol === "https:" && isProductionHost(window.location.hostname) && isLocal) {
      return "https://api.geoturing.com";
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return fallbackUrl;
  }
}

function isProductionHost(hostname: string) {
  return hostname === "geoturing.com" || hostname === "www.geoturing.com";
}

function getIpLocationStatusText(status: string, agreed: boolean, location: IpLocation | null) {
  if (hasValidIpLocation(location)) {
    const place = [location.city, location.region].filter(Boolean).join(", ");

    return place ? `${place}. Estimated from your IP.` : "Estimated from your IP.";
  }

  if (!agreed) {
    return "Required so another player can guess your rough whereabouts.";
  }

  if (status === "checking") {
    return "Checking your rough IP location.";
  }

  if (status === "unavailable") {
    return "IP lookup failed. Refresh or try again before matchmaking.";
  }

  if (status === "invalid") {
    return "Your saved location had no usable coordinates, so it is being checked again.";
  }

  return "Location check will run from your network/IP.";
}

function loadPersistentScore(): PersistentScore {
  if (typeof window === "undefined") {
    return EMPTY_PERSISTENT_SCORE;
  }

  try {
    const raw = window.localStorage.getItem(SCORE_STORAGE_KEY);

    if (!raw) {
      return EMPTY_PERSISTENT_SCORE;
    }

    const parsed = JSON.parse(raw) as Partial<PersistentScore>;

    return {
      readEarned: toScoreNumber(parsed.readEarned),
      readPossible: toScoreNumber(parsed.readPossible),
      humanEarned: toScoreNumber(parsed.humanEarned),
      humanPossible: toScoreNumber(parsed.humanPossible),
      aiEarned: toScoreNumber(parsed.aiEarned),
      aiPossible: toScoreNumber(parsed.aiPossible),
    };
  } catch {
    return EMPTY_PERSISTENT_SCORE;
  }
}

function savePersistentScore(score: PersistentScore) {
  try {
    window.localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(score));
  } catch {
    // The in-memory scoreboard still updates if storage is unavailable.
  }
}

function loadLocationConsent() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(LOCATION_CONSENT_STORAGE_KEY) === "true";
}

function saveLocationConsent(agreed: boolean) {
  try {
    window.localStorage.setItem(LOCATION_CONSENT_STORAGE_KEY, String(agreed));
  } catch {
    // The current checkbox state still works if storage is unavailable.
  }
}

function loadIpLocation(): IpLocation | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(IP_LOCATION_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<IpLocation>;
    const country = typeof parsed.country === "string" ? parsed.country : "";

    if (!country) {
      return null;
    }

    const location = {
      country,
      region: typeof parsed.region === "string" ? parsed.region : "",
      city: typeof parsed.city === "string" ? parsed.city : "",
      lat: toLocationNumber(parsed.lat, -90, 90),
      lng: toLocationNumber(parsed.lng, -180, 180),
      source: "ip",
      updatedAt: toScoreNumber(parsed.updatedAt),
    };

    return hasValidIpLocation(location) ? location : null;
  } catch {
    return null;
  }
}

function saveIpLocation(location: IpLocation) {
  try {
    window.localStorage.setItem(IP_LOCATION_STORAGE_KEY, JSON.stringify(location));
  } catch {
    // Location still appears for the current session if storage is unavailable.
  }
}

function removeIpLocation() {
  try {
    window.localStorage.removeItem(IP_LOCATION_STORAGE_KEY);
  } catch {
    // Nothing else to do if storage is unavailable.
  }
}

function toScoreNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function toLocationNumber(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function hasValidIpLocation(location: IpLocation | AdminLocation | null | undefined) {
  return Boolean(
    location &&
      Number.isFinite(location.lat) &&
      Number.isFinite(location.lng) &&
      Math.abs(Number(location.lat)) <= 90 &&
      Math.abs(Number(location.lng)) <= 180,
  );
}

createRoot(document.getElementById("root")!).render(<App />);
