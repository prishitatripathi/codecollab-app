// src/App.js
import React, { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import io from "socket.io-client";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import "./App.css";

/**
 * Single-file polished frontend for collaborative editor:
 * - Files sidebar (create/open/delete)
 * - Users list
 * - Chat
 * - History
 * - Monaco editor with IntelliSense-like options
 * - Run / Save / AI Suggest buttons
 *
 * Connects to BACKEND (socket + REST):
 * - socket: join, file:update, file:create, file:delete, chat:message
 * - REST: POST /run, POST /files/:sessionId/save, POST /ai-suggest
 */

const BACKEND = process.env.REACT_APP_BACKEND || "http://localhost:4000";
const socket = io(BACKEND, { transports: ["websocket"] });

function usePersisted(name, defaultVal = "") {
  const [v, setV] = useState(() => sessionStorage.getItem(name) || defaultVal);
  useEffect(() => {
    if (!v) {
      const promptVal = prompt(name === "userName" ? "Enter your display name" : "Session ID (room)") || defaultVal;
      sessionStorage.setItem(name, promptVal || defaultVal);
      setV(sessionStorage.getItem(name));
    }
  }, [name, v, defaultVal]);
  return [v, (x) => { sessionStorage.setItem(name, x); setV(x); }];
}

export default function App() {
  const [sessionId, setSessionId] = usePersisted("sessionId", "default");
  const [userName, setUserName] = usePersisted("userName", `User-${Math.floor(Math.random() * 999)}`);
  const [files, setFiles] = useState({}); // filename -> content
  const [currentFile, setCurrentFile] = useState(null);
  const [editorValue, setEditorValue] = useState("// Welcome!");
  const [language, setLanguage] = useState("javascript");
  const [users, setUsers] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [historyItems, setHistoryItems] = useState([]);
  const [output, setOutput] = useState("");
  const [aiSuggestion, setAiSuggestion] = useState("");
  const editorRef = useRef(null);

  // connect + events
  useEffect(() => {
    if (!sessionId || !userName) return;
    socket.emit("join", { sessionId, userName });

    socket.on("session:init", ({ files: initialFiles = {}, users: initialUsers = [] }) => {
      setFiles(initialFiles);
      const first = Object.keys(initialFiles)[0];
      if (first) {
        setCurrentFile(first);
        setEditorValue(initialFiles[first] || "");
        autoSetLangFromFilename(first);
      } else {
        setEditorValue("// Start typing or create a file from the Files pane.");
      }
      setUsers(initialUsers);
    });

    socket.on("file:created", ({ filename, content }) => {
      setFiles((f) => ({ ...f, [filename]: content }));
      pushHistory(`Created ${filename}`);
    });

    socket.on("file:deleted", ({ filename }) => {
      setFiles((f) => {
        const copy = { ...f };
        delete copy[filename];
        return copy;
      });
      pushHistory(`Deleted ${filename}`);
      if (currentFile === filename) {
        setCurrentFile(null);
        setEditorValue("// No file open");
      }
    });

    socket.on("file:updated", ({ filename, content }) => {
      setFiles((f) => ({ ...f, [filename]: content }));
      if (filename === currentFile) {
        setEditorValue(content);
      }
    });

    socket.on("user:join", ({ userName }) => {
      setUsers((u) => Array.from(new Set([...u, userName])));
      pushHistory(`${userName} joined`);
    });

    socket.on("user:left", ({ userName }) => {
      setUsers((u) => u.filter((x) => x !== userName));
      pushHistory(`${userName} left`);
    });

    socket.on("chat:message", (msg) => {
      setChatMessages((c) => [...c, msg].slice(-300));
    });

    return () => {
      socket.off("session:init");
      socket.off("file:created");
      socket.off("file:deleted");
      socket.off("file:updated");
      socket.off("user:join");
      socket.off("user:left");
      socket.off("chat:message");
    };
  }, [sessionId, userName, currentFile]);

  // helpers
  function pushHistory(text) {
    setHistoryItems((h) => [ `${new Date().toLocaleTimeString()} • ${text}`, ...h ].slice(0, 200));
  }
  function autoSetLangFromFilename(fn) {
    if (!fn) return;
    if (fn.endsWith(".py")) setLanguage("python");
    else if (fn.endsWith(".java")) setLanguage("java");
    else if (fn.endsWith(".c")) setLanguage("c");
    else if (fn.endsWith(".cpp") || fn.endsWith(".cc") || fn.endsWith(".cxx")) setLanguage("cpp");
    else if (fn.endsWith(".html")) setLanguage("html");
    else if (fn.endsWith(".js")) setLanguage("javascript");
    else setLanguage("javascript");
  }

  const createFile = () => {
    const filename = prompt("New filename (e.g. Main.java, index.html):", `file_${Date.now()}.js`);
    if (!filename) return;
    socket.emit("file:create", { sessionId, filename, content: `// ${filename}\n` });
  };

  const deleteFile = (fn) => {
    if (!fn) return;
    if (!window.confirm(`Delete file ${fn}?`)) return;
    socket.emit("file:delete", { sessionId, filename: fn });
  };

  const openFile = (fn) => {
    setCurrentFile(fn);
    setEditorValue(files[fn] ?? "");
    autoSetLangFromFilename(fn);
  };

  const onEditorChange = (val) => {
    setEditorValue(val);
    if (currentFile) socket.emit("file:update", { sessionId, filename: currentFile, content: val });
  };

  const saveFile = async () => {
    if (!currentFile) return alert("Open or create a file first.");
    try {
      await axios.post(`${BACKEND}/files/${sessionId}/save`, { filename: currentFile, content: editorValue });
      pushHistory(`Saved ${currentFile}`);
      alert("Saved");
    } catch (e) {
      console.error(e);
      alert("Save failed — check backend");
    }
  };

  const runCode = async () => {
    try {
      setOutput("Running...");
      const res = await axios.post(`${BACKEND}/run`, { sessionId, language: mapLang(language), filename: currentFile, code: editorValue });
      setOutput(res.data.output || JSON.stringify(res.data));
      pushHistory(`Ran ${currentFile || "code"}`);
    } catch (e) {
      console.error(e);
      setOutput("Run failed — check backend");
    }
  };

  const mapLang = (l) => {
    if (l === "javascript") return "javascript";
    if (l === "python") return "python";
    if (l === "java") return "java";
    if (l === "c") return "c";
    if (l === "cpp") return "cpp";
    if (l === "html") return "html";
    return l;
  };

  const sendChat = (text) => {
    if (!text) return;
    const msg = { sessionId, userName, text, id: uuidv4(), time: Date.now() };
    socket.emit("chat:message", msg);
    setChatMessages((c) => [...c, msg]);
  };

  const askAI = async () => {
    try {
      setAiSuggestion("Thinking...");
      const res = await axios.post(`${BACKEND}/ai-suggest`, { code: editorValue });
      setAiSuggestion(res.data.suggestion || JSON.stringify(res.data));
      pushHistory("AI suggestion requested");
    } catch (e) {
      console.error(e);
      setAiSuggestion("AI failed. Check backend key/quotas.");
    }
  };

  return (
    <div className="cc-app">
      <div className="cc-topbar">
        <div className="cc-brand">CodeCollab</div>

        <div className="cc-controls">
          <div className="cc-pill">Session: <b>{sessionId}</b></div>
          <div className="cc-pill">You: <b>{userName}</b></div>

          <select className="cc-select" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="javascript">JavaScript</option>
            <option value="python">Python</option>
            <option value="java">Java</option>
            <option value="cpp">C++</option>
            <option value="c">C</option>
            <option value="html">HTML</option>
          </select>

          <button className="cc-btn" onClick={runCode}>Run ▶</button>
          <button className="cc-btn" onClick={saveFile}>Save 💾</button>
          <button className="cc-btn ghost" onClick={askAI}>AI Suggest 💡</button>
        </div>
      </div>

      <div className="cc-body">
        <aside className="cc-sidebar">
          <div className="cc-pane">
            <div className="cc-pane-title">
              <span>Files</span>
              <button className="cc-small" onClick={createFile}>＋</button>
            </div>
            <div className="cc-files">
              {Object.keys(files).length === 0 && <div className="cc-empty">No files — create one</div>}
              {Object.keys(files).map((fn) => (
                <div key={fn} className={`cc-file ${currentFile === fn ? "active" : ""}`}>
                  <div className="cc-file-name" onClick={() => openFile(fn)}>{fn}</div>
                  <div className="cc-file-actions">
                    <button className="tiny" onClick={() => openFile(fn)}>Open</button>
                    <button className="tiny danger" onClick={() => deleteFile(fn)}>Del</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="cc-pane">
            <div className="cc-pane-title">Users</div>
            <div className="cc-users">
              {users.map((u) => <div className="cc-user" key={u}>{u}</div>)}
            </div>
          </div>

          <div className="cc-pane">
            <div className="cc-pane-title">History</div>
            <div className="cc-history">
              {historyItems.length === 0 && <div className="cc-empty">No recent activity</div>}
              {historyItems.map((h, i) => <div key={i} className="cc-history-item">{h}</div>)}
            </div>
          </div>
        </aside>

        <main className="cc-main">
          <div className="cc-editor-header">
            <div className="cc-openfile">{currentFile || "No file open"}</div>
            <div className="cc-online">{users.length} online</div>
          </div>

          <div className="cc-editor-wrap">
            <Editor
              height="62vh"
              theme="vs-dark"
              language={language}
              value={editorValue}
              onChange={onEditorChange}
              options={{
                minimap: { enabled: false },
                automaticLayout: true,
                fontSize: 14,
                formatOnType: true,
                tabSize: 2,
                wordWrap: "off",
                suggestOnTriggerCharacters: true,
                quickSuggestions: { other: true, comments: false, strings: true },
                autoClosingBrackets: "always",
                autoIndent: "full",
              }}
              onMount={(editor) => { editorRef.current = editor; }}
            />
          </div>

          <div className="cc-lower">
            <div className="cc-panel">
              <div className="cc-panel-title">Output</div>
              <pre className="cc-panel-body">{output}</pre>
            </div>

            <div className="cc-panel">
              <div className="cc-panel-title">AI Suggestion</div>
              <pre className="cc-panel-body">{aiSuggestion}</pre>
            </div>
          </div>
        </main>

        <aside className="cc-rightbar">
          <div className="cc-pane">
            <div className="cc-pane-title">Chat</div>
            <div className="cc-chat-window">
              {chatMessages.map((m) => (
                <div key={m.id || m.time} className="cc-chat-message">
                  <b>{m.userName}:</b> {m.text}
                </div>
              ))}
            </div>
            <ChatInput onSend={sendChat} />
          </div>

          <div className="cc-pane">
            <div className="cc-pane-title">Quick files</div>
            <div className="cc-quick-files">
              {Object.keys(files).map((f) => (
                <div key={f} className="cc-quick-file" onClick={() => openFile(f)}>{f}</div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ChatInput({ onSend }) {
  const [text, setText] = useState("");
  const onEnter = (e) => {
    if (e.key === "Enter") {
      handle();
      e.preventDefault();
    }
  };
  const handle = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <div className="cc-chat-input">
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onEnter} placeholder="Say something..." />
      <button onClick={handle}>Send</button>
    </div>
  );
}
