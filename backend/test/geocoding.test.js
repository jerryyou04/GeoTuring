const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildGuessPlace,
  createGuessPlaceResolver,
  parseGeoapifyResponse,
  parseNominatimResponse,
} = require("../geocoding");

test("Nominatim responses become concise structured places", () => {
  const place = parseNominatimResponse(
    {
      category: "boundary",
      type: "administrative",
      addresstype: "city",
      lat: "43.6532",
      lon: "-79.3832",
      display_name: "A deliberately verbose provider address that must not leak",
      address: {
        city: " Toronto ",
        state: "Ontario",
        country: "Canada",
        country_code: "ca",
        road: "Queen Street West",
        postcode: "M5V",
      },
    },
    { lat: 43.65, lng: -79.38 },
  );

  assert.deepEqual(place, {
    label: "Toronto, Ontario, Canada",
    city: "Toronto",
    region: "Ontario",
    country: "Canada",
    countryCode: "CA",
  });
  assert.equal("road" in place, false);
  assert.equal("displayName" in place, false);
});

test("country-only land resolves, while water, missing-country, and distant nearest-land results do not", () => {
  const countryOnly = parseNominatimResponse(
    {
      category: "boundary",
      type: "administrative",
      addresstype: "country",
      address: {
        country: "Iceland",
        country_code: "is",
      },
    },
    { lat: 64.9, lng: -18.6 },
  );
  const water = parseNominatimResponse(
    {
      category: "natural",
      type: "ocean",
      addresstype: "ocean",
      address: {
        country: "Portugal",
      },
    },
    { lat: 30, lng: -40 },
  );
  const missingCountry = parseNominatimResponse(
    {
      category: "place",
      type: "city",
      addresstype: "city",
      address: {
        city: "Mystery City",
      },
    },
    { lat: 10, lng: 10 },
  );
  const distantNearestLand = parseNominatimResponse(
    {
      category: "place",
      type: "city",
      addresstype: "city",
      lat: "51.5074",
      lon: "-0.1278",
      address: {
        city: "London",
        country: "United Kingdom",
      },
    },
    { lat: 0, lng: 0 },
    100,
  );
  const distantCountryRelation = parseNominatimResponse(
    {
      category: "boundary",
      type: "administrative",
      addresstype: "country",
      lat: "54",
      lon: "-2",
      boundingbox: ["49", "61", "-8", "2"],
      address: {
        country: "United Kingdom",
        country_code: "gb",
      },
    },
    { lat: 0, lng: 0 },
    100,
  );
  const inBoundaryCountryRelation = parseNominatimResponse(
    {
      category: "boundary",
      type: "administrative",
      addresstype: "country",
      lat: "56",
      lon: "-106",
      boundingbox: ["41", "84", "-141", "-52"],
      address: {
        country: "Canada",
        country_code: "ca",
      },
    },
    { lat: 70, lng: -90 },
    100,
  );

  assert.deepEqual(countryOnly, {
    label: "Iceland",
    country: "Iceland",
    countryCode: "IS",
  });
  assert.equal(water, null);
  assert.equal(missingCountry, null);
  assert.equal(distantNearestLand, null);
  assert.equal(distantCountryRelation, null);
  assert.equal(inBoundaryCountryRelation?.label, "Canada");
});

test("Geoapify responses use the same shape and honor explicit provider distance", () => {
  const response = {
    results: [
      {
        city: "Barcelona",
        state: "Catalonia",
        country: "Spain",
        country_code: "es",
        result_type: "city",
        lat: 41.3874,
        lon: 2.1686,
        distance: 350,
        formatted: "Verbose provider-formatted address",
      },
    ],
  };

  assert.deepEqual(parseGeoapifyResponse(response, { lat: 41.39, lng: 2.17 }), {
    label: "Barcelona, Catalonia, Spain",
    city: "Barcelona",
    region: "Catalonia",
    country: "Spain",
    countryCode: "ES",
  });

  response.results[0].distance = 250000;
  assert.equal(parseGeoapifyResponse(response, { lat: 41.39, lng: 2.17 }, 100), null);

  response.results[0].distance = 350;
  response.results[0].category = "natural.water";
  assert.equal(parseGeoapifyResponse(response, { lat: 41.39, lng: 2.17 }), null);
});

