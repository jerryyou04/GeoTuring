const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOCATION_POOLS,
  buildPersonaInstructions,
  createConversationPersona,
  createLocationProfile,
  pickWeighted,
} = require("../ai/common");
const { createMockAiProvider } = require("../ai/mockProvider");

test("location pools are large, valid, unique, and weighted toward North America", () => {
  const totalWeight = LOCATION_POOLS.reduce((sum, pool) => sum + pool.weight, 0);
  const northAmericaWeight = LOCATION_POOLS
    .filter((pool) => pool.worldRegion === "north-america")
    .reduce((sum, pool) => sum + pool.weight, 0);
  const places = LOCATION_POOLS.flatMap((pool) =>
    pool.places.map(([city, country, timeZone]) => ({
      poolId: pool.id,
      worldRegion: pool.worldRegion,
      city,
      country,
      timeZone,
    })),
  );

  assert.equal(totalWeight, 100);
  assert.equal(northAmericaWeight, 58);
  assert.ok(places.length >= 190);
  assert.equal(new Set(LOCATION_POOLS.map((pool) => pool.id)).size, LOCATION_POOLS.length);
  assert.equal(
    new Set(places.map((place) => `${place.city}|${place.country}`)).size,
    places.length,
  );

  const weightsByRegion = new Map();

  for (const pool of LOCATION_POOLS) {
    assert.ok(Number.isSafeInteger(pool.weight) && pool.weight > 0);
    assert.ok(pool.places.length > 0);
    weightsByRegion.set(
      pool.worldRegion,
      (weightsByRegion.get(pool.worldRegion) || 0) + pool.weight,
    );
  }

  for (const [region, weight] of weightsByRegion) {
    if (region !== "north-america") {
      assert.ok(northAmericaWeight > weight);
    }
  }

  for (const place of places) {
    assert.ok(place.city);
    assert.ok(place.country);
    assert.ok(place.timeZone.includes("/"));
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat("en-US", { timeZone: place.timeZone })
        .format(new Date("2026-01-15T15:30:45.000Z")),
      `${place.city}, ${place.country} has invalid time zone ${place.timeZone}`,
    );
  }
});

test("weighted location selection is deterministic at pool boundaries", () => {
  assert.deepEqual(createLocationProfile(() => 0), {
    poolId: "canada",
    worldRegion: "north-america",
    city: "Vancouver",
    country: "Canada",
    timeZone: "America/Vancouver",
  });
  assert.deepEqual(createLocationProfile(() => 0.999999), {
    poolId: "africa",
    worldRegion: "africa",
    city: "Port Louis",
    country: "Mauritius",
    timeZone: "Indian/Mauritius",
  });

  const weightedValues = [["first", 2], ["second", 3], ["third", 5]];
  const counts = new Map();

  for (let ticket = 0; ticket < 10; ticket += 1) {
    const value = pickWeighted(weightedValues, () => (ticket + 0.5) / 10);
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  assert.deepEqual(Object.fromEntries(counts), {
    first: 2,
    second: 3,
    third: 5,
  });
});

test("generated personas keep one assigned place and a matching disclosure style", () => {
  const persona = createConversationPersona(() => 0);
  const instructions = buildPersonaInstructions(persona);

  assert.deepEqual(persona.location, {
    poolId: "canada",
    worldRegion: "north-america",
    city: "Vancouver",
    country: "Canada",
    timeZone: "America/Vancouver",
  });
  assert.equal(persona.locationDisclosure, "direct");
  assert.match(instructions, /You are from and currently chatting from Vancouver, Canada\./);
  assert.match(instructions, /IANA time zone: America\/Vancouver\./);
  assert.match(instructions, /Keep this same location for the entire match\./);
  assert.match(instructions, /answer naturally using Vancouver or Canada/);
  assert.doesNotMatch(instructions, /undefined|null|\[object Object\]/);
});

test("mock replies use the assigned location instead of inventing another one", async () => {
  const persona = {
    age: 24,
    humor: "dry",
    verbosity: "short",
    emojiUsage: "never",
    casing: "lowercase",
    punctuation: "casual",
    confidence: "medium",
    curiosity: "medium",
    suspicion: "medium",
    location: {
      poolId: "europe",
      worldRegion: "europe",
      city: "Dublin",
      country: "Ireland",
      timeZone: "Europe/Dublin",
    },
    locationDisclosure: "direct",
  };
  const provider = createMockAiProvider("ChatGPT", persona);
  const result = await provider.generateReply([
    { author: "player", text: "where are you from?" },
  ]);

  assert.match(result.text, /dublin/i);
  assert.doesNotMatch(result.text, /antarctica|mars/i);
});
