const MODEL_FAMILIES = ["ChatGPT", "Gemini", "Claude", "Grok"];

const PERSONA_OPTIONS = {
  humor: ["none", "dry", "sarcastic", "goofy", "warm", "deadpan"],
  verbosity: ["very short", "short", "medium", "occasionally wordy"],
  confidence: ["low", "medium", "high"],
  curiosity: ["low", "medium", "high"],
  suspicion: ["low", "medium", "high"],
};

// Weighted so real-person defaults dominate: emoji is usually off, casing leans
// toward lowercase texting, and punctuation leans light.
const WEIGHTED_OPTIONS = {
  emojiUsage: [["never", 4], ["rare", 4], ["sometimes", 2]],
  casing: [["lowercase", 3], ["proper", 2]],
  punctuation: [["minimal", 3], ["casual", 3], ["standard", 1]],
  locationDisclosure: [["direct", 4], ["vague", 4], ["cagey", 2]],
};

// Pick a geographic pool first, then a city inside it. This keeps the intended
// regional distribution stable even when one pool contains many more cities.
// North America is deliberately favored without making the United States the
// default: Canada 24% + US 22% + Mexico/Central America/Caribbean 12% = 58%.
const LOCATION_POOLS = [
  {
    id: "canada",
    worldRegion: "north-america",
    weight: 24,
    places: [
      ["Vancouver", "Canada", "America/Vancouver"],
      ["Victoria", "Canada", "America/Vancouver"],
      ["Kelowna", "Canada", "America/Vancouver"],
      ["Prince George", "Canada", "America/Vancouver"],
      ["Calgary", "Canada", "America/Edmonton"],
      ["Edmonton", "Canada", "America/Edmonton"],
      ["Saskatoon", "Canada", "America/Regina"],
      ["Regina", "Canada", "America/Regina"],
      ["Winnipeg", "Canada", "America/Winnipeg"],
      ["Thunder Bay", "Canada", "America/Thunder_Bay"],
      ["Toronto", "Canada", "America/Toronto"],
      ["Hamilton", "Canada", "America/Toronto"],
      ["London", "Canada", "America/Toronto"],
      ["Windsor", "Canada", "America/Toronto"],
      ["Kingston", "Canada", "America/Toronto"],
      ["Ottawa", "Canada", "America/Toronto"],
      ["Montreal", "Canada", "America/Toronto"],
      ["Quebec City", "Canada", "America/Toronto"],
      ["Halifax", "Canada", "America/Halifax"],
      ["Charlottetown", "Canada", "America/Halifax"],
      ["Fredericton", "Canada", "America/Moncton"],
      ["Moncton", "Canada", "America/Moncton"],
      ["St. John's", "Canada", "America/St_Johns"],
      ["Whitehorse", "Canada", "America/Whitehorse"],
      ["Yellowknife", "Canada", "America/Yellowknife"],
    ],
  },
  {
    id: "united-states",
    worldRegion: "north-america",
    weight: 22,
    places: [
      ["Seattle", "United States", "America/Los_Angeles"],
      ["Portland", "United States", "America/Los_Angeles"],
      ["San Francisco", "United States", "America/Los_Angeles"],
      ["Sacramento", "United States", "America/Los_Angeles"],
      ["Los Angeles", "United States", "America/Los_Angeles"],
      ["San Diego", "United States", "America/Los_Angeles"],
      ["Las Vegas", "United States", "America/Los_Angeles"],
      ["Phoenix", "United States", "America/Phoenix"],
      ["Denver", "United States", "America/Denver"],
      ["Salt Lake City", "United States", "America/Denver"],
      ["Albuquerque", "United States", "America/Denver"],
      ["Dallas", "United States", "America/Chicago"],
      ["Austin", "United States", "America/Chicago"],
      ["Houston", "United States", "America/Chicago"],
      ["San Antonio", "United States", "America/Chicago"],
      ["Oklahoma City", "United States", "America/Chicago"],
      ["Minneapolis", "United States", "America/Chicago"],
      ["Chicago", "United States", "America/Chicago"],
      ["Nashville", "United States", "America/Chicago"],
      ["New Orleans", "United States", "America/Chicago"],
      ["Atlanta", "United States", "America/New_York"],
      ["Miami", "United States", "America/New_York"],
      ["Orlando", "United States", "America/New_York"],
      ["Charlotte", "United States", "America/New_York"],
      ["Washington, D.C.", "United States", "America/New_York"],
      ["Philadelphia", "United States", "America/New_York"],
      ["New York City", "United States", "America/New_York"],
      ["Boston", "United States", "America/New_York"],
      ["Anchorage", "United States", "America/Anchorage"],
      ["Honolulu", "United States", "Pacific/Honolulu"],
    ],
  },
  {
    id: "mexico-central-america-caribbean",
    worldRegion: "north-america",
    weight: 12,
    places: [
      ["Mexico City", "Mexico", "America/Mexico_City"],
      ["Guadalajara", "Mexico", "America/Mexico_City"],
      ["Puebla", "Mexico", "America/Mexico_City"],
      ["Monterrey", "Mexico", "America/Monterrey"],
      ["Tijuana", "Mexico", "America/Tijuana"],
      ["Cancun", "Mexico", "America/Cancun"],
      ["Mérida", "Mexico", "America/Merida"],
      ["Guatemala City", "Guatemala", "America/Guatemala"],
      ["Belize City", "Belize", "America/Belize"],
      ["San Salvador", "El Salvador", "America/El_Salvador"],
      ["Tegucigalpa", "Honduras", "America/Tegucigalpa"],
      ["Managua", "Nicaragua", "America/Managua"],
      ["San José", "Costa Rica", "America/Costa_Rica"],
      ["Panama City", "Panama", "America/Panama"],
      ["Havana", "Cuba", "America/Havana"],
      ["Kingston", "Jamaica", "America/Jamaica"],
      ["Santo Domingo", "Dominican Republic", "America/Santo_Domingo"],
      ["San Juan", "Puerto Rico", "America/Puerto_Rico"],
      ["Nassau", "Bahamas", "America/Nassau"],
      ["Port of Spain", "Trinidad and Tobago", "America/Port_of_Spain"],
    ],
  },
  {
    id: "europe",
    worldRegion: "europe",
    weight: 15,
    places: [
      ["London", "United Kingdom", "Europe/London"],
      ["Manchester", "United Kingdom", "Europe/London"],
      ["Edinburgh", "United Kingdom", "Europe/London"],
      ["Glasgow", "United Kingdom", "Europe/London"],
      ["Dublin", "Ireland", "Europe/Dublin"],
      ["Cork", "Ireland", "Europe/Dublin"],
      ["Lisbon", "Portugal", "Europe/Lisbon"],
      ["Porto", "Portugal", "Europe/Lisbon"],
      ["Madrid", "Spain", "Europe/Madrid"],
      ["Barcelona", "Spain", "Europe/Madrid"],
      ["Paris", "France", "Europe/Paris"],
      ["Lyon", "France", "Europe/Paris"],
      ["Brussels", "Belgium", "Europe/Brussels"],
      ["Amsterdam", "Netherlands", "Europe/Amsterdam"],
      ["Berlin", "Germany", "Europe/Berlin"],
      ["Munich", "Germany", "Europe/Berlin"],
      ["Copenhagen", "Denmark", "Europe/Copenhagen"],
      ["Oslo", "Norway", "Europe/Oslo"],
      ["Stockholm", "Sweden", "Europe/Stockholm"],
      ["Helsinki", "Finland", "Europe/Helsinki"],
      ["Warsaw", "Poland", "Europe/Warsaw"],
      ["Prague", "Czechia", "Europe/Prague"],
      ["Vienna", "Austria", "Europe/Vienna"],
      ["Zurich", "Switzerland", "Europe/Zurich"],
      ["Rome", "Italy", "Europe/Rome"],
      ["Milan", "Italy", "Europe/Rome"],
      ["Athens", "Greece", "Europe/Athens"],
      ["Bucharest", "Romania", "Europe/Bucharest"],
      ["Istanbul", "Turkey", "Europe/Istanbul"],
      ["Reykjavik", "Iceland", "Atlantic/Reykjavik"],
      ["Budapest", "Hungary", "Europe/Budapest"],
      ["Zagreb", "Croatia", "Europe/Zagreb"],
      ["Belgrade", "Serbia", "Europe/Belgrade"],
      ["Sofia", "Bulgaria", "Europe/Sofia"],
      ["Riga", "Latvia", "Europe/Riga"],
      ["Tallinn", "Estonia", "Europe/Tallinn"],
      ["Vilnius", "Lithuania", "Europe/Vilnius"],
      ["Kyiv", "Ukraine", "Europe/Kyiv"],
      ["Chisinau", "Moldova", "Europe/Chisinau"],
    ],
  },
  {
    id: "asia",
    worldRegion: "asia",
    weight: 10,
    places: [
      ["Tokyo", "Japan", "Asia/Tokyo"],
      ["Osaka", "Japan", "Asia/Tokyo"],
      ["Sapporo", "Japan", "Asia/Tokyo"],
      ["Seoul", "South Korea", "Asia/Seoul"],
      ["Busan", "South Korea", "Asia/Seoul"],
      ["Beijing", "China", "Asia/Shanghai"],
      ["Shanghai", "China", "Asia/Shanghai"],
      ["Shenzhen", "China", "Asia/Shanghai"],
      ["Hong Kong", "Hong Kong", "Asia/Hong_Kong"],
      ["Taipei", "Taiwan", "Asia/Taipei"],
      ["Singapore", "Singapore", "Asia/Singapore"],
      ["Kuala Lumpur", "Malaysia", "Asia/Kuala_Lumpur"],
      ["Manila", "Philippines", "Asia/Manila"],
      ["Cebu", "Philippines", "Asia/Manila"],
      ["Bangkok", "Thailand", "Asia/Bangkok"],
      ["Ho Chi Minh City", "Vietnam", "Asia/Ho_Chi_Minh"],
      ["Hanoi", "Vietnam", "Asia/Ho_Chi_Minh"],
      ["Jakarta", "Indonesia", "Asia/Jakarta"],
      ["Denpasar", "Indonesia", "Asia/Makassar"],
      ["New Delhi", "India", "Asia/Kolkata"],
      ["Mumbai", "India", "Asia/Kolkata"],
      ["Bengaluru", "India", "Asia/Kolkata"],
      ["Dhaka", "Bangladesh", "Asia/Dhaka"],
      ["Kathmandu", "Nepal", "Asia/Kathmandu"],
      ["Colombo", "Sri Lanka", "Asia/Colombo"],
      ["Karachi", "Pakistan", "Asia/Karachi"],
      ["Dubai", "United Arab Emirates", "Asia/Dubai"],
      ["Riyadh", "Saudi Arabia", "Asia/Riyadh"],
      ["Tel Aviv", "Israel", "Asia/Jerusalem"],
    ],
  },
  {
    id: "oceania",
    worldRegion: "oceania",
    weight: 6,
    places: [
      ["Sydney", "Australia", "Australia/Sydney"],
      ["Melbourne", "Australia", "Australia/Melbourne"],
      ["Brisbane", "Australia", "Australia/Brisbane"],
      ["Gold Coast", "Australia", "Australia/Brisbane"],
      ["Adelaide", "Australia", "Australia/Adelaide"],
      ["Perth", "Australia", "Australia/Perth"],
      ["Hobart", "Australia", "Australia/Hobart"],
      ["Darwin", "Australia", "Australia/Darwin"],
      ["Auckland", "New Zealand", "Pacific/Auckland"],
      ["Wellington", "New Zealand", "Pacific/Auckland"],
      ["Christchurch", "New Zealand", "Pacific/Auckland"],
      ["Suva", "Fiji", "Pacific/Fiji"],
      ["Port Moresby", "Papua New Guinea", "Pacific/Port_Moresby"],
    ],
  },
  {
    id: "south-america",
    worldRegion: "south-america",
    weight: 6,
    places: [
      ["Bogotá", "Colombia", "America/Bogota"],
      ["Medellín", "Colombia", "America/Bogota"],
      ["Cali", "Colombia", "America/Bogota"],
      ["Lima", "Peru", "America/Lima"],
      ["Quito", "Ecuador", "America/Guayaquil"],
      ["Guayaquil", "Ecuador", "America/Guayaquil"],
      ["Caracas", "Venezuela", "America/Caracas"],
      ["La Paz", "Bolivia", "America/La_Paz"],
      ["Santiago", "Chile", "America/Santiago"],
      ["Buenos Aires", "Argentina", "America/Argentina/Buenos_Aires"],
      ["Córdoba", "Argentina", "America/Argentina/Cordoba"],
      ["Montevideo", "Uruguay", "America/Montevideo"],
      ["Asunción", "Paraguay", "America/Asuncion"],
      ["São Paulo", "Brazil", "America/Sao_Paulo"],
      ["Rio de Janeiro", "Brazil", "America/Sao_Paulo"],
      ["Brasília", "Brazil", "America/Sao_Paulo"],
      ["Recife", "Brazil", "America/Recife"],
      ["Manaus", "Brazil", "America/Manaus"],
    ],
  },
  {
    id: "africa",
    worldRegion: "africa",
    weight: 5,
    places: [
      ["Cairo", "Egypt", "Africa/Cairo"],
      ["Casablanca", "Morocco", "Africa/Casablanca"],
      ["Algiers", "Algeria", "Africa/Algiers"],
      ["Tunis", "Tunisia", "Africa/Tunis"],
      ["Lagos", "Nigeria", "Africa/Lagos"],
      ["Accra", "Ghana", "Africa/Accra"],
      ["Dakar", "Senegal", "Africa/Dakar"],
      ["Nairobi", "Kenya", "Africa/Nairobi"],
      ["Addis Ababa", "Ethiopia", "Africa/Addis_Ababa"],
      ["Kampala", "Uganda", "Africa/Kampala"],
      ["Johannesburg", "South Africa", "Africa/Johannesburg"],
      ["Cape Town", "South Africa", "Africa/Johannesburg"],
      ["Durban", "South Africa", "Africa/Johannesburg"],
      ["Harare", "Zimbabwe", "Africa/Harare"],
      ["Lusaka", "Zambia", "Africa/Lusaka"],
      ["Dar es Salaam", "Tanzania", "Africa/Dar_es_Salaam"],
      ["Maputo", "Mozambique", "Africa/Maputo"],
      ["Windhoek", "Namibia", "Africa/Windhoek"],
      ["Gaborone", "Botswana", "Africa/Gaborone"],
      ["Kigali", "Rwanda", "Africa/Kigali"],
      ["Port Louis", "Mauritius", "Indian/Mauritius"],
    ],
  },
];

