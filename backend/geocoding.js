const DEFAULT_NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const DEFAULT_GEOAPIFY_URL = "https://api.geoapify.com/v1/geocode/reverse";
const DEFAULT_USER_AGENT = "GeoTuring/0.1 (+https://geoturing.com)";
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CACHE_MAX_ENTRIES = 500;
const DEFAULT_CACHE_GRID_DEGREES = 0.01;
const DEFAULT_POSITIVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_UNAVAILABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESULT_DISTANCE_KM = 100;
const NOMINATIM_MIN_REQUEST_INTERVAL_MS = 1000;

const WATER_FEATURE_TYPES = new Set([
  "bay",
  "gulf",
  "lake",
  "ocean",
  "reservoir",
  "sea",
  "strait",
  "water",
]);

const POINT_LIKE_NOMINATIM_TYPES = new Set([
  "amenity",
  "building",
  "city",
  "hamlet",
  "house",
  "locality",
  "place",
  "road",
  "shop",
  "suburb",
  "town",
  "village",
]);

const POINT_LIKE_GEOAPIFY_TYPES = new Set([
  "amenity",
  "building",
  "city",
  "locality",
  "place",
  "street",
  "suburb",
]);

/**
 * Build an isolated resolver. Production uses the singleton exported below;
 * tests can inject fetch, the clock, and sleep without changing global state.
 */
