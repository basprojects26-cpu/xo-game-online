const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'xo-game-online.html')));

const rooms = {};
const onlinePlayers = {}; // playerId -> socketId

function genId() { return Math.random().toString(36).substring(2, 7).toUpperCase(); }

io.on('connection', (socket) => {
    let registeredPlayerId = null;

    socket.on('register_player', (playerId) => {
        registeredPlayerId = playerId;
        onlinePlayers[playerId] = socket.id;
    });

    socket.on('create_room', (data) => {
        const roomId = genId();
        socket.join(roomId);
        const starter = Math.random() < 0.5 ? 'X' : 'O';
        rooms[roomId] = {
            players: [{ id: socket.id, playerId: registeredPlayerId, profile: data.profile, symbol: 'X' }],
            settings: data.settings, scores: { X: 0, O: 0 },
            game_number: 0, last_starter: null, first_starter: starter,
            currentGameScored: false, replay_requests: new Set(), gameActive: false
        };
        socket.emit('room_created', roomId);
    });

    socket.on('join_room', (data) => {
        const room = rooms[data.roomId];
        if (!room) { socket.emit('error_msg', 'Room not found!'); return; }
        if (room.players.length >= 2) { socket.emit('error_msg', 'Room is full!'); return; }
        socket.join(data.roomId);
        room.players.push({ id: socket.id, playerId: registeredPlayerId, profile: data.profile, symbol: 'O' });
        room.game_number = 1; room.last_starter = room.first_starter;
        room.currentGameScored = false; room.gameActive = true;
        const [p1, p2] = room.players;
        io.to(p1.id).emit('game_start_online', { roomId: data.roomId, symbol: 'X', opponent: p2.profile, settings: room.settings, starter: room.first_starter, scores: room.scores, gameNumber: 1 });
        io.to(p2.id).emit('game_start_online', { roomId: data.roomId, symbol: 'O', opponent: p1.profile, settings: room.settings, starter: room.first_starter, scores: room.scores, gameNumber: 1 });
    });

    socket.on('make_move', (d) => socket.to(d.roomId).emit('move_made', d.index));
    socket.on('randomizer_sync', (d) => socket.to(d.roomId).emit('randomizer_event_sync', d.board));

    socket.on('game_ended', (data) => {
        const room = rooms[data.roomId];
        if (!room || room.currentGameScored) return;
        room.currentGameScored = true; room.gameActive = false;
        if (data.winner === 'draw') { room.scores.X += 0.5; room.scores.O += 0.5; }
        else room.scores[data.winner] += 1;
        io.to(data.roomId).emit('scores_updated', room.scores);
    });

    socket.on('request_replay', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        room.replay_requests.add(socket.id);
        socket.to(data.roomId).emit('opponent_wants_replay');
        if (room.replay_requests.size >= 2) {
            room.replay_requests.clear(); room.game_number++;
            room.last_starter = room.last_starter === 'X' ? 'O' : 'X';
            room.currentGameScored = false; room.gameActive = true;
            io.to(data.roomId).emit('replay_accepted', { starter: room.last_starter, scores: room.scores, gameNumber: room.game_number });
        }
    });

    socket.on('send_invite', (data) => {
        const targetSocket = onlinePlayers[data.friendId];
        if (targetSocket) io.to(targetSocket).emit('game_invite', { roomId: data.roomId, from: data.from });
        else socket.emit('error_msg', 'Friend is offline!');
    });

    socket.on('check_friends_online', (friendIds, callback) => {
        const result = {};
        friendIds.forEach(id => { result[id] = !!onlinePlayers[id]; });
        callback(result);
    });

    socket.on('disconnect', () => {
        if (registeredPlayerId) delete onlinePlayers[registeredPlayerId];
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                const wasActive = room.gameActive;
                const gameWasPlayed = room.game_number > 0;
                let msg;
                if (wasActive) {
                    msg = 'Opponent left mid-game! You win!';
                } else if (gameWasPlayed) {
                    msg = 'Opponent has left the room.';
                } else {
                    msg = 'Opponent left before the game started.';
                }
                socket.to(roomId).emit('player_disconnected', {
                    msg: msg,
                    duringGame: wasActive
                });
                delete rooms[roomId]; break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
