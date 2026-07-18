const REGISTRY_TTL_SECONDS = 604800;
const MAX_DISCOVERY_RESULTS = 50;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_PUBLIC_PROFILE_BYTES = 4 * 1024;
const MAX_PUBLIC_KEY_BYTES = 12 * 1024;
const MAX_DISPLAY_NAME_CHARACTERS = 10;
const ID_PATTERN = /^teti_[a-z0-9]{9}$/;
const CHATMAIL_LOCAL_PART_PATTERN = /^[a-z0-9]{9}$/;
const CHATMAIL_DOMAIN = "mail.seep.im";
const PRIVATE_FIELD_NAMES = new Set([
  "privateKey",
  "chatCredentials",
  "credentials",
  "privateProfile",
  "connectionGraph",
  "connections",
  "conversationHistory",
  "agentHistory",
  "files",
  "sourceCode",
  "documents",
  "prompts",
  "apiKeys",
  "apiKey",
  "ip",
  "ipAddress",
  "mac",
  "macAddress",
  "hostname",
  "username",
  "user",
  "serialNumber",
  "filesystemPath",
  "path"
]);

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return emptyResponse(204);
  }

  try {
    assertRegistry(env);

    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);

    if (request.method === "POST" && pathname === "/register") {
      return await registerIdentity(request, env);
    }

    if (request.method === "POST" && pathname === "/heartbeat") {
      return await heartbeatIdentity(request, env);
    }

    if (request.method === "GET" && pathname === "/discover") {
      return await discoverIdentities(env);
    }

    if (request.method === "GET" && pathname.startsWith("/profile/")) {
      const id = decodeURIComponent(pathname.slice("/profile/".length));
      return await getIdentityProfile(env, id);
    }

    return errorResponse(404, "NOT_FOUND", "Route not found.");
  } catch (error) {
    if (error instanceof RegistryError) {
      return errorResponse(error.status, error.code, error.message);
    }

    return errorResponse(500, "INTERNAL_ERROR", "Unexpected registry error.");
  }
}

async function registerIdentity(request, env) {
  const input = await readJson(request);
  const validation = validateRegistration(input);

  if (!validation.valid) {
    throw new RegistryError(400, "INVALID_REQUEST", validation.message);
  }

  const now = new Date().toISOString();
  const publicProfile = sanitizePublicProfile(input.publicProfile);
  const key = registryKey(input.id);
  const existing = await readIdentity(env, key);
  if (existing) {
    if (existing.address !== input.address || existing.publicKey !== input.publicKey) {
      throw new RegistryError(409, "IDENTITY_EXISTS", "Identity already exists with different public identity data.");
    }

    const retriedRecord = toPublicIdentityCard({
      ...existing,
      displayName: normalizeDisplayName(input.displayName) ?? existing.displayName,
      publicProfile,
      lastSeen: publicProfile.lastSeen || existing.lastSeen || now,
      updatedAt: now
    });
    await env.TETI.put(key, JSON.stringify(retriedRecord), {
      expirationTtl: REGISTRY_TTL_SECONDS
    });
    return jsonResponse(200, { success: true, data: retriedRecord });
  }

  const record = toPublicIdentityCard({
    version: 1,
    id: input.id,
    address: input.address,
    displayName: normalizeDisplayName(input.displayName),
    publicKey: input.publicKey,
    publicProfile,
    lastSeen: publicProfile.lastSeen || now,
    createdAt: now,
    updatedAt: now
  });

  await env.TETI.put(key, JSON.stringify(record), {
    expirationTtl: REGISTRY_TTL_SECONDS
  });

  return jsonResponse(201, { success: true, data: record });
}

