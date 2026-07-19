const { CHAT_SECONDS, MIN_MESSAGES_PER_SIDE } = require("./config");
const { cryptoRandomId } = require("./utils");

function resolveClientMessageId(value, createId = cryptoRandomId) {
  const providedId = String(value || "").trim().slice(0, 100);

  return {
    clientMessageId: providedId || createId(),
    providedByClient: Boolean(providedId),
  };
}

function buildSessionResumePayload(session, socketId) {
  const serverNow = Date.now();
  const submitted = session.mode === "human"
    ? Boolean(session.players[socketId]?.submitted)
    : Boolean(session.submitted);

  return {
    sessionId: session.id,
    serverNow,
    chatStartsAt: session.chatStartsAt || null,
    chatEndsAt: session.chatEndsAt,
    chatSeconds: CHAT_SECONDS,
    intro: "An anonymous participant has joined.",
    messages: serializeMessagesForSocket(session, socketId),
    chatLocked: session.chatLocked,
    finalGuessEndsAt: session.finalGuessEndsAt,
    submitted,
    turnState: {
      sessionId: session.id,
      serverNow,
      currentTurn: session.chatLocked || !session.turnOwner
        ? "paused"
        : session.turnOwner === socketId ? "player" : "partner",
      turnEndsAt: session.chatLocked ? null : session.turnEndsAt,
      canGuessEarly: false,
      canAbort: false,
      counts: getPersonalMessageCounts(session, socketId),
      required: MIN_MESSAGES_PER_SIDE,
    },
  };
}

function serializeMessagesForSocket(session, socketId) {
  return session.messages.map((message, index) => {
    const author = getClientMessageAuthor(session, socketId, message.author);

    return {
      id: message.id || `${session.id}:${index}`,
      ...(author === "player" && message.clientMessageId
        ? { clientMessageId: message.clientMessageId }
        : {}),
      author,
      text: message.text,
      sentAt: message.sentAt,
    };
  });
}

function getClientMessageAuthor(session, socketId, author) {
  if (author === "system") {
    return "system";
  }

  if (session.mode === "ai") {
    return author === "partner" ? "partner" : "player";
  }

  return author === socketId ? "player" : "partner";
}

function isSocketInSession(session, socketId) {
  if (!session) {
    return false;
  }

  if (session.mode === "human") {
    const player = session.players[socketId];
    return Boolean(player && !player.disconnected);
  }

  return session.playerSocketId === socketId && !session.disconnected;
}

function getMessageCounts(session) {
  if (session.mode === "human") {
    const socketIds = Object.keys(session.players);

    return {
      player: session.messages.filter((message) => message.author === socketIds[0]).length,
      partner: session.messages.filter((message) => message.author === socketIds[1]).length,
    };
  }

  return {
    player: session.messages.filter((message) => message.author === session.playerSocketId).length,
    partner: session.messages.filter((message) => message.author === "partner").length,
  };
}

function getPersonalMessageCounts(session, socketId) {
  if (session.mode === "human") {
    const partnerSocketId = getHumanPartnerSocketId(session, socketId);

    return {
      player: session.messages.filter((message) => message.author === socketId).length,
      partner: session.messages.filter((message) => message.author === partnerSocketId).length,
    };
  }

  return getMessageCounts(session);
}

function isGuessReady(session) {
  const counts = getMessageCounts(session);

  return counts.player >= MIN_MESSAGES_PER_SIDE && counts.partner >= MIN_MESSAGES_PER_SIDE;
}

function getHumanPartnerSocketId(session, socketId) {
  return Object.keys(session.players).find((candidateId) => candidateId !== socketId) || null;
}

function areHumanFinalGuessesDone(session) {
  return Object.values(session.players).every((player) => player.submitted);
}

function markSubmitted(session, socketId) {
  if (session.mode === "human") {
    session.players[socketId].submitted = true;
    return;
  }

  session.submitted = true;
}

module.exports = {
  areHumanFinalGuessesDone,
  buildSessionResumePayload,
  getHumanPartnerSocketId,
  getMessageCounts,
  getPersonalMessageCounts,
  isGuessReady,
  isSocketInSession,
  markSubmitted,
  resolveClientMessageId,
  serializeMessagesForSocket,
};
