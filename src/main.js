import { createClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabase-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const lobby = document.querySelector("#lobby");
const game = document.querySelector("#game");
const nameInput = document.querySelector("#player-name");
const roomInput = document.querySelector("#room-code");
const lobbyNotice = document.querySelector("#lobby-notice");
const gameNotice = document.querySelector("#game-notice");
const connectionLabel = document.querySelector("#connection");
const boardEl = document.querySelector("#board");
const winLines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const sessionKey = "xo-arena-session-v2";
const roomKey = code => `xo-arena-room-v2-${code}`;
let session = readSession();
let room = null;
let channel = null;
let gameState = null;
let joinRetry = null;
let hostId = null;
let hostName = null;
let hostJoinStarted = 0;

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(sessionKey) || "null"); }
  catch { return null; }
}
function saveSession() {
  if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
  else sessionStorage.removeItem(sessionKey);
}
function readRoom(code) {
  try { return JSON.parse(localStorage.getItem(roomKey(code)) || "null"); }
  catch { return null; }
}
function saveRoom() {
  if (room) localStorage.setItem(roomKey(room.code), JSON.stringify(room));
}
function setNotice(element, message) { element.textContent = message || ""; }
function cleanName() { return nameInput.value.trim().replace(/[<>]/g, "").slice(0, 18) || "Player"; }
function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, byte => chars[byte % chars.length]).join("");
}
function enterGame() {
  lobby.classList.add("hidden");
  game.classList.remove("hidden");
  document.querySelector("#room-label").textContent = session.code;
  document.querySelector("#invite-link").value = `${location.origin}${location.pathname}?room=${encodeURIComponent(session.code)}`;
  history.replaceState(null, "", `?room=${encodeURIComponent(session.code)}`);
}
function currentPresenceIds() {
  if (!channel) return new Set();
  return new Set(Object.values(channel.presenceState()).flatMap(entries => entries.map(entry => entry.playerId)));
}
function makeSnapshot() {
  const present = currentPresenceIds();
  const connectedX = present.has(room.players.X.id);
  const connectedO = Boolean(room.players.O && present.has(room.players.O.id));
  const phase = !connectedX || !connectedO ? "waiting" : room.winner ? "finished" : "playing";
  return {
    code: room.code,
    board: [...room.board],
    turn: room.turn,
    phase,
    winner: room.winner,
    winningLine: room.winningLine,
    scores: { ...room.scores },
    players: {
      X: { name: room.players.X.name, connected: connectedX },
      O: room.players.O ? { name: room.players.O.name, connected: connectedO } : null
    }
  };
}
function showState(state) {
  gameState = state;
  render();
}
async function broadcast(type, payload = {}) {
  if (!channel) return;
  await channel.send({ type: "broadcast", event: "game", payload: { type, from: session.id, ...payload } });
}
async function publishState() {
  if (!room || session?.mark !== "X") return;
  saveRoom();
  const state = makeSnapshot();
  showState(state);
  await broadcast("state", { state });
}
function updatePresence() {
  if (!room || session?.mark !== "X") return;
  void publishState();
}
function applyMove(mark, index) {
  if (!room || !room.players.O || room.winner || room.turn !== mark) return;
  if (!Number.isInteger(index) || index < 0 || index > 8 || room.board[index]) return;
  room.board[index] = mark;
  const line = winLines.find(candidate => candidate.every(cell => room.board[cell] === mark));
  if (line) {
    room.winner = mark;
    room.winningLine = line;
    room.scores[mark] += 1;
  } else if (room.board.every(Boolean)) {
    room.winner = "draw";
    room.scores.draws += 1;
  } else {
    room.turn = mark === "X" ? "O" : "X";
  }
  void publishState();
}
function handleHostMessage(message) {
  if (message.type === "join-request") {
    if (!message.from || message.from === session.id) return;
    const existing = room.players.O;
    const connectedIds = currentPresenceIds();
    const canClaim = !existing || existing.id === message.from || !connectedIds.has(existing.id);
    if (!canClaim) {
      void broadcast("room-full", { to: message.from });
      return;
    }
    room.players.O = { id: message.from, name: String(message.name || "Player").replace(/[<>]/g, "").slice(0, 18) || "Player" };
    saveRoom();
    void broadcast("welcome", { to: message.from, mark: "O", state: makeSnapshot() });
    void publishState();
    return;
  }
  if (message.type === "move-request" && message.from === room.players.O?.id) {
    applyMove("O", Number(message.index));
  } else if (message.type === "restart-request" && message.from === room.players.O?.id && room.winner) {
    restartRound();
  }
}
function handleGuestMessage(message) {
  if (message.to && message.to !== session.id) return;
  if (message.type === "welcome") {
    clearTimeout(hostJoinStarted);
    session.mark = message.mark;
    session.name = cleanName();
    saveSession();
    setNotice(gameNotice, "");
    showState(message.state);
  } else if (message.type === "state" && session.mark === "O") {
    showState(message.state);
  } else if (message.type === "room-full") {
    clearInterval(joinRetry);
    setNotice(gameNotice, "This room already has two players.");
  } else if (message.type === "host-ready" && session.mark === "O") {
    requestSeat();
  }
}
function requestSeat() {
  if (!channel || session.mark === "X" || session.mark === "O") return;
  void broadcast("join-request", { name: session.name });
}
function restartRound() {
  if (!room || !room.winner) return;
  room.board = Array(9).fill("");
  room.turn = "X";
  room.winner = null;
  room.winningLine = null;
  void publishState();
}
function openRoom(code, role) {
  if (channel) void channel.unsubscribe();
  room = role === "host" ? readRoom(code) : null;
  hostId = role === "host" ? session.id : null;
  hostName = role === "host" ? session.name : null;
  hostJoinStarted = 0;
  session.code = code;
  enterGame();
  connectionLabel.textContent = "Connecting…";
  setNotice(gameNotice, role === "guest" ? "Looking for the room host…" : "Room ready. Share the invite link.");

  channel = supabase.channel(`xo-room-${code}`, {
    config: { private: false, presence: { key: session.id }, broadcast: { self: false } }
  });
  channel
    .on("broadcast", { event: "game" }, ({ payload }) => {
      if (!payload || payload.from === session.id) return;
      if (role === "host") handleHostMessage(payload);
      else handleGuestMessage(payload);
    })
    .on("presence", { event: "sync" }, updatePresence)
    .subscribe(async status => {
      if (status === "SUBSCRIBED") {
        connectionLabel.textContent = "Connected";
        await channel.track({ playerId: session.id, name: session.name, mark: session.mark || "?" });
        if (role === "host") {
          if (!room) room = { code, board: Array(9).fill(""), turn: "X", winner: null, winningLine: null, scores: { X: 0, O: 0, draws: 0 }, players: { X: { id: hostId, name: hostName }, O: null } };
          room.players.X = { id: hostId, name: hostName };
          void publishState();
          void broadcast("host-ready");
        } else {
          if (!session.mark) setNotice(gameNotice, "Looking for the room host…");
          requestSeat();
          clearInterval(joinRetry);
          joinRetry = setInterval(requestSeat, 2500);
          clearTimeout(hostJoinStarted);
          hostJoinStarted = setTimeout(() => {
            if (!session.mark) setNotice(gameNotice, "Room not found or host is offline. Ask the host to reopen the invite.");
          }, 7000);
        }
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        connectionLabel.textContent = "Connection issue";
        setNotice(gameNotice, "Could not connect to the shared game service. Please refresh and try again.");
      } else if (status === "CLOSED") {
        connectionLabel.textContent = "Disconnected";
      }
    });
}
function startRoom() {
  setNotice(lobbyNotice, "");
  const code = randomCode();
  session = { id: crypto.randomUUID(), code, mark: "X", name: cleanName() };
  saveSession();
  room = null;
  openRoom(code, "host");
}
function joinRoom() {
  const code = roomInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) { setNotice(lobbyNotice, "Enter the 6-character room code."); return; }
  setNotice(lobbyNotice, "");
  if (!session || session.code !== code) session = { id: crypto.randomUUID(), code, mark: null, name: cleanName() };
  else session.name = cleanName();
  saveSession();
  openRoom(code, session.mark === "X" ? "host" : "guest");
}
function render() {
  if (!gameState || !session) return;
  const players = gameState.players;
  document.querySelector("#name-x").textContent = (players.X?.name || "Waiting for X") + (players.X?.connected ? "" : " · offline");
  document.querySelector("#name-o").textContent = (players.O?.name || "Waiting for O") + (players.O?.connected ? "" : " · offline");
  document.querySelector("#player-x").classList.toggle("active", gameState.phase === "playing" && gameState.turn === "X");
  document.querySelector("#player-o").classList.toggle("active", gameState.phase === "playing" && gameState.turn === "O");
  document.querySelector("#scores").textContent = `X ${gameState.scores.X} · Draws ${gameState.scores.draws} · O ${gameState.scores.O}`;
  const turn = document.querySelector("#turn");
  if (gameState.phase === "waiting") turn.textContent = players.X?.connected && players.O?.connected ? "Reconnecting to the game…" : "Waiting for both players to be connected. Share the invite link.";
  else if (gameState.winner === "draw") turn.textContent = "It's a draw!";
  else if (gameState.winner) turn.textContent = gameState.winner === session.mark ? "You win!" : "The other player wins.";
  else turn.textContent = gameState.turn === session.mark ? "Your turn" : "Their turn";
  document.querySelector("#new-round").classList.toggle("hidden", gameState.phase !== "finished");
  boardEl.innerHTML = "";
  gameState.board.forEach((value, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cell" + (value ? ` ${value.toLowerCase()}` : "") + (gameState.winningLine?.includes(index) ? " win" : "");
    button.textContent = value || "";
    button.setAttribute("role", "gridcell");
    button.setAttribute("aria-label", `Square ${index + 1}${value ? `, ${value}` : ""}`);
    button.disabled = gameState.phase !== "playing" || gameState.turn !== session.mark || Boolean(value);
    button.addEventListener("click", () => {
      if (session.mark === "X") applyMove("X", index);
      else if (session.mark === "O") void broadcast("move-request", { index });
    });
    boardEl.append(button);
  });
}

