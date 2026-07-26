const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { loadEnv } = require("./env");

loadEnv();

const {
  addChannel,
  addUser,
  countUsers,
  ensureUserIndexes,
  findChannelById,
  findUserByEmail,
  readChannels,
  readUsers
} = require("./database");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const TICKET_TTL_MS = 10 * 60 * 1000;
const APP_VERSION = "2026-07-26-stream-headers";
const PLAYBACK_MODE = process.env.PLAYBACK_MODE || "proxy";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ticketSecret = crypto.randomBytes(32).toString("hex");
const tickets = new Map();
const sessions = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sanitizeChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    category: channel.category,
    mode: channel.mode || "hls"
  };
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const passwordHash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return { salt, passwordHash };
}

function verifyPassword(password, user) {
  const result = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(result.passwordHash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function createSession(user) {
  const sessionId = crypto.randomBytes(32).toString("base64url");
  sessions.set(sessionId, {
    user: sanitizeUser(user),
    createdAt: Date.now()
  });
  return sessionId;
}

function getSession(req) {
  const sessionId = parseCookies(req).jv_session;
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

function setSessionCookie(res, sessionId) {
  const secure = process.env.RENDER ? "; Secure" : "";
  res.setHeader("Set-Cookie", `jv_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.RENDER ? "; Secure" : "";
  res.setHeader("Set-Cookie", `jv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Login necessario." });
    return null;
  }
  return session.user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "Acesso negado." });
    return null;
  }
  return user;
}

async function ensureInitialAdmin() {
  await ensureUserIndexes();
  const total = await countUsers();
  if (total > 0) return;

  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!email || !password) {
    console.warn("Nenhum usuario admin criado. Configure ADMIN_EMAIL e ADMIN_PASSWORD.");
    return;
  }

  const passwordData = hashPassword(password);
  await addUser({
    id: crypto.randomUUID(),
    name: process.env.ADMIN_NAME || "Administrador",
    email,
    role: "admin",
    ...passwordData,
    createdAt: new Date().toISOString()
  });
  console.log(`Admin inicial criado: ${email}`);
}

function signUrl(ticket, upstreamUrl) {
  return crypto.createHmac("sha256", ticketSecret).update(`${ticket}|${upstreamUrl}`).digest("base64url");
}

function createTicket(channel) {
  const ticket = crypto.randomBytes(24).toString("base64url");
  tickets.set(ticket, {
    channelId: channel.id,
    upstreamUrl: channel.url,
    createdAt: Date.now(),
    resources: new Map()
  });
  return ticket;
}

function getTicket(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TICKET_TTL_MS) {
    tickets.delete(ticket);
    return null;
  }
  return entry;
}

function proxiedUrl(ticket, upstreamUrl) {
  const entry = getTicket(ticket);
  if (!entry) return "";

  const resourceId = signUrl(ticket, upstreamUrl);
  entry.resources.set(resourceId, upstreamUrl);
  return `/stream/${ticket}/proxy/${resourceId}`;
}

function rewriteManifest(text, baseUrl, ticket) {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const upstreamUrl = new URL(trimmed, baseUrl).toString();
    return proxiedUrl(ticket, upstreamUrl);
  }).join("\n");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};

  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }

  return JSON.parse(text);
}

