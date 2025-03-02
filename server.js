const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100 MB limit
});
const fs = require('fs');
const path = require('path');
const os = require('os');

// Geçici dosyalar için klasör
const tempDir = path.join(os.tmpdir(), 'sync-music-player');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

const rooms = new Map();

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomId = Math.random().toString(36).substring(7);
        rooms.set(roomId, {
            songs: [],
            users: new Map(),
            currentTrack: 0,
            isPlaying: false,
            currentTime: 0
        });
        socket.emit('roomCreated', roomId);
    });

    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms.get(roomId);
        if (room) {
            socket.join(roomId);
            room.users.set(socket.id, username);
            
            // Tüm kullanıcılara güncel kullanıcı listesini gönder
            const users = Array.from(room.users.entries()).map(([id, name]) => ({
                id,
                name
            }));
            
            io.to(roomId).emit('updateUsers', users);
            socket.emit('updatePlaylist', room.songs);
            socket.emit('syncState', {
                currentTime: room.currentTime,
                isPlaying: room.isPlaying,
                currentTrack: room.currentTrack
            });
            
            // Yeni kullanıcı katıldı bildirimi
            io.to(roomId).emit('userJoined', { id: socket.id, name: username });
        } else {
            socket.emit('error', 'Oda bulunamadı');
        }
    });

    socket.on('addSong', ({ roomId, song }) => {
        const room = rooms.get(roomId);
        if (room) {
            // Şarkıya ekleyen kişi bilgisini ekleyelim
            if (!song.addedBy) {
                song.addedBy = room.users.get(socket.id) || 'Bilinmeyen Kullanıcı';
            }
            
            // Şarkıyı çalma listesine ekle
            room.songs.push(song);
            
            // Tüm kullanıcılara güncel çalma listesini gönder
            io.to(roomId).emit('updatePlaylist', room.songs);
            
            // Yeni şarkı eklendi bildirimi
            io.to(roomId).emit('songAdded', { 
                songName: song.name, 
                addedBy: song.addedBy 
            });
            
            console.log(`Şarkı eklendi: ${song.name}, Toplam: ${room.songs.length}`);
            
            // Eğer ilk şarkıysa veya hiçbir şarkı çalmıyorsa otomatik başlat
            if (room.songs.length === 1 || !room.isPlaying) {
                const index = room.songs.length - 1;
                room.currentTrack = index;
                room.isPlaying = true;
                room.currentTime = 0;
                io.to(roomId).emit('playSong', { 
                    song: room.songs[index], 
                    index: index 
                });
            }
        }
    });

    socket.on('play', ({ roomId, currentTime }) => {
        const room = rooms.get(roomId);
        if (room) {
            room.isPlaying = true;
            room.currentTime = currentTime;
            io.to(roomId).emit('play', currentTime);
        }
    });

    socket.on('pause', ({ roomId, currentTime }) => {
        const room = rooms.get(roomId);
        if (room) {
            room.isPlaying = false;
            room.currentTime = currentTime;
            io.to(roomId).emit('pause', currentTime);
        }
    });

    socket.on('playSong', ({ roomId, index }) => {
        const room = rooms.get(roomId);
        if (room && room.songs[index]) {
            room.currentTrack = index;
            room.isPlaying = true;
            room.currentTime = 0;
            io.to(roomId).emit('playSong', { 
                song: room.songs[index], 
                index: index 
            });
        }
    });

    // Şarkı sırasını değiştirmek için yeni event handler
    socket.on('reorderPlaylist', ({ roomId, oldIndex, newIndex }) => {
        const room = rooms.get(roomId);
        if (room && room.songs.length > 1) {
            // Şarkıyı eski konumundan çıkar ve yeni konuma ekle
            const [movedSong] = room.songs.splice(oldIndex, 1);
            room.songs.splice(newIndex, 0, movedSong);
            
            // Eğer çalan şarkı taşındıysa, currentTrack'i güncelle
            if (room.currentTrack === oldIndex) {
                room.currentTrack = newIndex;
            } 
            // Eğer çalan şarkı ile taşınan şarkı arasında bir değişiklik olduysa
            else if (oldIndex < room.currentTrack && newIndex >= room.currentTrack) {
                room.currentTrack--;
            } else if (oldIndex > room.currentTrack && newIndex <= room.currentTrack) {
                room.currentTrack++;
            }
            
            // Güncellenmiş çalma listesini tüm kullanıcılara gönder
            io.to(roomId).emit('updatePlaylist', room.songs);
            io.to(roomId).emit('currentTrackChanged', room.currentTrack);
            
            // Şarkı sırası değiştirildi bildirimi
            const username = room.users.get(socket.id) || 'Bilinmeyen Kullanıcı';
            io.to(roomId).emit('playlistReordered', { 
                username: username,
                songName: movedSong.name
            });
        }
    });

    socket.on('disconnect', () => {
        rooms.forEach((room, roomId) => {
            if (room.users.has(socket.id)) {
                const username = room.users.get(socket.id);
                room.users.delete(socket.id);
                
                // Kullanıcı ayrıldı bildirimi
                io.to(roomId).emit('userLeft', { id: socket.id, name: username });
                
                // Güncel kullanıcı listesini gönder
                const users = Array.from(room.users.entries()).map(([id, name]) => ({
                    id,
                    name
                }));
                io.to(roomId).emit('updateUsers', users);
                
                if (room.users.size === 0) {
                    rooms.delete(roomId);
                }
            }
        });
    });
});

const PORT = process.env.PORT || 8080;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 