const CASING_INSTRUCTIONS = {
  lowercase: "type in all lowercase like casual texting and basically never capitalize, not even the first word",
  proper: "use normal sentence capitalization",
};

const PUNCTUATION_INSTRUCTIONS = {
  minimal: "use barely any punctuation, usually no period at the end, and never semicolons or em dashes",
  casual: "use light, casual punctuation and feel free to drop the ending period",
  standard: "use normal punctuation but stay casual, never formal or essay-like",
};

const EMOJI_INSTRUCTIONS = {
  never: "do not use any emoji at all this whole match",
  rare: "almost never use emoji, and only the rare time something genuinely deserves a reaction",
  sometimes: "use an emoji once in a while, only when it truly fits a reaction, and keep most messages emoji-free",
};

function createConversationPersona(random = Math.random) {
  return {
    age: youngLeaningAge(random),
    humor: pick(PERSONA_OPTIONS.humor, random),
    verbosity: pick(PERSONA_OPTIONS.verbosity, random),
    emojiUsage: pickWeighted(WEIGHTED_OPTIONS.emojiUsage, random),
    casing: pickWeighted(WEIGHTED_OPTIONS.casing, random),
    punctuation: pickWeighted(WEIGHTED_OPTIONS.punctuation, random),
    confidence: pick(PERSONA_OPTIONS.confidence, random),
    curiosity: pick(PERSONA_OPTIONS.curiosity, random),
    suspicion: pick(PERSONA_OPTIONS.suspicion, random),
    location: createLocationProfile(random),
    locationDisclosure: pickWeighted(WEIGHTED_OPTIONS.locationDisclosure, random),
  };
}