document.querySelector("#create").addEventListener("click", startRoom);
document.querySelector("#join").addEventListener("click", joinRoom);
roomInput.addEventListener("input", () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); });
document.querySelector("#copy").addEventListener("click", async () => {
  const input = document.querySelector("#invite-link");
  try { await navigator.clipboard.writeText(input.value); setNotice(gameNotice, "Invite link copied."); }
  catch { input.select(); document.execCommand("copy"); setNotice(gameNotice, "Invite link copied."); }
});
document.querySelector("#new-round").addEventListener("click", () => {
  if (session.mark === "X") restartRound();
  else void broadcast("restart-request");
});
document.querySelector("#leave").addEventListener("click", async () => {
  clearInterval(joinRetry);
  clearTimeout(hostJoinStarted);
  if (channel) await channel.unsubscribe();
  channel = null;
  session = null;
  room = null;
  gameState = null;
  saveSession();
  lobby.classList.remove("hidden");
  game.classList.add("hidden");
  history.replaceState(null, "", location.pathname);
  setNotice(lobbyNotice, "You left the room.");
});

const inviteRoom = new URLSearchParams(location.search).get("room")?.toUpperCase().replace(/[^A-Z0-9]/g, "");
if (inviteRoom) {
  roomInput.value = inviteRoom;
  if (inviteRoom.length === 6) joinRoom();
} else if (session?.code && session?.id) {
  nameInput.value = session.name || "";
  openRoom(session.code, session.mark === "X" ? "host" : "guest");
}
