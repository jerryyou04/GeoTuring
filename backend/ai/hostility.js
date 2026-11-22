const HOSTILE_TRIGGERS = readHostileTriggers();

function readHostileTriggers() {
  const value = process.env.AI_HOSTILE_TRIGGERS;

  if (!value?.trim()) {
    return [];
  }

  let triggers;
  try {
    triggers = JSON.parse(value);
  } catch {
    throw new Error("AI_HOSTILE_TRIGGERS must be a JSON array of nonempty strings.");
  }

  if (!Array.isArray(triggers) || triggers.some((trigger) => typeof trigger !== "string" || !trigger.trim())) {
    throw new Error("AI_HOSTILE_TRIGGERS must be a JSON array of nonempty strings.");
  }

  return triggers.map((trigger) => trigger.trim().toLowerCase());
}

function isMessageHostile(text) {
  const normalized = String(text || "").toLowerCase();
  return HOSTILE_TRIGGERS.some((trigger) => normalized.includes(trigger));
}

module.exports = { isMessageHostile };
