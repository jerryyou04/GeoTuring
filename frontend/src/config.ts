import type { ModelFamily, PersistentScore, TurnStatePayload } from "./types";

export const MODEL_FAMILIES: ModelFamily[] = ["ChatGPT", "Gemini", "Claude", "Grok"];
export const SCORE_STORAGE_KEY = "geoturing:scoreboard:v2";
export const SCORED_SESSION_IDS_STORAGE_KEY = "geoturing:scored-sessions:v1";
export const LOCATION_CONSENT_STORAGE_KEY = "geoturing:location-consent:v1";
export const IP_LOCATION_STORAGE_KEY = "geoturing:ip-location:v1";
export const PLAYER_ID_STORAGE_KEY = "geoturing:player-id:v1";
export const NAME_STORAGE_KEY = "geoturing:name:v1";
export const ACTIVE_SESSION_STORAGE_KEY = "geoturing:active-session:v1";
export const ADMIN_CONSOLE_PATH = "/host-monitor";
export const HISTORY_PATH = "/history";
export const LEADERBOARD_PATH = "/leaderboard";
export const ADMIN_API_PATH = "/admin/host-monitor";
export const ADMIN_TOKEN_STORAGE_KEY = "geoturing:admin-token:v1";
export const MIN_MESSAGES_PER_SIDE = 2;
export const TURN_SECONDS = 25;
export const FINAL_GUESS_SECONDS = 25;
export const MATCH_FOUND_HOLD_MS = 1800;

export const EMPTY_TURN_STATE: TurnStatePayload = {
  sessionId: "",
  currentTurn: "paused",
  turnEndsAt: null,
  canGuessEarly: false,
  canAbort: false,
  counts: {
    player: 0,
    partner: 0,
  },
  required: MIN_MESSAGES_PER_SIDE,
};

export const EMPTY_PERSISTENT_SCORE: PersistentScore = {
  readEarned: 0,
  readPossible: 0,
  humanEarned: 0,
  humanPossible: 0,
  aiEarned: 0,
  aiPossible: 0,
};

export const API_URL = resolveServiceUrl(
  import.meta.env.NEXT_PUBLIC_API_URL || import.meta.env.VITE_API_URL,
);

export const SOCKET_URL = resolveServiceUrl(
  import.meta.env.NEXT_PUBLIC_SOCKET_URL || import.meta.env.VITE_SOCKET_URL || API_URL,
);

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