function createGuessPlaceResolver({
  env = process.env,
  fetchImpl = (...args) => global.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const config = buildConfig(env);
  const cache = new Map();
  const inFlight = new Map();
  let nextNominatimRequestAt = 0;

  async function resolveGuessPlace(pin) {
    try {
      return await resolveGuessPlaceInternal(pin);
    } catch {
      // This is a cosmetic enrichment. No malformed input, provider failure, or
      // cache/timer edge case is allowed to affect scoring or the final reveal.
      return unavailableResult();
    }
  }

  async function resolveGuessPlaceInternal(pin) {
    const normalizedPin = normalizePin(pin);

    if (!normalizedPin) {
      return unavailableResult();
    }

    const cacheKey = buildCacheKey(config.provider, normalizedPin, config.cacheGridDegrees);
    const cached = readCache(cache, cacheKey, now());

    if (cached) {
      return cloneResult(cached);
    }

    if (inFlight.has(cacheKey)) {
      return cloneResult(await inFlight.get(cacheKey));
    }

    const request = lookup(normalizedPin)
      .then(({ result, cacheTtlMs }) => {
        if (cacheTtlMs > 0) {
          writeCache(cache, cacheKey, result, now() + cacheTtlMs, config.cacheMaxEntries);
        }

        return result;
      })
      .catch(() => unavailableResult())
      .finally(() => {
        inFlight.delete(cacheKey);
      });

    inFlight.set(cacheKey, request);
    return cloneResult(await request);
  }

  async function lookup(pin) {
    const request = (timeoutMs = config.timeoutMs) => fetchPlace(
      pin,
      { ...config, timeoutMs },
      fetchImpl,
    );
    let response;

    try {
      response = config.provider === "nominatim"
        ? await enqueueNominatimRequest(request)
        : await request();
    } catch {
      // Network errors, timeouts, invalid provider configuration, and malformed
      // responses are transient. Fail open without poisoning the long-lived cache.
      return { result: unavailableResult(), cacheTtlMs: 0 };
    }

    if (!response.ok) {
      return { result: unavailableResult(), cacheTtlMs: 0 };
    }

    const place = config.provider === "geoapify"
      ? parseGeoapifyResponse(response.data, pin, config.maxResultDistanceKm)
      : parseNominatimResponse(response.data, pin, config.maxResultDistanceKm);

    if (!place) {
      // A successful provider response with no acceptable land location is an
      // intentional no-result (usually ocean/water), so cache it to protect the
      // public service from repeated identical misses.
      return {
        result: unavailableResult(),
        cacheTtlMs: config.unavailableCacheTtlMs,
      };
    }

    return {
      result: {
        status: "resolved",
        place,
      },
      cacheTtlMs: config.positiveCacheTtlMs,
    };
  }

  function enqueueNominatimRequest(request) {
    const requestedAt = now();
    const scheduledAt = Math.max(requestedAt, nextNominatimRequestAt);
    const waitMs = scheduledAt - requestedAt;

    // Do not let a busy public-provider queue hold a game-history write open.
    // Overflow requests fail open before reserving a slot, so their submitted
    // coordinates still persist and the UI uses the kilometre fallback.
    if (waitMs >= config.timeoutMs) {
      return Promise.reject(new Error("reverse_geocoding_queue_timeout"));
    }

    nextNominatimRequestAt = scheduledAt + NOMINATIM_MIN_REQUEST_INTERVAL_MS;

    return (async () => {
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      return request(Math.max(100, config.timeoutMs - waitMs));
    })();
  }

  return {
    resolveGuessPlace,
    clearCache() {
      cache.clear();
      inFlight.clear();
    },
  };
}

function buildConfig(env) {
  const apiKey = cleanText(env.GEOAPIFY_API_KEY, 500);
  const provider = apiKey ? "geoapify" : "nominatim";
  const defaultUrl = provider === "geoapify" ? DEFAULT_GEOAPIFY_URL : DEFAULT_NOMINATIM_URL;

  return {
    provider,
    apiKey,
    baseUrl: cleanText(env.GEOCODING_BASE_URL, 1000) || defaultUrl,
    userAgent: cleanText(env.GEOCODING_USER_AGENT, 500) || DEFAULT_USER_AGENT,
    timeoutMs: finiteNumberInRange(env.GEOCODING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 15000),
    cacheMaxEntries: finiteNumberInRange(
      env.GEOCODING_CACHE_MAX_ENTRIES,
      DEFAULT_CACHE_MAX_ENTRIES,
      1,
      10000,
    ),
    cacheGridDegrees: finiteNumberInRange(
      env.GEOCODING_CACHE_GRID_DEGREES,
      DEFAULT_CACHE_GRID_DEGREES,
      0.001,
      1,
    ),
    positiveCacheTtlMs: finiteNumberInRange(
      env.GEOCODING_CACHE_TTL_MS,
      DEFAULT_POSITIVE_CACHE_TTL_MS,
      1000,
      365 * 24 * 60 * 60 * 1000,
    ),
    unavailableCacheTtlMs: finiteNumberInRange(
      env.GEOCODING_UNAVAILABLE_CACHE_TTL_MS,
      DEFAULT_UNAVAILABLE_CACHE_TTL_MS,
      1000,
      30 * 24 * 60 * 60 * 1000,
    ),
    maxResultDistanceKm: finiteNumberInRange(
      env.GEOCODING_MAX_RESULT_DISTANCE_KM,
      DEFAULT_MAX_RESULT_DISTANCE_KM,
      1,
      1000,
    ),
  };
}

async function fetchPlace(pin, config, fetchImpl) {
  const url = new URL(config.baseUrl);

  if (config.provider === "geoapify") {
    url.searchParams.set("lat", String(pin.lat));
    url.searchParams.set("lon", String(pin.lng));
    url.searchParams.set("format", "json");
    url.searchParams.set("apiKey", config.apiKey);
  } else {
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(pin.lat));
    url.searchParams.set("lon", String(pin.lng));
    url.searchParams.set("zoom", "10");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("layer", "address");
    url.searchParams.set("accept-language", "en");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
      },
      signal: controller.signal,
    });

    if (!response || !response.ok) {
      return {
        ok: false,
        status: Number(response?.status) || 0,
        data: null,
      };
    }

    return {
      ok: true,
      status: Number(response.status) || 200,
      data: await response.json(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseNominatimResponse(data, queryPin, maxDistanceKm = DEFAULT_MAX_RESULT_DISTANCE_KM) {
  if (!isObject(data) || isExplicitWaterFeature(data)) {
    return null;
  }

  const address = isObject(data.address) ? data.address : {};
  const place = buildGuessPlace({
    city: firstText(
      address.city,
      address.town,
      address.village,
      address.municipality,
      address.hamlet,
      address.locality,
      address.suburb,
    ),
    region: firstText(
      address.state,
      address.region,
      address.province,
      address.state_district,
      address.county,
    ),
    country: address.country,
    countryCode: address.country_code,
  });

  if (!place || isImplausiblyDistantNominatim(data, queryPin, maxDistanceKm)) {
    return null;
  }

  return place;
}

function parseGeoapifyResponse(data, queryPin, maxDistanceKm = DEFAULT_MAX_RESULT_DISTANCE_KM) {
  const result = Array.isArray(data?.results) ? data.results[0] : null;

  if (!isObject(result) || isExplicitWaterFeature(result)) {
    return null;
  }

  const place = buildGuessPlace({
    city: firstText(
      result.city,
      result.town,
      result.village,
      result.municipality,
      result.hamlet,
      result.locality,
      result.suburb,
    ),
    region: firstText(
      result.state,
      result.region,
      result.province,
      result.state_district,
      result.county,
    ),
    country: result.country,
    countryCode: result.country_code,
  });

  if (!place || isImplausiblyDistantGeoapify(result, queryPin, maxDistanceKm)) {
    return null;
  }

  return place;
}

function buildGuessPlace({ city, region, country, countryCode }) {
  const cleanCountry = cleanText(country, 100);

  if (!cleanCountry) {
    return null;
  }

  const cleanCity = cleanText(city, 100);
  const cleanRegion = cleanText(region, 100);
  const cleanCountryCode = normalizeCountryCode(countryCode);
  const labelParts = uniquePlaceParts([cleanCity, cleanRegion, cleanCountry]);
  const place = {
    country: cleanCountry,
    label: labelParts.join(", "),
  };

  if (cleanCity) {
    place.city = cleanCity;
  }

  if (cleanRegion) {
    place.region = cleanRegion;
  }

  if (cleanCountryCode) {
    place.countryCode = cleanCountryCode;
  }

  return place;
}

function isExplicitWaterFeature(record) {
  const raw = isObject(record?.datasource?.raw) ? record.datasource.raw : {};
  const classifications = [
    record?.category,
    record?.type,
    record?.addresstype,
    record?.result_type,
    raw.natural,
    raw.place,
    raw.water,
    raw.waterway,
  ];

  return classifications.some((value) => {
    const normalized = cleanText(value, 100)?.toLowerCase();

    if (!normalized) {
      return false;
    }

    return normalized
      .split(/[^a-z]+/)
      .filter(Boolean)
      .some((token) => WATER_FEATURE_TYPES.has(token));
  });
}

function isImplausiblyDistantNominatim(record, queryPin, maxDistanceKm) {
  const explicitDistanceKm = readExplicitDistanceKm(record);

  if (explicitDistanceKm !== null) {
    return explicitDistanceKm > maxDistanceKm;
  }

  const topLevelType = cleanText(record.type, 100)?.toLowerCase() || "";
  const addressType = cleanText(record.addresstype, 100)?.toLowerCase() || "";

  // Administrative relations often report a centroid far from a legitimate
  // in-boundary click. Accept those only when the provider's bounding box
  // contains the query; otherwise apply the same nearest-land cutoff.
  if (topLevelType === "administrative") {
    return isQueryInsideBoundingBox(record.boundingbox, queryPin)
      ? false
      : isReturnedPointTooFar(record, queryPin, maxDistanceKm);
  }

  if (!POINT_LIKE_NOMINATIM_TYPES.has(addressType || topLevelType)) {
    return false;
  }

  return isReturnedPointTooFar(record, queryPin, maxDistanceKm);
}

function isQueryInsideBoundingBox(value, queryPin) {
  if (!Array.isArray(value) || value.length < 4) {
    return false;
  }

  const [south, north, west, east] = value.map(Number);
  const pin = normalizePin(queryPin);

  if (
    !pin ||
    ![south, north, west, east].every(Number.isFinite) ||
    south > north
  ) {
    return false;
  }

  const withinLatitude = pin.lat >= south && pin.lat <= north;
  const withinLongitude = west <= east
    ? pin.lng >= west && pin.lng <= east
    : pin.lng >= west || pin.lng <= east;

  return withinLatitude && withinLongitude;
}

function isImplausiblyDistantGeoapify(record, queryPin, maxDistanceKm) {
  const explicitDistanceKm = readExplicitDistanceKm(record);

  if (explicitDistanceKm !== null) {
    return explicitDistanceKm > maxDistanceKm;
  }

  const resultType = cleanText(record.result_type, 100)?.toLowerCase() || "";

  if (!POINT_LIKE_GEOAPIFY_TYPES.has(resultType)) {
    return false;
  }

  return isReturnedPointTooFar(record, queryPin, maxDistanceKm);
}

function readExplicitDistanceKm(record) {
  const candidates = [
    record?.distance,
    record?.rank?.distance,
  ];

  for (const value of candidates) {
    const distanceMeters = Number(value);

    if (Number.isFinite(distanceMeters) && distanceMeters >= 0) {
      return distanceMeters / 1000;
    }
  }

  return null;
}

function isReturnedPointTooFar(record, queryPin, maxDistanceKm) {
  const resultPin = normalizePin({
    lat: record?.lat,
    lng: record?.lon ?? record?.lng,
  });
  const normalizedQuery = normalizePin(queryPin);

  if (!resultPin || !normalizedQuery) {
    return false;
  }

  return haversineKm(normalizedQuery, resultPin) > maxDistanceKm;
}

function haversineKm(first, second) {
  const earthRadiusKm = 6371;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(second.lat - first.lat);
  const dLng = toRadians(second.lng - first.lng);
  const lat1 = toRadians(first.lat);
  const lat2 = toRadians(second.lat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const clampedA = Math.min(1, Math.max(0, a));

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
}

function normalizePin(pin) {
  let lat;
  let lng;

  try {
    lat = Number(pin?.lat);
    lng = Number(pin?.lng);
  } catch {
    return null;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}

function buildCacheKey(provider, pin, gridDegrees) {
  const lat = roundedGridCoordinate(pin.lat, gridDegrees);
  const lng = roundedGridCoordinate(pin.lng, gridDegrees);

  return `guess-place:v1:${provider}:${lat}:${lng}`;
}

function roundedGridCoordinate(value, gridDegrees) {
  const rounded = Math.round(value / gridDegrees) * gridDegrees;
  const withoutNegativeZero = Object.is(rounded, -0) ? 0 : rounded;

  return withoutNegativeZero.toFixed(4);
}

function readCache(cache, key, timestamp) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= timestamp) {
    cache.delete(key);
    return null;
  }

  // Refresh insertion order so the bounded Map behaves as a small LRU cache.
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function writeCache(cache, key, result, expiresAt, maxEntries) {
  cache.delete(key);
  cache.set(key, {
    result: cloneResult(result),
    expiresAt,
  });

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function cloneResult(result) {
  return {
    status: result?.status === "resolved" ? "resolved" : "unavailable",
    place: result?.place ? { ...result.place } : null,
  };
}

function unavailableResult() {
  return {
    status: "unavailable",
    place: null,
  };
}

function uniquePlaceParts(parts) {
  const seen = new Set();
  const result = [];

  for (const part of parts) {
    if (!part) {
      continue;
    }

    const key = part.toLocaleLowerCase("en");

    if (!seen.has(key)) {
      seen.add(key);
      result.push(part);
    }
  }

  return result;
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value, 100);

    if (text) {
      return text;
    }
  }

  return "";
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function finiteNumberInRange(value, fallback, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function normalizeCountryCode(value) {
  const code = cleanText(value, 3).toUpperCase();

  return /^[A-Z]{2,3}$/.test(code) ? code : "";
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

const defaultResolver = createGuessPlaceResolver();

module.exports = {
  buildGuessPlace,
  createGuessPlaceResolver,
  parseGeoapifyResponse,
  parseNominatimResponse,
  resolveGuessPlace: defaultResolver.resolveGuessPlace,
};
