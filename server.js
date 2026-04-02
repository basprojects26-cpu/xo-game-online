const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'XO.html')));

const rooms = {};

function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('create_room', (data) => {
        const roomId = generateRoomId();
        socket.join(roomId);
        const firstStarter = Math.random() < 0.5 ? 'X' : 'O';
        rooms[roomId] = {
            players: [{ id: socket.id, profile: data.profile, symbol: 'X' }],
            settings: data.settings,
            scores: { X: 0, O: 0 },
            game_number: 0,
            last_starter: null,
            first_starter: firstStarter,
            currentGameScored: false,
            replay_requests: new Set()
        };
        socket.emit('room_created', roomId);
    });

    socket.on('join_room', (data) => {
        const room = rooms[data.roomId];
        if (!room) { socket.emit('error_msg', 'Room not found!'); return; }
        if (room.players.length >= 2) { socket.emit('error_msg', 'Room is full!'); return; }

        socket.join(data.roomId);
        room.players.push({ id: socket.id, profile: data.profile, symbol: 'O' });
        room.game_number = 1;
        room.last_starter = room.first_starter;
        room.currentGameScored = false;

        const p1 = room.players[0], p2 = room.players[1];
        io.to(p1.id).emit('game_start_online', {
            roomId: data.roomId,
            symbol: 'X', opponent: p2.profile, settings: room.settings,
            starter: room.first_starter, scores: room.scores, gameNumber: 1
        });
        io.to(p2.id).emit('game_start_online', {
            roomId: data.roomId,
            symbol: 'O', opponent: p1.profile, settings: room.settings,
            starter: room.first_starter, scores: room.scores, gameNumber: 1
        });
    });

    socket.on('make_move', (data) => {
        socket.to(data.roomId).emit('move_made', data.index);
    });

    socket.on('randomizer_sync', (data) => {
        socket.to(data.roomId).emit('randomizer_event_sync', data.board);
    });

    socket.on('game_ended', (data) => {
        const room = rooms[data.roomId];
        if (!room || room.currentGameScored) return;
        room.currentGameScored = true;
        if (data.winner === 'draw') { room.scores.X += 0.5; room.scores.O += 0.5; }
        else { room.scores[data.winner] += 1; }
        io.to(data.roomId).emit('scores_updated', room.scores);
    });

    socket.on('request_replay', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        room.replay_requests.add(socket.id);
        socket.to(data.roomId).emit('opponent_wants_replay');
        if (room.replay_requests.size >= 2) {
            room.replay_requests.clear();
            room.game_number++;
            room.last_starter = room.last_starter === 'X' ? 'O' : 'X';
            room.currentGameScored = false;
            io.to(data.roomId).emit('replay_accepted', {
                starter: room.last_starter,
                scores: room.scores,
                gameNumber: room.game_number
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.players.findIndex(p => p.id === socket.id) !== -1) {
                socket.to(roomId).emit('player_disconnected', 'Opponent disconnected!');
                delete rooms[roomId];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
