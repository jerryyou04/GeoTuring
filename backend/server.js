require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { MODEL_FAMILIES, createMockAiProvider } = require("./aiAdapters");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const CHAT_SECONDS = 90;

const corsOptions = {
  origin: FRONTEND_URL,
};

app.use(cors(corsOptions));
app.use(express.json());

const io = new Server(server, {
  cors: corsOptions,
});

app.get("/", (req, res) => {
  res.json({
    name: "GeoTuring API",
    status: "ok",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
  });
});

const humanOpponents = [
  {
    region: "Ontario",
    country: "Canada",
    lat: 43.6532,
    lng: -79.3832,
    replies: [
      "i am used to long winters, so yes",
      "food here is a mix of everything",
      "people complain about traffic constantly",
    ],
  },
  {
    region: "Kansai",
    country: "Japan",
    lat: 34.6937,
    lng: 135.5023,
    replies: [
      "trains make it easy to get around",
      "i would pick noodles over burgers most days",
      "summer gets sticky here",
    ],
  },
  {
    region: "Bavaria",
    country: "Germany",
    lat: 48.1351,
    lng: 11.582,
    replies: [
      "people here take bread seriously",
      "the old buildings give it away sometimes",
      "weekends can get very outdoorsy",
    ],
  },
  {
    region: "New South Wales",
    country: "Australia",
    lat: -33.8688,
    lng: 151.2093,
    replies: [
      "the beaches are not exactly hidden",
      "coffee is almost a personality trait here",
      "it is usually warmer than people expect",
    ],
  },
  {
    region: "Gauteng",
    country: "South Africa",
    lat: -26.2041,
    lng: 28.0473,
    replies: [
      "people switch languages mid sentence a lot",
      "the sunsets here are unfair",
      "you would need a car for most things",
    ],
  },
  {
    region: "Sao Paulo",
    country: "Brazil",
    lat: -23.5558,
    lng: -46.6396,
    replies: [
      "the city never really slows down",
      "rain can show up out of nowhere",
      "people talk about football all the time",
    ],
  },
];

const sessions = new Map();
const queueTimers = new Map();

function createSession(socket) {
  const participant = createMockParticipant();
  const session = {
    id: cryptoRandomId(),
    playerSocketId: socket.id,
    participant,
    messages: [],
    createdAt: Date.now(),
    chatEndsAt: Date.now() + CHAT_SECONDS * 1000,
  };

  sessions.set(session.id, session);
  socket.join(session.id);

  return session;
}

function createMockParticipant() {
  if (Math.random() < 0.5) {
    const human = pick(humanOpponents);

    return {
      kind: "Human",
      region: human.region,
      country: human.country,
      lat: human.lat,
      lng: human.lng,
      replies: human.replies,
    };
  }

  const modelFamily = pick(MODEL_FAMILIES);

  return {
    kind: "AI",
    modelFamily,
    adapter: createMockAiProvider(modelFamily),
  };
}

function createPartnerReply(session) {
  if (session.participant.kind === "AI") {
    return session.participant.adapter.generateReply(session.messages);
  }

  const lastMessage = session.messages[session.messages.length - 1]?.text || "";

  if (lastMessage.toLowerCase().includes("where")) {
    return "nice try, i am not giving it away that easily";
  }

  return pick(session.participant.replies);
}

function scoreGuess(session, guess) {
  const actualType = session.participant.kind;
  const identityGuess = guess.identityGuess === "Human" ? "Human" : "AI";
  const correctIdentity = identityGuess === actualType;
  const readScore = correctIdentity ? 1 : 0;
  let roundScore = 0;
  let roundType = actualType === "Human" ? "location" : "modelFamily";
  let roundPossible = actualType === "Human" ? 100 : 1;
  let distanceKm = null;

  if (
    actualType === "Human" &&
    identityGuess === "Human" &&
    Number.isFinite(guess.locationGuess?.lat) &&
    Number.isFinite(guess.locationGuess?.lng)
  ) {
    distanceKm = haversineKm(
      guess.locationGuess.lat,
      guess.locationGuess.lng,
      session.participant.lat,
      session.participant.lng,
    );
    roundScore = Math.max(0, Math.round(100 * (1 - distanceKm / 10000)));
  }

  if (
    actualType === "AI" &&
    identityGuess === "AI" &&
    guess.modelFamilyGuess === session.participant.modelFamily
  ) {
    roundScore = 1;
  }

  return {
    sessionId: session.id,
    correctIdentity,
    score: {
      read: {
        earned: readScore,
        possible: 1,
      },
      round: {
        earned: roundScore,
        possible: roundPossible,
        type: roundType,
      },
    },
    distanceKm: distanceKm === null ? null : Math.round(distanceKm),
    guess: {
      identityGuess,
      locationGuess: guess.locationGuess || null,
      modelFamilyGuess: guess.modelFamilyGuess || null,
    },
    actual: revealParticipant(session.participant),
    explanation: buildExplanation(session.participant, correctIdentity, distanceKm),
  };
}

