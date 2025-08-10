/**
 * backend/server.js
 * Real-time collaborative backend:
 * - Socket.IO for real-time edits, files, users, chat
 * - Redis for shared file storage
 * - /run endpoint to compile/run code (java, python, js, c, cpp)
 * - /ai-suggest endpoint (OpenAI or Google Gemini depending on env)
 *
 * WARNING: This executes code using child_process.exec. Don't expose publicly.
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
const axios = require("axios");

const PORT = process.env.PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// redis client
const redis = new Redis(REDIS_URL);

// basic app + socket
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());

// temp directory to read/write building files
const BASE_TEMP = path.join(process.cwd(), "temp");
if (!fs.existsSync(BASE_TEMP)) fs.mkdirSync(BASE_TEMP, { recursive: true });

// ---- Helpers ----
function sessionKey(sessionId) {
  return `session:${sessionId}`;
}
function filesKey(sessionId) {
  return `${sessionKey(sessionId)}:files`; // hash: filename -> content
}
function usersKey(sessionId) {
  return `${sessionKey(sessionId)}:users`; // set of user ids or names
}

// Basic in-memory map to track socket->user for quick broadcasting (optional)
const socketUser = new Map();

// choose platform-specific executable names
const isWindows = process.platform === "win32";

/** Write file helper */
async function writeTempFile(folder, filename, content) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const p = path.join(folder, filename);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

/** Run shell command with timeout and return result promise */
function runCommand(command, options = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const proc = exec(command, { timeout: timeoutMs, shell: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        // prefer stderr but fallback to err.message
        resolve({ ok: false, out: stderr || err.message });
      } else {
        resolve({ ok: true, out: stdout });
      }
    });
  });
}