test("Geoapify is selected when its key is configured", async () => {
  let requestedUrl = "";
  let requestedOptions = null;
  const resolver = createGuessPlaceResolver({
    env: {
      GEOAPIFY_API_KEY: "test-secret",
      GEOCODING_BASE_URL: "https://geo.example/reverse",
      GEOCODING_USER_AGENT: "GeoTuring tests",
    },
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return jsonResponse({
        results: [
          {
            city: "Calgary",
            state: "Alberta",
            country: "Canada",
            country_code: "ca",
            result_type: "city",
            distance: 25,
          },
        ],
      });
    },
  });

  const result = await resolver.resolveGuessPlace({ lat: 51.0447, lng: -114.0719 });
  const url = new URL(requestedUrl);

  assert.equal(url.origin + url.pathname, "https://geo.example/reverse");
  assert.equal(url.searchParams.get("apiKey"), "test-secret");
  assert.equal(url.searchParams.get("lat"), "51.0447");
  assert.equal(url.searchParams.get("lon"), "-114.0719");
  assert.equal(requestedOptions.headers["User-Agent"], "GeoTuring tests");
  assert.deepEqual(result, {
    status: "resolved",
    place: {
      label: "Calgary, Alberta, Canada",
      city: "Calgary",
      region: "Alberta",
      country: "Canada",
      countryCode: "CA",
    },
  });
});

test("default Nominatim calls are identified, globally throttled, and cached", async () => {
  let timestamp = 10000;
  let fetchCount = 0;
  const sleeps = [];
  const requestedOptions = [];
  const resolver = createGuessPlaceResolver({
    env: {
      GEOCODING_BASE_URL: "https://nominatim.example/reverse",
      GEOCODING_USER_AGENT: "GeoTuring throttle test (+https://example.test)",
    },
    now: () => timestamp,
    sleep: async (ms) => {
      sleeps.push(ms);
      timestamp += ms;
    },
    fetchImpl: async (url, options) => {
      fetchCount += 1;
      requestedOptions.push(options);
      const requestUrl = new URL(url);
      const isToronto = Number(requestUrl.searchParams.get("lon")) < -100
        ? false
        : Number(requestUrl.searchParams.get("lon")) < -70;

      return jsonResponse({
        category: "boundary",
        type: "administrative",
        addresstype: "city",
        address: isToronto
          ? { city: "Toronto", state: "Ontario", country: "Canada", country_code: "ca" }
          : { city: "Vancouver", state: "British Columbia", country: "Canada", country_code: "ca" },
      });
    },
  });

  const toronto = await resolver.resolveGuessPlace({ lat: 43.6532, lng: -79.3832 });
  const cachedToronto = await resolver.resolveGuessPlace({ lat: 43.6532, lng: -79.3832 });

  timestamp += 100;
  const vancouver = await resolver.resolveGuessPlace({ lat: 49.2827, lng: -123.1207 });

  assert.equal(fetchCount, 2);
  assert.deepEqual(sleeps, [900]);
  assert.equal(requestedOptions[0].headers["User-Agent"], "GeoTuring throttle test (+https://example.test)");
  assert.equal(toronto.place.label, "Toronto, Ontario, Canada");
  assert.equal(cachedToronto.place.label, "Toronto, Ontario, Canada");
  assert.equal(vancouver.place.label, "Vancouver, British Columbia, Canada");

  // Cached values are cloned so consumers cannot corrupt later results.
  toronto.place.label = "mutated";
  const safeCachedToronto = await resolver.resolveGuessPlace({ lat: 43.6532, lng: -79.3832 });
  assert.equal(safeCachedToronto.place.label, "Toronto, Ontario, Canada");
});