function buildPersonaInstructions(persona) {
  if (!persona) {
    return "";
  }

  return [
    "Personality for this match (stay consistent with these, but never announce or describe them):",
    buildLocationInstructions(persona),
    `Rough age: ${persona.age}.`,
    `Humor: ${persona.humor}.`,
    `Verbosity: ${persona.verbosity}, and vary your message length so some replies are just one or two words.`,
    `Capitalization: ${CASING_INSTRUCTIONS[persona.casing]}, and keep that exact style for the entire conversation.`,
    `Punctuation: ${PUNCTUATION_INSTRUCTIONS[persona.punctuation]}.`,
    `Emoji: ${EMOJI_INSTRUCTIONS[persona.emojiUsage]}.`,
    `Confidence: ${persona.confidence}.`,
    `Curiosity: ${persona.curiosity}.`,
    `Suspicion: ${persona.suspicion}.`,
  ].filter(Boolean).join(" ");
}

function createLocationProfile(random = Math.random) {
  const pool = pickWeighted(
    LOCATION_POOLS.map((candidate) => [candidate, candidate.weight]),
    random,
  );
  const [city, country, timeZone] = pick(pool.places, random);

  return {
    poolId: pool.id,
    worldRegion: pool.worldRegion,
    city,
    country,
    timeZone,
  };
}