function revealParticipant(participant) {
  if (participant.kind === "Human") {
    return {
      participantType: "Human",
      region: participant.region,
      country: participant.country,
      lat: participant.lat,
      lng: participant.lng,
    };
  }

  return {
    participantType: "AI",
    modelFamily: participant.modelFamily,
  };
}

function buildExplanation(participant, correctIdentity, distanceKm) {
  if (participant.kind === "Human") {
    const locationText =
      distanceKm === null
        ? "Your round score is 0/100 because you did not make a human-location guess."
        : `Your location score is based on a pin ${Math.round(distanceKm)} km from ${participant.region}, ${participant.country}.`;

    return `${correctIdentity ? "You called the identity correctly." : "The identity read was off."} ${locationText}`;
  }

  return `${correctIdentity ? "You spotted the AI." : "The identity read was off."} The AI round score is 1/1 only for the exact family: ${participant.modelFamily}.`;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusKm * c;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function clearQueueTimers(socketId) {
  const timers = queueTimers.get(socketId) || [];

  timers.forEach((timer) => clearTimeout(timer));
  queueTimers.delete(socketId);
}

io.on("connection", (socket) => {
  socket.emit("connected", {
    socketId: socket.id,
  });

  socket.on("queue:join", () => {
    clearQueueTimers(socket.id);

    const queuedAt = Date.now();
    const estimatedSeconds = 8;

    socket.emit("queue:status", {
      connectedProfiles: 1,
      requiredProfiles: 2,
      status: "searching",
      queuedAt,
      estimatedSeconds,
    });

    const opponentTimer = setTimeout(() => {
      socket.emit("queue:status", {
        connectedProfiles: 2,
        requiredProfiles: 2,
        status: "found",
        queuedAt,
        estimatedSeconds,
      });
    }, 2200);

    const sessionTimer = setTimeout(() => {
      clearQueueTimers(socket.id);

      if (!socket.connected) {
        return;
      }

      const session = createSession(socket);

      socket.emit("session:created", {
        sessionId: session.id,
        chatEndsAt: session.chatEndsAt,
        chatSeconds: CHAT_SECONDS,
        intro: "An anonymous participant has joined.",
      });

      setTimeout(() => {
        if (!sessions.has(session.id)) {
          return;
        }

        socket.emit("partner:message", {
          sessionId: session.id,
          message: {
            id: cryptoRandomId(),
            author: "partner",
            text: "hey, what should we talk about?",
            sentAt: Date.now(),
          },
        });
      }, 650);
    }, 3800);

    queueTimers.set(socket.id, [opponentTimer, sessionTimer]);
  });

  socket.on("chat:message", (payload = {}) => {
    const session = sessions.get(payload.sessionId);

    if (!session || session.playerSocketId !== socket.id) {
      return;
    }

    const text = String(payload.text || "").trim().slice(0, 400);

    if (!text) {
      return;
    }

    session.messages.push({
      author: "player",
      text,
      sentAt: Date.now(),
    });

    setTimeout(() => {
      const activeSession = sessions.get(payload.sessionId);

      if (!activeSession) {
        return;
      }

      const reply = createPartnerReply(activeSession);
      const message = {
        id: cryptoRandomId(),
        author: "partner",
        text: reply,
        sentAt: Date.now(),
      };

      activeSession.messages.push(message);
      socket.emit("partner:message", {
        sessionId: activeSession.id,
        message,
      });
    }, 450 + Math.random() * 700);
  });

  socket.on("guess:submit", (payload = {}) => {
    const session = sessions.get(payload.sessionId);

    if (!session || session.playerSocketId !== socket.id) {
      return;
    }

    const result = scoreGuess(session, payload);

    socket.emit("session:result", result);
    sessions.delete(session.id);
  });

  socket.on("disconnect", () => {
    clearQueueTimers(socket.id);

    for (const [sessionId, session] of sessions.entries()) {
      if (session.playerSocketId === socket.id) {
        sessions.delete(sessionId);
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GeoTuring backend listening on 0.0.0.0:${PORT}`);
});
