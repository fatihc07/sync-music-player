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
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');

// FFmpeg yolunu ayarla
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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

// YouTube linkini işleyen fonksiyon
async function processYoutubeLink(url) {
    try {
        // Video bilgilerini al
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title;
        const videoId = info.videoDetails.videoId;
        
        // Geçici dosya yolları
        const tempFilePath = path.join(tempDir, `${videoId}.mp3`);
        
        // Eğer dosya zaten varsa, doğrudan döndür
        if (fs.existsSync(tempFilePath)) {
            const data = fs.readFileSync(tempFilePath, { encoding: 'base64' });
            return {
                name: title,
                data: `data:audio/mp3;base64,${data}`,
                source: 'youtube',
                videoId: videoId
            };
        }
        
        // YouTube'dan ses akışını al
        const stream = ytdl(url, { 
            quality: 'highestaudio',
            filter: 'audioonly'
        });
        
        // MP3'e dönüştür
        return new Promise((resolve, reject) => {
            ffmpeg(stream)
                .audioBitrate(128)
                .format('mp3')
                .on('error', (err) => {
                    console.error('FFmpeg error:', err);
                    reject(err);
                })
                .on('end', () => {
                    // Dosyayı base64'e dönüştür
                    const data = fs.readFileSync(tempFilePath, { encoding: 'base64' });
                    resolve({
                        name: title,
                        data: `data:audio/mp3;base64,${data}`,
                        source: 'youtube',
                        videoId: videoId
                    });
                })
                .save(tempFilePath);
        });
    } catch (error) {
        console.error('YouTube processing error:', error);
        throw error;
    }
}

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
            
            room.songs.push(song);
            io.to(roomId).emit('updatePlaylist', room.songs);
            
            // Yeni şarkı eklendi bildirimi
            io.to(roomId).emit('songAdded', { 
                songName: song.name, 
                addedBy: song.addedBy 
            });
            
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

    socket.on('addYoutubeLink', async ({ roomId, url }) => {
        const room = rooms.get(roomId);
        if (room) {
            try {
                // YouTube linkini işle
                socket.emit('processingYoutube', { url });
                const song = await processYoutubeLink(url);
                
                // Ekleyen kişi bilgisini ekle
                song.addedBy = room.users.get(socket.id) || 'Bilinmeyen Kullanıcı';
                
                // Şarkıyı odaya ekle
                room.songs.push(song);
                io.to(roomId).emit('updatePlaylist', room.songs);
                
                // Yeni şarkı eklendi bildirimi
                io.to(roomId).emit('songAdded', { 
                    songName: song.name, 
                    addedBy: song.addedBy,
                    source: 'youtube'
                });
                
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
            } catch (error) {
                socket.emit('error', `YouTube video işlenirken hata: ${error.message}`);
            }
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