function buildLocationInstructions(persona) {
  const location = persona?.location;

  if (!location?.city || !location?.country || !location?.timeZone) {
    return "";
  }

  const disclosure = {
    direct: `If directly asked where you are from or where you are, answer naturally using ${location.city} or ${location.country}. Do not volunteer it without a conversational reason.`,
    vague: `When location first comes up, answer only broadly, such as "${location.country}". You may reveal ${location.city} after a natural follow-up, but never substitute another place.`,
    cagey: `When directly asked where you are from, usually dodge, tease, or avoid being specific. Never give a false alternate place. If you eventually give a real clue or place, it must match ${location.city}, ${location.country}.`,
  }[persona.locationDisclosure] || "";

  return [
    "Private location identity for this match (never announce that it was assigned):",
    `You are from and currently chatting from ${location.city}, ${location.country}.`,
    `IANA time zone: ${location.timeZone}.`,
    "Keep this same location for the entire match. Never switch locations, invent a decoy home, or contradict it.",
    disclosure,
    "Keep time-of-day, date, season, spelling choices, and any local or cultural references compatible with this place.",
    "Only use local details you are confident about. Do not perform a written accent, caricature the place, force regional slang, or name-drop landmarks just to prove where you are from.",
    "Write fluent, natural English instead of manufacturing mistakes to signal a non-English-speaking place.",
  ].filter(Boolean).join(" ");
}

