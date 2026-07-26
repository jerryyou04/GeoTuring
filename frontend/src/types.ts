export type Phase = "landing" | "matching" | "chat" | "identity" | "humanGuess" | "aiGuess" | "waitingGuess" | "reveal" | "ended";
export type IdentityGuess = "Human" | "AI";
export type ModelFamily = "ChatGPT" | "Gemini" | "Claude" | "Grok";
export type QueueStatus = "idle" | "searching" | "found";

export interface ServerClockPayload {
  serverNow?: number;
}

export interface ChatMessage {
  id: string;
  clientMessageId?: string;
  author: "player" | "partner" | "system";
  text: string;
  sentAt: number;
  delivery?: "pending";
}

export interface SessionCreatedPayload extends ServerClockPayload {
  sessionId: string;
  chatStartsAt?: number | null;
  chatEndsAt: number;
  chatSeconds: number;
  intro: string;
}

export interface SessionResumedPayload extends SessionCreatedPayload {
  messages: ChatMessage[];
  chatLocked: boolean;
  finalGuessEndsAt: number | null;
  submitted: boolean;
  turnState?: TurnStatePayload;
}

export interface QueueStatusPayload extends ServerClockPayload {
  connectedProfiles: number;
  requiredProfiles: number;
  status: QueueStatus;
  queuedAt: number;
}

export interface QueueErrorPayload {
  code?: string;
  message?: string;
}

export interface ChatErrorPayload {
  sessionId?: string;
  clientMessageId?: string;
  requestId?: string;
  code?: string;
  message?: string;
  retryAt?: number;
}

export interface ChatSendAck {
  ok: boolean;
  sessionId?: string;
  requestId?: string;
  message?: ChatMessage;
  code?: string;
  error?: string;
}

export interface GuessErrorPayload {
  sessionId?: string;
  code?: string;
  message?: string;
  counts?: MessageCounts;
  required?: number;
}

export interface MessageCounts {
  player: number;
  partner: number;
}

export interface TurnStatePayload extends ServerClockPayload {
  sessionId: string;
  currentTurn: "player" | "partner" | "paused";
  turnEndsAt: number | null;
  canGuessEarly: boolean;
  canAbort: boolean;
  message?: string;
  counts: MessageCounts;
  required: number;
}

export interface ResultPayload {
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
  guess: SubmittedGuess;
  opponentGuess: SubmittedGuess | null;
  opponentExplanation?: string | null;
  opponentPending?: boolean;
  opponentGuessEndsAt?: number | null;
  actual: {
    participantType: IdentityGuess;
    region?: string;
    country?: string;
    lat?: number;
    lng?: number;
    modelFamily?: ModelFamily;
  };
  opponentActual?: {
    participantType: IdentityGuess;
    region?: string;
    country?: string;
    lat?: number;
    lng?: number;
    modelFamily?: ModelFamily;
  } | null;
  explanation: string;
}

export interface SubmittedGuess {
  identityGuess: IdentityGuess | null;
  locationGuess: Pin | null;
  locationPlace?: GuessPlace | null;
  locationPlaceStatus?: "pending" | "resolved" | "unavailable";
  modelFamilyGuess: ModelFamily | null;
  submitted: boolean;
}

export interface Pin {
  lat: number;
  lng: number;
}

export interface GuessPlace {
  label: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
}

export interface StoredTranscriptMessage {
  id?: string;
  author: "player" | "partner" | "system";
  text: string;
  sentAt: number;
}

export interface GameHistoryEntry {
  sessionId: string;
  playedAt: string;
  opponentType: IdentityGuess;
  identityGuess: IdentityGuess | null;
  correctIdentity: boolean;
  readEarned: number;
  readPossible: number;
  roundType: "location" | "modelFamily";
  roundEarned: number;
  roundPossible: number;
  distanceKm: number | null;
  guessLocation: Pin | null;
  guessPlace: GuessPlace | null;
  modelFamily: ModelFamily | null;
  modelFamilyGuess: ModelFamily | null;
  actualRegion: string | null;
  actualCountry: string | null;
  opponentIdentityGuess: IdentityGuess | null;
  opponentCorrectIdentity: boolean | null;
  opponentDistanceKm: number | null;
  opponentGuessLocation: Pin | null;
  opponentGuessPlace: GuessPlace | null;
  opponentModelFamilyGuess: ModelFamily | null;
  opponentExplanation: string | null;
  messageCount?: number;
  transcript?: StoredTranscriptMessage[];
}

export interface AdminHistoryEntry extends GameHistoryEntry {
  playerId: string;
}

export interface AdminHistoryResponse {
  enabled: boolean;
  total: number;
  page: number;
  pageSize: number;
  games: AdminHistoryEntry[];
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  games: number;
  readAccuracy: number;
}

export interface LeaderboardResponse {
  enabled: boolean;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  players: LeaderboardEntry[];
}

export interface PersistentScore {
  readEarned: number;
  readPossible: number;
  humanEarned: number;
  humanPossible: number;
  aiEarned: number;
  aiPossible: number;
}

export interface IpLocation {
  country: string;
  region: string;
  city: string;
  lat: number | null;
  lng: number | null;
  source: "ip";
  updatedAt: number;
}

export interface AdminSnapshot {
  generatedAt: number;
  waiting: AdminWaitingEntry[];
  rooms: AdminRoom[];
}

export interface AdminLocation {
  country?: string;
  region?: string;
  city?: string;
  lat: number | null;
  lng: number | null;
  source?: "ip";
  updatedAt?: number;
}

export interface AdminWaitingEntry {
  socketId: string;
  connected: boolean;
  queuedAt: number;
  location: AdminLocation;
}

export interface AdminParticipant {
  label: string;
  socketId: string | null;
  type: IdentityGuess;
  location?: AdminLocation;
  modelFamily?: ModelFamily;
  submitted: boolean;
  disconnected: boolean;
}

export interface AdminRoom {
  id: string;
  mode: "human" | "ai";
  createdAt: number;
  chatEndsAt: number;
  aiResponseStatus: AdminAiResponseStatus | null;
  participants: AdminParticipant[];
  messages: AdminTranscriptMessage[];
}

export interface AdminAiResponseStatus {
  state: "idle" | "generating" | "typing" | "sent" | "failed";
  responseText: string | null;
  source: string | null;
  failed: boolean;
  error: string | null;
  model: string | null;
  delayMs: number | null;
  updatedAt: number;
}

export interface AdminTranscriptAiMeta {
  source: string;
  failed: boolean;
  error: string | null;
  model: string | null;
  typingDelayMs: number;
  targetTypingMs: number;
}

export interface AdminTranscriptMessage {
  id: string;
  author: string;
  authorLabel: string;
  text: string;
  sentAt: number;
  ai: AdminTranscriptAiMeta | null;
}