// ==== SOCKET.IO: files, edits, users, chat ====
io.on("connection", (socket) => {
  // client should emit `join` with { sessionId, userName }
  socket.on("join", async ({ sessionId = "default", userName = "Anonymous" }) => {
    socket.join(sessionId);
    socketUser.set(socket.id, { sessionId, userName });

    // add user to redis set
    await redis.sadd(usersKey(sessionId), userName);

    // fetch files for session, send to new client
    const files = await redis.hgetall(filesKey(sessionId));
    socket.emit("session:init", { files, users: await redis.smembers(usersKey(sessionId)) });

    // notify others
    socket.to(sessionId).emit("user:join", { userName });
  });

  // receive edits from client: { sessionId, filename, content }
  socket.on("file:update", async ({ sessionId = "default", filename, content }) => {
    if (!filename) return;
    await redis.hset(filesKey(sessionId), filename, content);
    // broadcast update to other clients in same session
    socket.to(sessionId).emit("file:updated", { filename, content });
  });

  // create/delete files
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

  // chat messages
  socket.on("chat:message", ({ sessionId = "default", userName, text }) => {
    // broadcast
    io.in(sessionId).emit("chat:message", { userName, text, time: Date.now() });
  });

  // disconnect
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

// ==== REST: Run/Compile code endpoint ====
/**
 * POST /run
 * body: { sessionId?, language, filename? (optional), code }
 *
 * Behavior:
 * - For multi-file sessions we will use provided filename or attempt auto-detection for Java
 * - For Java: detect public class name and save as <ClassName>.java
 * - For C/C++: compile to exe on windows or ./a.out on linux/mac
 */
app.post("/run", async (req, res) => {
  const { sessionId = "default", language, filename, code } = req.body;
  if (!language || !code) return res.status(400).json({ error: "language & code required" });

  // choose a temp folder per session
  const sessionTemp = path.join(BASE_TEMP, sessionId);
  if (!fs.existsSync(sessionTemp)) fs.mkdirSync(sessionTemp, { recursive: true });

  try {
    if (language === "python") {
      const filePath = await writeTempFile(sessionTemp, filename || "main.py", code);
      const cmd = `python "${filePath}"`;
      const result = await runCommand(cmd, { cwd: sessionTemp }, 15_000);
      return res.json({ output: result.out, ok: result.ok });
    }

    if (language === "javascript" || language === "node") {
      const filePath = await writeTempFile(sessionTemp, filename || "main.js", code);
      const cmd = `node "${filePath}"`;
      const result = await runCommand(cmd, { cwd: sessionTemp }, 15_000);
      return res.json({ output: result.out, ok: result.ok });
    }

    if (language === "java") {
      // auto-detect public class if present
      const match = code.match(/public\s+class\s+([A-Za-z_]\w*)/);
      const className = match ? match[1] : (filename ? path.basename(filename, ".java") : "Main");
      const javaFileName = `${className}.java`;
      const filePath = await writeTempFile(sessionTemp, javaFileName, code);

      // prefer explicit JAVA_HOME if provided (for Windows) 
      const javaHome = process.env.JAVA_HOME ? process.env.JAVA_HOME : null;
      const javac = javaHome ? `"${path.join(javaHome, "bin", isWindows ? "javac.exe" : "javac")}"` : "javac";
      const javaCmd = javaHome ? `"${path.join(javaHome, "bin", isWindows ? "java.exe" : "java")}"` : "java";

      // compile then run
      const compileCmd = `${javac} "${filePath}"`;
      const compileResult = await runCommand(compileCmd, { cwd: sessionTemp }, 10_000);
      if (!compileResult.ok) return res.json({ output: compileResult.out, ok: false });

      const runCmd = `${javaCmd} -cp "${sessionTemp}" ${className}`;
      const runResult = await runCommand(runCmd, { cwd: sessionTemp }, 10_000);
      return res.json({ output: runResult.out, ok: runResult.ok });
    }

    if (language === "c" || language === "cpp") {
      const ext = language === "c" ? "c" : "cpp";
      const sourceFile = filename || `main.${ext}`;
      const filePath = await writeTempFile(sessionTemp, sourceFile, code);

      // compile options
      if (language === "c") {
        const outExe = isWindows ? `${sessionTemp}\\main.exe` : `${sessionTemp}/a.out`;
        const compileCmd = `gcc "${filePath}" -o "${outExe}"`;
        const compileResult = await runCommand(compileCmd, { cwd: sessionTemp }, 15_000);
        if (!compileResult.ok) return res.json({ output: compileResult.out, ok: false });
        const runCmd = isWindows ? `"${outExe}"` : `"${outExe}"`;
        const runResult = await runCommand(runCmd, { cwd: sessionTemp }, 10_000);
        return res.json({ output: runResult.out, ok: runResult.ok });
      } else {
        // cpp
        const outExe = isWindows ? `${sessionTemp}\\main.exe` : `${sessionTemp}/a.out`;
        const compileCmd = `g++ "${filePath}" -o "${outExe}"`;
        const compileResult = await runCommand(compileCmd, { cwd: sessionTemp }, 15_000);
        if (!compileResult.ok) return res.json({ output: compileResult.out, ok: false });
        const runCmd = isWindows ? `"${outExe}"` : `"${outExe}"`;
        const runResult = await runCommand(runCmd, { cwd: sessionTemp }, 10_000);
        return res.json({ output: runResult.out, ok: runResult.ok });
      }
    }

    if (language === "html") {
      // for HTML we just return the HTML back; or optionally you could launch a local server
      return res.json({ output: code, ok: true });
    }

    return res.json({ output: "Language not supported", ok: false });

  } catch (err) {
    console.error("Run error:", err);
    return res.status(500).json({ output: `Server error: ${err.message}`, ok: false });
  }
});

// ==== AI Suggest endpoint: supports OpenAI (if OPENAI_API_KEY) or Google Gemini (if GOOGLE_API_KEY) ====
app.post("/ai-suggest", async (req, res) => {
  return res.json({ suggestion: "AI suggestions are temporarily disabled." });
});

// ==== Simple files REST (optional for UI) ====
// list files in session
app.get("/files/:sessionId", async (req, res) => {
  const { sessionId = "default" } = req.params;
  const files = await redis.hgetall(filesKey(sessionId));
  return res.json({ files });
});

// save file (saves to redis)
app.post("/files/:sessionId/save", async (req, res) => {
  const { sessionId = "default" } = req.params;
  const { filename, content } = req.body;
  if (!filename || content == null) return res.status(400).json({ error: "filename & content required" });
  await redis.hset(filesKey(sessionId), filename, content);
  io.in(sessionId).emit("file:updated", { filename, content });
  return res.json({ ok: true });
});

// start server
server.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