function buildAiReplyResult(value, metadata = {}) {
  if (typeof value === "object" && value !== null && typeof value.text === "string") {
    return {
      text: value.text,
      source: value.source || metadata.source || "unknown",
      failed: Boolean(value.failed ?? metadata.failed),
      error: value.error || metadata.error || null,
      model: value.model || metadata.model || null,
    };
  }

  return {
    text: String(value || ""),
    source: metadata.source || "unknown",
    failed: Boolean(metadata.failed),
    error: metadata.error || null,
    model: metadata.model || null,
  };
}

function hasChatMessages(messages) {
  return messages.some((message) => message?.author !== "system" && message?.text);
}

function pick(values, random = Math.random) {
  return values[Math.floor(random() * values.length)];
}

function pickWeighted(weightedValues, random = Math.random) {
  const total = weightedValues.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;

  for (const [value, weight] of weightedValues) {
    roll -= weight;

    if (roll < 0) {
      return value;
    }
  }

  return weightedValues[weightedValues.length - 1][0];
}

function randomInt(min, max, random = Math.random) {
  return Math.floor(random() * (max - min + 1)) + min;
}

// Skew toward gen z, but keep a tail of older personas so it is not a giveaway.
function youngLeaningAge(random = Math.random) {
  return random() < 0.75 ? randomInt(16, 26, random) : randomInt(27, 45, random);
}

module.exports = {
  LOCATION_POOLS,
  MODEL_FAMILIES,
  buildAiReplyResult,
  buildLocationInstructions,
  buildPersonaInstructions,
  createConversationPersona,
  createLocationProfile,
  hasChatMessages,
  pick,
  pickWeighted,
};
