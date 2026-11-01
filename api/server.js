import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const rooms = new Map();
const server = http.createServer();
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const winLines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function safeName(value) {
  const name = String(value || "Player").replace(/[<>\\u0000-\\u001f]/g, "").trim().slice(0, 18);
  return name || "Player";
}
function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function snapshot(room, mark) {
  const connectedX = Boolean(room.players.X?.ws && room.players.X.ws.readyState === WebSocket.OPEN);
  const connectedO = Boolean(room.players.O?.ws && room.players.O.ws.readyState === WebSocket.OPEN);
  const phase = !connectedX || !connectedO ? "waiting" : room.winner ? "finished" : "playing";
  return {
    type: "state",
    code: room.code,
    board: room.board,
    turn: room.turn,
    phase,
    winner: room.winner,
    winningLine: room.winningLine,
    scores: room.scores,
    players: {
      X: room.players.X ? { name: room.players.X.name, connected: connectedX } : null,
      O: room.players.O ? { name: room.players.O.name, connected: connectedO } : null
    },
    yourMark: mark
  };
}
function broadcast(room) {
  for (const mark of ["X", "O"]) {
    const player = room.players[mark];
    if (player?.ws) send(player.ws, snapshot(room, mark));
  }
}
function findRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}
function bindPlayer(room, mark, ws, token, name) {
  const player = room.players[mark];
  if (player?.ws && player.ws !== ws && player.ws.readyState === WebSocket.OPEN) {
    player.ws.close(4001, "Reconnected in another tab");
  }
  room.players[mark] = { token, name: safeName(name || player?.name), ws };
  ws.roomCode = room.code;
  ws.mark = mark;
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  return mark;
}
function expireIfEmpty(room) {
  if (room.players.X?.ws || room.players.O?.ws) return;
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (!room.players.X?.ws && !room.players.O?.ws) rooms.delete(room.code);
  }, 10 * 60 * 1000);
  room.cleanupTimer.unref?.();
}
function detach(ws) {
  const room = findRoom(ws.roomCode);
  if (!room || !ws.mark) return;
  const mark = ws.mark;
  const player = room.players[mark];
  if (player?.ws === ws) room.players[mark] = { ...player, ws: null };
  ws.roomCode = null;
  ws.mark = null;
  broadcast(room);
  expireIfEmpty(room);
}
function fail(ws, message) {
  send(ws, { type: "error", message });
}
function processMessage(ws, data) {
  let message;
  try { message = JSON.parse(data.toString()); } catch { fail(ws, "That message could not be read."); return; }
  if (!message || typeof message.type !== "string") return;

  if (message.type === "create") {
    const code = String(message.code || "").toUpperCase();
    const token = String(message.token || "");
    if (!/^[A-Z2-9]{6}$/.test(code) || token.length < 20) { fail(ws, "Couldn't create that room. Try again."); return; }
    let room = findRoom(code);
    if (room && room.players.X?.token === token) {
      const mark = bindPlayer(room, "X", ws, token, message.name || room.players.X.name);
      send(ws, { type: "joined", code, token, mark, name: room.players[mark].name });
      broadcast(room);
      return;
    }
    if (room) { fail(ws, "That room code was already taken. Create a new room."); return; }
    room = {
      code, board: Array(9).fill(""), turn: "X", winner: null, winningLine: null,
      scores: { X: 0, O: 0, draws: 0 }, players: { X: null, O: null }, cleanupTimer: null
    };
    rooms.set(code, room);
    const mark = bindPlayer(room, "X", ws, token, message.name);
    send(ws, { type: "joined", code, token, mark, name: room.players[mark].name });
    broadcast(room);
    return;
  }

  if (message.type === "join") {
    const code = String(message.code || "").toUpperCase();
    const token = String(message.token || "");
    const room = findRoom(code);
    if (!room) { fail(ws, "Room not found. Ask the host for a fresh invite."); return; }
    if (token.length < 20) { fail(ws, "Couldn't join the room. Try again."); return; }
    let mark = null;
    for (const candidate of ["X", "O"]) if (room.players[candidate]?.token === token) mark = candidate;
    if (!mark) mark = room.players.O ? null : "O";
    if (!mark) { fail(ws, "This room already has two players."); return; }
    bindPlayer(room, mark, ws, token, message.name);
    send(ws, { type: "joined", code, token, mark, name: room.players[mark].name });
    broadcast(room);
    return;
  }

  const room = findRoom(ws.roomCode);
  const mark = ws.mark;
  if (!room || !mark || room.players[mark]?.ws !== ws) { fail(ws, "Join a room before playing."); return; }

  if (message.type === "leave") { detach(ws); return; }
  if (message.type === "move") {
    const { X, O } = room.players;
    if (!X?.ws || !O?.ws || room.winner || room.turn !== mark) return;
    const index = Number(message.index);
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
    broadcast(room);
    return;
  }
  if (message.type === "restart") {
    if (!room.players.X?.ws || !room.players.O?.ws || !room.winner) return;
    room.board = Array(9).fill("");
    room.turn = "X";
    room.winner = null;
    room.winningLine = null;
    broadcast(room);
  }
}

wss.on("connection", (ws, request) => {
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) { ws.close(1008, "Origin not allowed"); return; }
    } catch { ws.close(1008, "Invalid origin"); return; }
  }
  ws.on("message", data => processMessage(ws, data));
  ws.on("close", () => detach(ws));
  ws.on("error", () => detach(ws));
});

export default server;
