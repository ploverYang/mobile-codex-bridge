import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const SESSION_COOKIE = "mobile_codex_session";

function constantTimeHexEqual(left, right) {
  const a = Buffer.from(String(left), "hex");
  const b = Buffer.from(String(right), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class SecurityStore {
  constructor(dataDir, options, now = () => Date.now()) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, "state.json");
    this.options = options;
    this.now = now;
    this.state = null;
    this.pairing = null;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    const loaded = await readFile(this.statePath, "utf8").then(JSON.parse).catch(() => null);
    this.state = loaded && typeof loaded === "object" ? loaded : {};
    this.state.adminToken ||= randomBytes(32).toString("base64url");
    this.state.sessions = Array.isArray(this.state.sessions) ? this.state.sessions : [];
    this.pruneSessions();
    await this.save();
    return this;
  }

  pruneSessions() {
    const now = this.now();
    this.state.sessions = this.state.sessions.filter((session) => Number(session.expiresAt) > now);
  }

  async save() {
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  createPairing() {
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const expiresAt = this.now() + this.options.pairingTtlMinutes * 60_000;
    this.pairing = { codeHash: sha256(code), expiresAt };
    return { code, expiresAt };
  }

  async pair(code, deviceName = "手机") {
    if (!this.pairing || this.pairing.expiresAt <= this.now()) {
      this.pairing = null;
      throw new Error("配对码已过期，请在电脑上重新生成");
    }
    if (!constantTimeHexEqual(this.pairing.codeHash, sha256(code))) {
      throw new Error("配对码不正确");
    }

    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + this.options.sessionTtlDays * 86_400_000;
    this.state.sessions.push({
      tokenHash: sha256(token),
      deviceName: String(deviceName || "手机").slice(0, 80),
      createdAt,
      expiresAt,
    });
    this.pairing = null;
    this.pruneSessions();
    await this.save();
    return { token, expiresAt };
  }

  authorize(token) {
    return Boolean(this.session(token));
  }

  session(token) {
    if (!token || !this.state) return null;
    this.pruneSessions();
    const tokenHash = sha256(token);
    const session = this.state.sessions.find((item) => constantTimeHexEqual(item.tokenHash, tokenHash));
    return session ? { createdAt: session.createdAt, expiresAt: session.expiresAt } : null;
  }

  async revoke(token) {
    if (!token || !this.state) return false;
    const tokenHash = sha256(token);
    const previousLength = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((session) => !constantTimeHexEqual(session.tokenHash, tokenHash));
    if (this.state.sessions.length === previousLength) return false;
    await this.save();
    return true;
  }

  authorizeAdmin(token) {
    if (!token || !this.state?.adminToken) return false;
    const supplied = Buffer.from(String(token));
    const expected = Buffer.from(this.state.adminToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  get adminToken() {
    return this.state?.adminToken || null;
  }
}

export function bearerToken(request) {
  const header = String(request.headers.authorization || "");
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1 || cookie.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function secureRequest(request) {
  if (request.socket?.encrypted) return true;
  return String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";
}

export function sessionCookie(token, expiresAt, request) {
  const maxAge = Math.max(0, Math.ceil((Number(expiresAt) - Date.now()) / 1000));
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secureRequest(request)) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(request) {
  const attributes = [`${SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Strict"];
  if (secureRequest(request)) attributes.push("Secure");
  return attributes.join("; ");
}
