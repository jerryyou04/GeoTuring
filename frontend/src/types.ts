export type Phase = "landing" | "matching" | "chat" | "identity" | "humanGuess" | "aiGuess" | "waitingGuess" | "reveal" | "ended";
export type IdentityGuess = "Human" | "AI";
export type ModelFamily = "ChatGPT" | "Gemini" | "Claude" | "Grok";
export type QueueStatus = "idle" | "searching" | "found";

export interface ChatMessage {
  id: string;
  author: "player" | "partner" | "system";
  text: string;
  sentAt: number;
}

export interface SessionCreatedPayload {
  sessionId: string;
  chatEndsAt: number;
  chatSeconds: number;
  intro: string;
}

export interface SessionResumedPayload extends SessionCreatedPayload {
  messages: ChatMessage[];
  chatLocked: boolean;
  finalGuessEndsAt: number | null;
  submitted: boolean;
}

export interface QueueStatusPayload {
  connectedProfiles: number;
  requiredProfiles: number;
  status: QueueStatus;
  queuedAt: number;
  estimatedSeconds: number;
}

export interface QueueErrorPayload {
  code?: string;
  message?: string;
}

export interface ChatErrorPayload {
  code?: string;
  message?: string;
  retryAt?: number;
}

export interface GuessErrorPayload {
  code?: string;
  message?: string;
  counts?: MessageCounts;
  required?: number;
}

export interface MessageCounts {
  player: number;
  partner: number;
}

export interface TurnStatePayload {
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
  guess: {
    identityGuess: IdentityGuess | null;
    locationGuess: Pin | null;
    modelFamilyGuess: ModelFamily | null;
    submitted: boolean;
  };
  opponentGuess: SubmittedGuess | null;
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
  modelFamilyGuess: ModelFamily | null;
  submitted: boolean;
}

export interface Pin {
  lat: number;
  lng: number;
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
  modelFamily: ModelFamily | null;
  actualRegion: string | null;
  actualCountry: string | null;
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