test("Nominatim queue overflow fails open within the total timeout", async () => {
  let timestamp = 10000;
  let fetchCount = 0;
  const sleeps = [];
  const resolver = createGuessPlaceResolver({
    env: {
      GEOCODING_BASE_URL: "https://nominatim.example/reverse",
      GEOCODING_TIMEOUT_MS: "1500",
    },
    now: () => timestamp,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({
        category: "boundary",
        type: "administrative",
        addresstype: "city",
        address: {
          city: `City ${fetchCount}`,
          country: "Canada",
        },
      });
    },
  });

  const [first, second, overflow] = await Promise.all([
    resolver.resolveGuessPlace({ lat: 43, lng: -79 }),
    resolver.resolveGuessPlace({ lat: 49, lng: -123 }),
    resolver.resolveGuessPlace({ lat: 51, lng: -114 }),
  ]);

  assert.equal(first.status, "resolved");
  assert.equal(second.status, "resolved");
  assert.deepEqual(overflow, { status: "unavailable", place: null });
  assert.equal(fetchCount, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("concurrent requests for one cache cell share a single provider call", async () => {
  let fetchCount = 0;
  let releaseFetch;
  const resolver = createGuessPlaceResolver({
    env: {
      GEOAPIFY_API_KEY: "test-secret",
    },
    fetchImpl: () => {
      fetchCount += 1;

      return new Promise((resolve) => {
        releaseFetch = () => resolve(jsonResponse({
          results: [
            {
              city: "Dublin",
              country: "Ireland",
              country_code: "ie",
              result_type: "city",
              distance: 20,
            },
          ],
        }));
      });
    },
  });

  const first = resolver.resolveGuessPlace({ lat: 53.3498, lng: -6.2603 });
  const second = resolver.resolveGuessPlace({ lat: 53.3498, lng: -6.2603 });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 1);

  releaseFetch();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.place.label, "Dublin, Ireland");
});

test("intentional no-results are cached, but transient provider failures are retried", async () => {
  let noResultCalls = 0;
  const noResultResolver = createGuessPlaceResolver({
    env: {
      GEOAPIFY_API_KEY: "test-secret",
    },
    fetchImpl: async () => {
      noResultCalls += 1;
      return jsonResponse({ results: [] });
    },
  });

  assert.deepEqual(
    await noResultResolver.resolveGuessPlace({ lat: 0, lng: -140 }),
    { status: "unavailable", place: null },
  );
  assert.deepEqual(
    await noResultResolver.resolveGuessPlace({ lat: 0, lng: -140 }),
    { status: "unavailable", place: null },
  );
  assert.equal(noResultCalls, 1);

  let transientCalls = 0;
  const transientResolver = createGuessPlaceResolver({
    env: {
      GEOAPIFY_API_KEY: "test-secret",
    },
    fetchImpl: async () => {
      transientCalls += 1;

      if (transientCalls === 1) {
        throw new Error("temporary network failure");
      }

      return jsonResponse({
        results: [
          {
            country: "New Zealand",
            country_code: "nz",
            result_type: "country",
          },
        ],
      });
    },
  });

  assert.deepEqual(
    await transientResolver.resolveGuessPlace({ lat: -41, lng: 174 }),
    { status: "unavailable", place: null },
  );
  assert.equal(
    (await transientResolver.resolveGuessPlace({ lat: -41, lng: 174 })).place.label,
    "New Zealand",
  );
  assert.equal(transientCalls, 2);
});

test("invalid input and aborted requests always fail open", async () => {
  let fetchCount = 0;
  const resolver = createGuessPlaceResolver({
    env: {
      GEOAPIFY_API_KEY: "test-secret",
      GEOCODING_TIMEOUT_MS: "100",
    },
    fetchImpl: async (url, { signal }) => {
      fetchCount += 1;

      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });

  assert.deepEqual(
    await resolver.resolveGuessPlace({ lat: 91, lng: 0 }),
    { status: "unavailable", place: null },
  );
  assert.deepEqual(
    await resolver.resolveGuessPlace({ lat: Symbol("bad"), lng: 0 }),
    { status: "unavailable", place: null },
  );
  assert.deepEqual(
    await resolver.resolveGuessPlace({ lat: 40, lng: -70 }),
    { status: "unavailable", place: null },
  );
  assert.equal(fetchCount, 1);
});

test("place labels de-duplicate repeated administrative names", () => {
  assert.deepEqual(
    buildGuessPlace({
      city: "Singapore",
      region: "Singapore",
      country: "Singapore",
      countryCode: "sg",
    }),
    {
      label: "Singapore",
      city: "Singapore",
      region: "Singapore",
      country: "Singapore",
      countryCode: "SG",
    },
  );
});

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return data;
    },
  };
}
