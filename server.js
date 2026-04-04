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
const onlinePlayers = {};       // playerId -> socketId
const playerProfiles = {};      // playerId -> { name, avatar }
const playerDND = {};           // playerId -> boolean
const pendingFriendRequests = {}; // targetPlayerId -> [{ fromId, fromProfile, timestamp }]

function genId() { return Math.random().toString(36).substring(2, 7).toUpperCase(); }

io.on('connection', (socket) => {
    let registeredPlayerId = null;

    socket.on('register_player', (data) => {
        registeredPlayerId = typeof data === 'string' ? data : data.playerId;
        onlinePlayers[registeredPlayerId] = socket.id;
        if (data.profile) {
            playerProfiles[registeredPlayerId] = data.profile;
        }
        // Send any pending friend requests to this player
        if (pendingFriendRequests[registeredPlayerId] && pendingFriendRequests[registeredPlayerId].length > 0) {
            socket.emit('pending_friend_requests', pendingFriendRequests[registeredPlayerId]);
        }
    });

    socket.on('update_profile', (profile) => {
        if (registeredPlayerId) {
            playerProfiles[registeredPlayerId] = profile;
        }
    });

    socket.on('set_dnd', (enabled) => {
        if (registeredPlayerId) {
            playerDND[registeredPlayerId] = enabled;
        }
    });

    socket.on('get_player_profile', (playerId, callback) => {
        const profile = playerProfiles[playerId];
        if (profile) callback({ found: true, profile, playerId });
        else callback({ found: false, playerId });
    });

    socket.on('send_friend_request', (data) => {
        const targetId = data.targetId;
        const fromProfile = data.fromProfile;

        if (targetId === registeredPlayerId) {
            socket.emit('error_msg', "You can't add yourself!");
            return;
        }

        if (!pendingFriendRequests[targetId]) pendingFriendRequests[targetId] = [];
        const existing = pendingFriendRequests[targetId].find(r => r.fromId === registeredPlayerId);
        if (existing) {
            socket.emit('error_msg', 'Friend request already pending!');
            return;
        }

        const request = { fromId: registeredPlayerId, fromProfile, timestamp: Date.now() };
        pendingFriendRequests[targetId].push(request);

        const targetSocket = onlinePlayers[targetId];
        if (targetSocket) {
            io.to(targetSocket).emit('friend_request_received', request);
        }
        socket.emit('friend_request_sent', { targetId });
    });

    socket.on('respond_friend_request', (data) => {
        const fromId = data.fromId;
        const accepted = data.accepted;

        if (pendingFriendRequests[registeredPlayerId]) {
            pendingFriendRequests[registeredPlayerId] = pendingFriendRequests[registeredPlayerId].filter(r => r.fromId !== fromId);
        }

        // Send back the cleaned pending list so the client stays in sync
        socket.emit('pending_friend_requests', pendingFriendRequests[registeredPlayerId] || []);

        if (accepted) {
            const senderSocket = onlinePlayers[fromId];
            const myProfile = playerProfiles[registeredPlayerId] || { name: 'Player', avatar: '👤' };
            if (senderSocket) {
                io.to(senderSocket).emit('friend_request_accepted', { playerId: registeredPlayerId, profile: myProfile });
            }
            const senderProfile = playerProfiles[fromId] || { name: 'Player', avatar: '👤' };
            socket.emit('friend_added_mutual', { playerId: fromId, profile: senderProfile });
        } else {
            const senderSocket = onlinePlayers[fromId];
            if (senderSocket) {
                io.to(senderSocket).emit('friend_request_denied', { playerId: registeredPlayerId });
            }
        }
    });

    socket.on('remove_friend', (data) => {
        const friendId = data.friendId;
        const friendSocket = onlinePlayers[friendId];
        if (friendSocket) {
            io.to(friendSocket).emit('friend_removed', { playerId: registeredPlayerId });
        }
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
        if (playerDND[data.friendId]) {
            socket.emit('error_msg', 'Player has Do Not Disturb enabled!');
            return;
        }
        const targetSocket = onlinePlayers[data.friendId];
        if (targetSocket) io.to(targetSocket).emit('game_invite', { roomId: data.roomId, from: data.from });
        else socket.emit('error_msg', 'Friend is offline!');
    });

    socket.on('check_friends_online', (friendIds, callback) => {
        const result = {};
        friendIds.forEach(id => {
            result[id] = !!onlinePlayers[id];
        });
        if (typeof callback === 'function') callback(result);
    });

    socket.on('leave_room', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const idx = room.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
            const wasActive = room.gameActive;
            const gameWasPlayed = room.game_number > 0;
            let msg;
            if (wasActive) msg = 'Opponent left mid-game! You win!';
            else if (gameWasPlayed) msg = 'Opponent has left the room.';
            else msg = 'Opponent left before the game started.';
            socket.to(roomId).emit('player_disconnected', { msg, duringGame: wasActive });
            socket.leave(roomId);
            delete rooms[roomId];
        }
    });

    socket.on('disconnect', () => {
        if (registeredPlayerId) {
            delete onlinePlayers[registeredPlayerId];
            delete playerDND[registeredPlayerId];
        }
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                const wasActive = room.gameActive;
                const gameWasPlayed = room.game_number > 0;
                let msg;
                if (wasActive) msg = 'Opponent left mid-game! You win!';
                else if (gameWasPlayed) msg = 'Opponent has left the room.';
                else msg = 'Opponent left before the game started.';
                socket.to(roomId).emit('player_disconnected', { msg: msg, duringGame: wasActive });
                delete rooms[roomId]; break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
