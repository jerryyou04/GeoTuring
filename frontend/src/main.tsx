import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import { io, Socket } from "socket.io-client";
import "leaflet/dist/leaflet.css";
import "./styles.css";

type Phase = "landing" | "matching" | "chat" | "identity" | "humanGuess" | "aiGuess" | "reveal";
type IdentityGuess = "Human" | "AI";
type ModelFamily = "GPT" | "Claude" | "Gemini" | "Llama" | "Mistral" | "Other";
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

interface ResultPayload {
  correctIdentity: boolean;
  score: {
    total: number;
    identity: number;
    location: number;
    modelFamily: number;
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

const API_URL =
  import.meta.env.NEXT_PUBLIC_API_URL ||
  import.meta.env.VITE_API_URL ||
  "http://localhost:3000";

const SOCKET_URL =
  import.meta.env.NEXT_PUBLIC_SOCKET_URL ||
  import.meta.env.VITE_SOCKET_URL ||
  API_URL;

const MODEL_FAMILIES: ModelFamily[] = ["GPT", "Claude", "Gemini", "Llama", "Mistral", "Other"];
const QUEUE_FOUND_DELAY_MS = 2400;
const MATCH_FOUND_HOLD_MS = 1800;
const GUESS_MARKER = L.divIcon({
  className: "guessMarker",
  html: "<span></span>",
  iconSize: [34, 44],
  iconAnchor: [17, 42],
});

function App() {
  const socketRef = useRef<Socket | null>(null);
  const queueStartedAtRef = useRef<number | null>(null);
  const queueTimersRef = useRef<number[]>([]);
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

    queueTimersRef.current.push(
      window.setTimeout(() => {
        setConnectedProfiles(2);
        setQueueStatus("found");
      }, QUEUE_FOUND_DELAY_MS),
    );

    socketRef.current?.disconnect();
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnection("connected");
      socket.emit("queue:join");
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

    socket.on("session:created", (payload: SessionCreatedPayload) => {
      queueTimersRef.current.push(
        window.setTimeout(() => enterChat(payload), getQueueTransitionDelay()),
      );
    });

    socket.on("partner:message", (payload: { message: ChatMessage }) => {
      setMessages((current) => [...current, payload.message]);
    });

    socket.on("session:result", (payload: ResultPayload) => {
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

  return (
    <main className="appShell">
      <header className="topbar">
        <div>
          <p className="eyebrow">GeoTuring</p>
          <h1>Read the room. Then read the world.</h1>
        </div>
        <StatusPill value={connection} />
      </header>

      {phase === "landing" && <Landing onStart={startMatchmaking} />}
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

function StatusPill({ value }: { value: string }) {
  return (
    <div className={`statusPill ${value === "connected" ? "online" : ""}`}>
      <span />
      {value}
    </div>
  );
}

function Landing({ onStart }: { onStart: () => void }) {
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
        <button className="primaryButton" onClick={onStart}>
          Start matchmaking
        </button>
      </div>
      <div className="scorePreview" aria-label="Scoring preview">
        <div>
          <span>Identity</span>
          <strong>+100</strong>
        </div>
        <div>
          <span>Human location</span>
          <strong>+500</strong>
        </div>
        <div>
          <span>AI family</span>
          <strong>+300</strong>
        </div>
      </div>
    </section>
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

  return (
    <section className="gamePanel reveal">
      <p className="roundLabel">Reveal</p>
      <div className="revealTop">
        <h2>{result.correctIdentity ? "Correct read." : "Wrong read."}</h2>
        <div className="scoreBadge">{result.score.total}</div>
      </div>
      <div className="revealGrid">
        <ResultStat label="Actual" value={`${result.actual.participantType}: ${actual}`} />
        <ResultStat label="Identity" value={`+${result.score.identity}`} />
        <ResultStat label="Location" value={`+${result.score.location}`} />
        <ResultStat label="Model family" value={`+${result.score.modelFamily}`} />
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

createRoot(document.getElementById("root")!).render(<App />);
