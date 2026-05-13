import React, { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import "./styles.css";

type Phase = "landing" | "matching" | "chat" | "identity" | "humanGuess" | "aiGuess" | "reveal";
type IdentityGuess = "Human" | "AI";
type ModelFamily = "GPT" | "Claude" | "Gemini" | "Llama" | "Mistral" | "Other";

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
const MAP_WIDTH = 720;
const MAP_HEIGHT = 360;

function App() {
  const socketRef = useRef<Socket | null>(null);
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

  const secondsLeft = useMemo(() => {
    if (!chatEndsAt) {
      return 0;
    }

    return Math.max(0, Math.ceil((chatEndsAt - now) / 1000));
  }, [chatEndsAt, now]);

  useEffect(() => {
    if (phase !== "chat") {
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
    return () => socketRef.current?.disconnect();
  }, []);

  function startMatchmaking() {
    setPhase("matching");
    setConnection("connecting");
    setResult(null);
    setIdentityGuess(null);
    setPin(null);
    setModelGuess(null);
    setMessages([]);

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

    socket.on("session:created", (payload: SessionCreatedPayload) => {
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
      setPhase("chat");
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
      {phase === "matching" && <Matchmaking />}
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

function Matchmaking() {
  return (
    <section className="centerPanel">
      <div className="loader" />
      <h2>Finding an anonymous participant</h2>
      <p>For this MVP, a simulated opponent fills in when no live player is available.</p>
    </section>
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
  function placePin(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * MAP_WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * MAP_HEIGHT;

    onPin({
      lat: clamp(90 - (y / MAP_HEIGHT) * 180, -90, 90),
      lng: clamp((x / MAP_WIDTH) * 360 - 180, -180, 180),
    });
  }

  const point = pin ? latLngToPoint(pin) : null;

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

      <svg className="worldMap" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="button" onClick={placePin}>
        <rect width="720" height="360" rx="24" />
        <path d="M108 92 L168 62 L236 82 L258 126 L228 164 L152 154 L94 132 Z" />
        <path d="M208 182 L268 198 L286 260 L252 326 L210 282 L184 226 Z" />
        <path d="M336 86 L398 60 L500 72 L602 122 L562 178 L448 166 L352 142 Z" />
        <path d="M388 172 L448 186 L480 250 L444 318 L394 276 L366 214 Z" />
        <path d="M544 218 L624 226 L668 282 L620 324 L548 298 Z" />
        <path d="M70 238 L116 230 L126 270 L88 286 Z" />
        <line x1="0" y1="180" x2="720" y2="180" />
        <line x1="360" y1="0" x2="360" y2="360" />
        {point && (
          <g className="pin" transform={`translate(${point.x} ${point.y})`}>
            <circle r="12" />
            <circle r="4" />
          </g>
        )}
      </svg>

      <div className="mapFooter">
        <span>{pin ? `${pin.lat.toFixed(1)} lat, ${pin.lng.toFixed(1)} lng` : "Tap the map to place a pin."}</span>
        <button className="primaryButton" disabled={!pin} onClick={onSubmit}>
          Lock human guess
        </button>
      </div>
    </section>
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

function latLngToPoint(pin: Pin) {
  return {
    x: ((pin.lng + 180) / 360) * MAP_WIDTH,
    y: ((90 - pin.lat) / 180) * MAP_HEIGHT,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

createRoot(document.getElementById("root")!).render(<App />);
