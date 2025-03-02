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
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

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

// YouTube API anahtarı (Google Cloud Console'dan alınmalı)
const YOUTUBE_API_KEY = 'YOUR_API_KEY';

// YouTube linkini işleyen fonksiyonu güncelleyelim
async function processYoutubeLink(url) {
    try {
        // Video ID'sini çıkar
        const videoId = extractVideoId(url);
        if (!videoId) {
            throw new Error('Geçersiz YouTube URL');
        }
        
        // Video bilgilerini al
        const response = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
            params: {
                part: 'snippet',
                id: videoId,
                key: YOUTUBE_API_KEY
            }
        });
        
        if (!response.data.items || response.data.items.length === 0) {
            throw new Error('Video bulunamadı');
        }
        
        const videoInfo = response.data.items[0].snippet;
        const title = videoInfo.title;
        
        // Doğrudan YouTube embed URL'sini kullan
        return {
            name: title,
            data: `https://www.youtube.com/embed/${videoId}?autoplay=1`,
            source: 'youtube',
            videoId: videoId,
            embedMode: true
        };
    } catch (error) {
        console.error('YouTube processing error:', error);
        throw error;
    }
}

// YouTube video ID'sini çıkaran yardımcı fonksiyon
function extractVideoId(url) {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[7].length === 11) ? match[7] : null;
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