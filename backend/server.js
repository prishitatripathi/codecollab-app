/**
 * backend/server.js
 * Real-time collaborative backend:
 * - Socket.IO for real-time edits, files, users, chat
 * - Redis (Cloud or Local) for shared file storage
 * - /run endpoint to compile/run code (java, python, js, c, cpp, html)
 * - /ai-suggest endpoint (disabled for now)
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const Redis = require("ioredis");

const PORT = process.env.PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// Redis client (supports both local & Redis Cloud)
let redis;
try {
  redis = new Redis(REDIS_URL, {
    tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });
  console.log(`✅ Connected to Redis at ${REDIS_URL}`);
} catch (err) {
  console.error("❌ Failed to connect to Redis:", err);
  process.exit(1);
}

// Express + Socket setup
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Temp directory for code execution
const BASE_TEMP = path.join(process.cwd(), "temp");
if (!fs.existsSync(BASE_TEMP)) fs.mkdirSync(BASE_TEMP, { recursive: true });

function sessionKey(sessionId) { return `session:${sessionId}`; }
function filesKey(sessionId) { return `${sessionKey(sessionId)}:files`; }
function usersKey(sessionId) { return `${sessionKey(sessionId)}:users`; }
const socketUser = new Map();
const isWindows = process.platform === "win32";

async function writeTempFile(folder, filename, content) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const p = path.join(folder, filename);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function runCommand(command, options = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, shell: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, out: stderr || err.message });
      } else {
        resolve({ ok: true, out: stdout });
      }
    });
  });
}

// ===== SOCKET.IO =====
io.on("connection", (socket) => {
  socket.on("join", async ({ sessionId = "default", userName = "Anonymous" }) => {
    socket.join(sessionId);
    socketUser.set(socket.id, { sessionId, userName });
    await redis.sadd(usersKey(sessionId), userName);
    const files = await redis.hgetall(filesKey(sessionId));
    socket.emit("session:init", { files, users: await redis.smembers(usersKey(sessionId)) });
    socket.to(sessionId).emit("user:join", { userName });
  });

  socket.on("file:update", async ({ sessionId = "default", filename, content }) => {
    if (!filename) return;
    await redis.hset(filesKey(sessionId), filename, content);
    socket.to(sessionId).emit("file:updated", { filename, content });
  });

  socket.on("file:create", async ({ sessionId = "default", filename, content = "" }) => {
    if (!filename) return;
    await redis.hset(filesKey(sessionId), filename, content);
    io.in(sessionId).emit("file:created", { filename, content });
  });

  socket.on("file:delete", async ({ sessionId = "default", filename }) => {
    if (!filename) return;
    await redis.hdel(filesKey(sessionId), filename);
    io.in(sessionId).emit("file:deleted", { filename });
  });

  socket.on("chat:message", ({ sessionId = "default", userName, text }) => {
    io.in(sessionId).emit("chat:message", { userName, text, time: Date.now() });
  });

  socket.on("disconnect", async () => {
    const info = socketUser.get(socket.id);
    if (info) {
      const { sessionId, userName } = info;
      await redis.srem(usersKey(sessionId), userName);
      socket.to(sessionId).emit("user:left", { userName });
      socketUser.delete(socket.id);
    }
  });
});

// ===== RUN ENDPOINT =====
app.post("/run", async (req, res) => {
  const { sessionId = "default", language, filename, code } = req.body;
  if (!language || !code) return res.status(400).json({ error: "language & code required" });

  const sessionTemp = path.join(BASE_TEMP, sessionId);
  if (!fs.existsSync(sessionTemp)) fs.mkdirSync(sessionTemp, { recursive: true });

  try {
    if (language === "python") {
      const filePath = await writeTempFile(sessionTemp, filename || "main.py", code);
      return res.json(await runCommand(`python "${filePath}"`, { cwd: sessionTemp }, 15000));
    }
    if (language === "javascript" || language === "node") {
      const filePath = await writeTempFile(sessionTemp, filename || "main.js", code);
      return res.json(await runCommand(`node "${filePath}"`, { cwd: sessionTemp }, 15000));
    }
    if (language === "java") {
      const match = code.match(/public\s+class\s+([A-Za-z_]\w*)/);
      const className = match ? match[1] : (filename ? path.basename(filename, ".java") : "Main");
      const javaFileName = `${className}.java`;
      const filePath = await writeTempFile(sessionTemp, javaFileName, code);
      const javac = process.env.JAVA_HOME ? `"${path.join(process.env.JAVA_HOME, "bin", isWindows ? "javac.exe" : "javac")}"` : "javac";
      const javaCmd = process.env.JAVA_HOME ? `"${path.join(process.env.JAVA_HOME, "bin", isWindows ? "java.exe" : "java")}"` : "java";
      const compileResult = await runCommand(`${javac} "${filePath}"`, { cwd: sessionTemp }, 10000);
      if (!compileResult.ok) return res.json(compileResult);
      return res.json(await runCommand(`${javaCmd} -cp "${sessionTemp}" ${className}`, { cwd: sessionTemp }, 10000));
    }
    if (language === "c" || language === "cpp") {
      const ext = language === "c" ? "c" : "cpp";
      const filePath = await writeTempFile(sessionTemp, filename || `main.${ext}`, code);
      const outExe = isWindows ? `${sessionTemp}\\main.exe` : `${sessionTemp}/a.out`;
      const compiler = language === "c" ? "gcc" : "g++";
      const compileResult = await runCommand(`${compiler} "${filePath}" -o "${outExe}"`, { cwd: sessionTemp }, 15000);
      if (!compileResult.ok) return res.json(compileResult);
      return res.json(await runCommand(`"${outExe}"`, { cwd: sessionTemp }, 10000));
    }
    if (language === "html") {
      return res.json({ ok: true, output: code });
    }
    return res.json({ ok: false, output: "Language not supported" });
  } catch (err) {
    console.error("Run error:", err);
    return res.status(500).json({ ok: false, output: `Server error: ${err.message}` });
  }
});

// ===== AI SUGGEST (disabled) =====
app.post("/ai-suggest", async (req, res) => {
  res.json({ suggestion: "AI suggestions are temporarily disabled." });
});

// ===== FILES API =====
app.get("/files/:sessionId", async (req, res) => {
  const files = await redis.hgetall(filesKey(req.params.sessionId || "default"));
  res.json({ files });
});
app.post("/files/:sessionId/save", async (req, res) => {
  const { filename, content } = req.body;
  if (!filename || content == null) return res.status(400).json({ error: "filename & content required" });
  await redis.hset(filesKey(req.params.sessionId || "default"), filename, content);
  io.in(req.params.sessionId || "default").emit("file:updated", { filename, content });
  res.json({ ok: true });
});

// ===== START SERVER =====
server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