async function heartbeatIdentity(request, env) {
  const input = await readJson(request);
  const validation = validateHeartbeat(input);

  if (!validation.valid) {
    throw new RegistryError(400, "INVALID_REQUEST", validation.message);
  }

  const key = registryKey(input.id);
  const existing = await readIdentity(env, key);
  if (!existing) {
    throw new RegistryError(404, "IDENTITY_NOT_FOUND", "Identity not found.");
  }

  const updated = toPublicIdentityCard({
    ...existing,
    publicProfile: input.publicProfile
      ? sanitizePublicProfile(input.publicProfile)
      : sanitizePublicProfile(existing.publicProfile || {}),
    lastSeen: input.publicProfile?.lastSeen || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  await env.TETI.put(key, JSON.stringify(updated), {
    expirationTtl: REGISTRY_TTL_SECONDS
  });

  return jsonResponse(200, { success: true, data: updated });
}

async function discoverIdentities(env) {
  const listed = await env.TETI.list({
    prefix: "teti:",
    limit: MAX_DISCOVERY_RESULTS
  });

  const records = await Promise.all(
    listed.keys.slice(0, MAX_DISCOVERY_RESULTS).map((entry) => readIdentity(env, entry.name))
  );

  const identities = records.filter(Boolean).map(toPublicIdentityCard);

  return jsonResponse(200, {
    success: true,
    data: {
      items: identities,
      count: identities.length
    }
  });
}

async function getIdentityProfile(env, id) {
  const canonicalId = typeof id === "string" ? id.toLowerCase() : id;
  if (!isValidId(canonicalId)) {
    throw new RegistryError(400, "INVALID_ID", "Invalid Teti ID.");
  }

  const record = await readIdentity(env, registryKey(canonicalId));
  if (!record) {
    throw new RegistryError(404, "IDENTITY_NOT_FOUND", "Identity not found.");
  }

  return jsonResponse(200, { success: true, data: toPublicIdentityCard(record) });
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_JSON_BYTES) {
    throw new RegistryError(400, "PAYLOAD_TOO_LARGE", "JSON payload is too large.");
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new RegistryError(400, "INVALID_CONTENT_TYPE", "Expected application/json.");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) {
    throw new RegistryError(400, "PAYLOAD_TOO_LARGE", "JSON payload is too large.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new RegistryError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function validateRegistration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid("Request body must be a JSON object.");
  }

  if (input.version !== 1) {
    return invalid("version must be 1.");
  }

  if (!isValidId(input.id)) {
    return invalid("id must match teti_ followed by exactly 9 ASCII lowercase letters or numbers.");
  }

  if (!isValidAddress(input.address)) {
    return invalid("address must use a 9-character ASCII lowercase mail.seep.im local part.");
  }

  if (!addressMatchesId(input.address, input.id)) {
    return invalid("address local part must match the 9-character Teti public ID code.");
  }

  if (input.displayName !== undefined && !isValidDisplayName(input.displayName)) {
    return invalid("displayName must contain 1 to 10 Unicode characters.");
  }

  if (!isValidPublicKey(input.publicKey)) {
    return invalid("publicKey must be a defined non-empty string.");
  }

  if (!isValidPublicProfile(input.publicProfile)) {
    return invalid("publicProfile must be a small public JSON object.");
  }

  for (const fieldName of Object.keys(input)) {
    if (PRIVATE_FIELD_NAMES.has(fieldName)) {
      return invalid(`${fieldName} must not be sent to the discovery registry.`);
    }
  }

  return { valid: true };
}

function validateHeartbeat(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid("Request body must be a JSON object.");
  }

  if (!isValidId(input.id)) {
    return invalid("id must match teti_ followed by exactly 9 ASCII lowercase letters or numbers.");
  }

  if (input.publicProfile !== undefined && !isValidPublicProfile(input.publicProfile)) {
    return invalid("publicProfile must be a small public JSON object.");
  }

  for (const fieldName of Object.keys(input)) {
    if (PRIVATE_FIELD_NAMES.has(fieldName)) {
      return invalid(`${fieldName} must not be sent to the discovery registry.`);
    }
  }

  return { valid: true };
}

function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function isValidAddress(address) {
  if (typeof address !== "string" || address.length > 254) {
    return false;
  }

  const [localPart, domain] = address.split("@");
  return (
    domain === CHATMAIL_DOMAIN &&
    typeof localPart === "string" &&
    CHATMAIL_LOCAL_PART_PATTERN.test(localPart)
  );
}

function addressMatchesId(address, id) {
  const [localPart] = address.split("@");
  return id === `teti_${localPart}`;
}

function isValidPublicKey(publicKey) {
  return (
    typeof publicKey === "string" &&
    publicKey.trim().length > 0 &&
    new TextEncoder().encode(publicKey).length <= MAX_PUBLIC_KEY_BYTES &&
    publicKey !== "undefined"
  );
}

function isValidDisplayName(displayName) {
  return normalizeDisplayName(displayName) !== undefined;
}

function normalizeDisplayName(displayName) {
  if (typeof displayName !== "string") {
    return undefined;
  }

  const normalized = displayName.trim();
  const characters = Array.from(normalized);
  if (characters.length === 0 || characters.length > MAX_DISPLAY_NAME_CHARACTERS) {
    return undefined;
  }

  return normalized;
}

function isValidPublicProfile(publicProfile) {
  if (!publicProfile || typeof publicProfile !== "object" || Array.isArray(publicProfile)) {
    return false;
  }

  if (JSON.stringify(publicProfile).length > MAX_PUBLIC_PROFILE_BYTES) {
    return false;
  }

  return !containsPrivateField(publicProfile);
}

function sanitizePublicProfile(publicProfile) {
  const profile = {};

  if (typeof publicProfile.platform === "string") {
    profile.platform = publicProfile.platform.slice(0, 64);
  }

  if (Array.isArray(publicProfile.category)) {
    profile.category = publicProfile.category.filter(isSmallString).slice(0, 10);
  }

  if (Array.isArray(publicProfile.aiEnvironment)) {
    profile.aiEnvironment = publicProfile.aiEnvironment.filter(isSmallString).slice(0, 10);
  }

  if (publicProfile.device && typeof publicProfile.device === "object" && !Array.isArray(publicProfile.device)) {
    const device = sanitizeDevice(publicProfile.device);
    if (device) {
      profile.device = device;
    }
  }

  if (publicProfile.location && typeof publicProfile.location === "object" && !Array.isArray(publicProfile.location)) {
    const location = sanitizeLocation(publicProfile.location);
    if (location) {
      profile.location = location;
    }
  }

  if (typeof publicProfile.lastSeen === "string") {
    profile.lastSeen = publicProfile.lastSeen.slice(0, 64);
  }

  return profile;
}

function sanitizeDevice(device) {
  const sanitized = {};

  if (device.os && typeof device.os === "object" && !Array.isArray(device.os)) {
    const os = {};
    if (typeof device.os.name === "string") {
      os.name = device.os.name.slice(0, 64);
    }
    if (typeof device.os.version === "string") {
      os.version = device.os.version.slice(0, 64);
    }
    if (Object.keys(os).length > 0) {
      sanitized.os = os;
    }
  }

  if (device.hardware && typeof device.hardware === "object" && !Array.isArray(device.hardware)) {
    const hardware = {};
    if (typeof device.hardware.vendor === "string") {
      hardware.vendor = device.hardware.vendor.slice(0, 64);
    }
    if (typeof device.hardware.model === "string") {
      hardware.model = device.hardware.model.slice(0, 64);
    }
    if (typeof device.hardware.architecture === "string") {
      hardware.architecture = device.hardware.architecture.slice(0, 64);
    }
    if (Object.keys(hardware).length > 0) {
      sanitized.hardware = hardware;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizeLocation(location) {
  const sanitized = {};

  if (typeof location.country === "string") {
    sanitized.country = location.country.slice(0, 64);
  }

  if (typeof location.city === "string") {
    sanitized.city = location.city.slice(0, 64);
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function containsPrivateField(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(containsPrivateField);
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    return PRIVATE_FIELD_NAMES.has(key) || containsPrivateField(nestedValue);
  });
}

function isSmallString(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 64;
}

function toPublicIdentityCard(record) {
  const card = {
    version: 1,
    id: record.id,
    address: record.address,
    publicKey: record.publicKey,
    publicProfile: sanitizePublicProfile(record.publicProfile || {}),
    lastSeen: record.lastSeen || record.publicProfile?.lastSeen || record.updatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };

  const displayName = normalizeDisplayName(record.displayName);
  if (displayName) {
    card.displayName = displayName;
  }

  return card;
}

async function readIdentity(env, key) {
  const raw = await env.TETI.get(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function registryKey(id) {
  return `teti:${id.toLowerCase()}`;
}

function normalizePathname(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function assertRegistry(env) {
  if (!env || !env.TETI) {
    throw new RegistryError(500, "KV_BINDING_MISSING", "TETI KV binding is missing.");
  }
}

function invalid(message) {
  return { valid: false, message };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders({ "content-type": "application/json; charset=utf-8" })
  });
}

function errorResponse(status, error, message) {
  return jsonResponse(status, { success: false, error, message });
}

function emptyResponse(status) {
  return new Response(null, {
    status,
    headers: responseHeaders()
  });
}

function responseHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    ...extra
  };
}

class RegistryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