function normalizeChannel(input) {
  const name = String(input.name || "").trim();
  const url = String(input.url || "").trim();
  const category = String(input.category || "Variedades").trim();
  const mode = String(input.mode || "hls").trim();

  if (!name) return { error: "Informe o nome do canal." };
  if (!/^https?:\/\//i.test(url)) return { error: "Informe uma URL http ou https." };

  return {
    channel: {
      id: input.id || crypto.randomUUID(),
      name,
      category,
      url,
      mode
    }
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, name: "JV TV", version: APP_VERSION, playbackMode: PLAYBACK_MODE });
    return;
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    const session = getSession(req);
    sendJson(res, 200, { user: session ? session.user : null });
    return;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const user = await findUserByEmail(body.email);

    if (!user || !verifyPassword(body.password || "", user)) {
      sendJson(res, 401, { error: "Email ou senha invalidos." });
      return;
    }

    const sessionId = createSession(user);
    setSessionCookie(res, sessionId);
    sendJson(res, 200, { user: sanitizeUser(user) });
    return;
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const sessionId = parseCookies(req).jv_session;
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/users" && req.method === "GET") {
    requireAdmin(req, res);
    if (res.writableEnded) return;
    const users = await readUsers();
    sendJson(res, 200, users);
    return;
  }

  if (url.pathname === "/api/users" && req.method === "POST") {
    requireAdmin(req, res);
    if (res.writableEnded) return;

    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const role = body.role === "admin" ? "admin" : "user";

    if (!name || !email || password.length < 6) {
      sendJson(res, 400, { error: "Informe nome, email e senha com no minimo 6 caracteres." });
      return;
    }

    const passwordData = hashPassword(password);
    try {
      const user = await addUser({
        id: crypto.randomUUID(),
        name,
        email,
        role,
        ...passwordData,
        createdAt: new Date().toISOString()
      });
      sendJson(res, 201, sanitizeUser(user));
    } catch (error) {
      sendJson(res, error.code === "DUPLICATE_USER" ? 409 : 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/channels" && req.method === "GET") {
    requireAuth(req, res);
    if (res.writableEnded) return;
    const channels = await readChannels();
    sendJson(res, 200, channels.map(sanitizeChannel));
    return;
  }

  const playMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/play$/);
  if (playMatch && req.method === "POST") {
    requireAuth(req, res);
    if (res.writableEnded) return;
    const id = decodeURIComponent(playMatch[1]);
    const channel = await findChannelById(id);

    if (!channel) {
      sendJson(res, 404, { error: "Canal nao encontrado." });
      return;
    }

    if (PLAYBACK_MODE === "direct") {
      sendJson(res, 200, {
        streamUrl: channel.url,
        direct: true
      });
      return;
    }

    const ticket = createTicket(channel);
    sendJson(res, 200, {
      streamUrl: `/stream/${ticket}/manifest`,
      direct: false,
      expiresIn: Math.floor(TICKET_TTL_MS / 1000)
    });
    return;
  }

  if (url.pathname === "/api/channels" && req.method === "POST") {
    if (process.env.ADMIN_TOKEN && req.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`) {
      sendJson(res, 401, { error: "Nao autorizado." });
      return;
    }

    const body = await readBody(req);
    const result = normalizeChannel(body);
    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return;
    }

    const channel = await addChannel(result.channel);
    sendJson(res, 201, sanitizeChannel(channel));
    return;
  }

  sendJson(res, 404, { error: "Rota nao encontrada." });
}

async function handleFormRoutes(req, res, url) {
  if (url.pathname === "/login" && req.method === "POST") {
    const body = await readBody(req);
    const user = await findUserByEmail(body.email);

    if (!user || !verifyPassword(body.password || "", user)) {
      redirect(res, "/?login=erro");
      return true;
    }

    const sessionId = createSession(user);
    setSessionCookie(res, sessionId);
    redirect(res, "/");
    return true;
  }

  if (url.pathname === "/logout" && req.method === "POST") {
    const sessionId = parseCookies(req).jv_session;
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(res);
    redirect(res, "/");
    return true;
  }

  return false;
}

async function proxyUpstream(req, res, upstreamUrl, ticket) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://ww4.embedtv.lat/",
    "Origin": "https://ww4.embedtv.lat"
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstreamResponse = await fetch(upstreamUrl, { headers, redirect: "follow" });
  const contentType = upstreamResponse.headers.get("content-type") || "";
  const isManifest = contentType.includes("mpegurl") || /\.m3u8(\?|$)/i.test(upstreamUrl) || /\/file\.txt(\?|$)/i.test(upstreamUrl);

  if (isManifest) {
    const text = await upstreamResponse.text();
    const body = rewriteManifest(text, upstreamUrl, ticket);
    res.writeHead(upstreamResponse.status, {
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
    return;
  }

  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  const responseHeaders = {
    "Content-Type": contentType || "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Length": body.length
  };
  const acceptRanges = upstreamResponse.headers.get("accept-ranges");
  const contentRange = upstreamResponse.headers.get("content-range");
  if (acceptRanges) responseHeaders["Accept-Ranges"] = acceptRanges;
  if (contentRange) responseHeaders["Content-Range"] = contentRange;
  res.writeHead(upstreamResponse.status, responseHeaders);
  res.end(body);
}

async function handleStream(req, res, url) {
  requireAuth(req, res);
  if (res.writableEnded) return;

  const match = url.pathname.match(/^\/stream\/([^/]+)\/(manifest|proxy)(?:\/([^/]+))?$/);
  if (!match) {
    sendText(res, 404, "Stream nao encontrado.");
    return;
  }

  const ticket = match[1];
  const kind = match[2];
  const resourceId = match[3];
  const entry = getTicket(ticket);
  if (!entry) {
    sendText(res, 403, "Ticket expirado.");
    return;
  }

  if (kind === "manifest") {
    await proxyUpstream(req, res, entry.upstreamUrl, ticket);
    return;
  }

  const upstreamUrl = entry.resources.get(resourceId);
  if (!upstreamUrl) {
    sendText(res, 403, "Recurso expirado.");
    return;
  }

  await proxyUpstream(req, res, upstreamUrl, ticket);
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Acesso negado.");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Content-Length": file.length
    });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Arquivo nao encontrado.");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (await handleFormRoutes(req, res, url)) {
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/stream/")) {
      await handleStream(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Erro interno do servidor." });
  }
});

ensureInitialAdmin().then(() => {
  server.listen(PORT, () => {
    console.log(`JV TV rodando em http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
