const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8, // 100 MB limit
    pingTimeout: 60000, // 60 saniye ping timeout
    pingInterval: 25000 // 25 saniye ping aralığı
});
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Geçici dosyalar için klasör
const tempDir = path.join(os.tmpdir(), 'sync-music-player');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Şarkılar için klasör
const songsDir = path.join(__dirname, 'songs');
if (!fs.existsSync(songsDir)) {
    fs.mkdirSync(songsDir, { recursive: true });
}

// Sunucu kapanırken şarkıları temizle
process.on('SIGINT', cleanupSongs);
process.on('SIGTERM', cleanupSongs);

function cleanupSongs() {
    console.log('Şarkı dosyaları temizleniyor...');
    try {
        if (fs.existsSync(songsDir)) {
            const files = fs.readdirSync(songsDir);
            for (const file of files) {
                fs.unlinkSync(path.join(songsDir, file));
            }
            console.log(`${files.length} şarkı dosyası temizlendi`);
        }
    } catch (err) {
        console.error('Şarkı temizleme hatası:', err);
    }
    process.exit(0);
}

// Şarkıları periyodik olarak temizle (24 saatte bir)
setInterval(() => {
    try {
        if (fs.existsSync(songsDir)) {
            const files = fs.readdirSync(songsDir);
            const now = Date.now();
            let deletedCount = 0;
            
            for (const file of files) {
                const filePath = path.join(songsDir, file);
                const stats = fs.statSync(filePath);
                const fileAge = now - stats.mtimeMs;
                
                // 24 saatten eski dosyaları sil
                if (fileAge > 24 * 60 * 60 * 1000) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            }
            
            if (deletedCount > 0) {
                console.log(`${deletedCount} eski şarkı dosyası temizlendi`);
            }
        }
    } catch (err) {
        console.error('Periyodik temizleme hatası:', err);
    }
}, 60 * 60 * 1000); // Her saat kontrol et

app.use(express.static('public'));
app.use('/songs', express.static(songsDir));

// Sunucu başlatıldığında songs klasörünü temizleme işlemini kaldıralım
// Böylece şarkılar sunucu yeniden başlatılsa bile kalacak
console.log('Sunucu başlatıldı, şarkı klasörü korunuyor...');

// Eski şarkıları temizleme işlemini kaldıralım ve sadece çok eski dosyaları temizleyelim
try {
    if (fs.existsSync(songsDir)) {
        const files = fs.readdirSync(songsDir);
        const now = Date.now();
        let deletedCount = 0;
        
        for (const file of files) {
            const filePath = path.join(songsDir, file);
            const stats = fs.statSync(filePath);
            const fileAge = now - stats.mtimeMs;
            
            // 7 günden eski dosyaları sil (1 hafta)
            if (fileAge > 7 * 24 * 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        }
        
        if (deletedCount > 0) {
            console.log(`${deletedCount} adet 7 günden eski şarkı dosyası temizlendi`);
        }
    }
} catch (err) {
    console.error('Eski şarkı temizleme hatası:', err);
}

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

const rooms = new Map();

// Base64 veriyi dosyaya kaydet ve dosya yolunu döndür
function saveBase64ToFile(base64Data, fileName) {
    // Dosya adını güvenli hale getir
    const safeFileName = fileName.replace(/[^a-zA-Z0-9.]/g, '_');
    
    // Benzersiz bir dosya adı oluştur
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const fileExt = path.extname(safeFileName);
    const baseName = path.basename(safeFileName, fileExt);
    const uniqueFileName = `${baseName}_${uniqueId}${fileExt}`;
    
    const filePath = path.join(songsDir, uniqueFileName);
    
    // Base64 veriyi ayır (data:audio/mp3;base64,...)
    const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    
    if (matches && matches.length === 3) {
        const buffer = Buffer.from(matches[2], 'base64');
        fs.writeFileSync(filePath, buffer);
        return `/songs/${uniqueFileName}`;
    } else {
        throw new Error('Geçersiz base64 veri formatı');
    }
}

// Benzersiz oda ID'si oluştur
function generateRoomId() {
    return crypto.randomBytes(4).toString('hex');
}

io.on('connection', (socket) => {
    console.log('Yeni kullanıcı bağlandı:', socket.id);
    
    // Oda oluşturma
    socket.on('createRoom', (data, callback) => {
        try {
            const roomId = generateRoomId();
            
            rooms.set(roomId, {
                id: roomId,
                host: socket.id,
                users: new Map([[socket.id, 'Host']]),
                songs: [],
                currentTrack: 0,
                isPlaying: false
            });
            
            socket.join(roomId);
            
            if (callback) callback({ success: true });
            socket.emit('roomCreated', roomId);
            
            console.log(`Oda oluşturuldu: ${roomId} (Host: ${socket.id})`);
        } catch (error) {
            console.error('Oda oluşturma hatası:', error);
            if (callback) callback({ error: 'Oda oluşturulurken bir hata oluştu' });
        }
    });

    // Odaya katılma
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms.get(roomId);
        if (room) {
            socket.join(roomId);
            room.users.set(socket.id, username);
            
            // Kullanıcıya oda bilgilerini gönder
            socket.emit('joinedRoom', {
                roomId,
                isHost: room.host === socket.id,
                currentTrack: room.currentTrack,
                isPlaying: room.isPlaying
            });
            
            // Mevcut şarkı listesini gönder
            socket.emit('updatePlaylist', room.songs);
            
            // Kullanıcı listesini güncelle
            const users = Array.from(room.users.entries()).map(([id, name]) => ({
                id,
                name,
                isHost: id === room.host
            }));
            io.to(roomId).emit('updateUsers', users);
            
            console.log(`${username} odaya katıldı: ${roomId}`);
        } else {
            socket.emit('error', 'Oda bulunamadı');
        }
    });

    // Şarkı ekleme
    socket.on('addSong', async ({ roomId, song }) => {
        const room = rooms.get(roomId);
        if (room) {
            try {
                const filePath = saveBase64ToFile(song.data, song.name);
                const songObj = {
                    name: song.name,
                    url: filePath,
                    addedBy: room.users.get(socket.id) || 'Bilinmeyen Kullanıcı',
                    addedAt: Date.now()
                };
                
                room.songs.push(songObj);
                
                // Tüm kullanıcılara yeni şarkıyı bildir
                io.to(roomId).emit('songAdded', {
                    songName: song.name,
                    songUrl: filePath,
                    addedBy: songObj.addedBy
                });
                
                // Çalma listesini güncelle
                io.to(roomId).emit('updatePlaylist', room.songs);
                
                console.log(`Yeni şarkı eklendi: ${song.name} (${roomId})`);
            } catch (error) {
                console.error('Şarkı kaydetme hatası:', error);
                socket.emit('error', 'Şarkı kaydedilemedi: ' + error.message);
            }
        }
    });

    // Host şarkıyı başlattığında
    socket.on('hostStarted', ({ roomId, currentTime, songUrl }) => {
        const room = rooms.get(roomId);
        if (room && room.host === socket.id) {
            room.isPlaying = true;
            
            // Host dışındaki kullanıcılara bildir
            socket.to(roomId).emit('hostStartedPlaying', {
                currentTime,
                songUrl
            });
            
            console.log(`Host şarkıyı başlattı: ${roomId}, süre: ${currentTime}`);
        }
    });

    // Host şarkıyı duraklattığında
    socket.on('hostPaused', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room && room.host === socket.id) {
            room.isPlaying = false;
            
            // Host dışındaki kullanıcılara bildir
            socket.to(roomId).emit('hostPausedPlaying');
            
            console.log(`Host şarkıyı duraklattı: ${roomId}`);
        }
    });

    // Kullanıcı ayrıldığında
    socket.on('disconnect', () => {
        rooms.forEach((room, roomId) => {
            if (room.users.has(socket.id)) {
                const username = room.users.get(socket.id);
                room.users.delete(socket.id);
                
                // Eğer ayrılan kullanıcı host ise
                if (room.host === socket.id) {
                    // Odadaki ilk kullanıcıyı yeni host yap
                    const newHost = Array.from(room.users.keys())[0];
                    if (newHost) {
                        room.host = newHost;
                        io.to(roomId).emit('newHost', {
                            hostId: newHost,
                            hostName: room.users.get(newHost)
                        });
                    }
                }
                
                // Kullanıcı listesini güncelle
                const users = Array.from(room.users.entries()).map(([id, name]) => ({
                    id,
                    name,
                    isHost: id === room.host
                }));
                io.to(roomId).emit('updateUsers', users);
                
                // Odada kimse kalmadıysa odayı sil
                if (room.users.size === 0) {
                    rooms.delete(roomId);
                    console.log(`Oda silindi: ${roomId}`);
                }
                
                console.log(`${username} odadan ayrıldı: ${roomId}`);
            }
        });
    });
});

// Odaları ve şarkıları kalıcı hale getirmek için dosya sistemi kullanacağız
const roomsFilePath = path.join(__dirname, 'rooms.json');

// Odaları dosyadan yükle (eğer varsa)
function loadRoomsFromFile() {
    try {
        if (fs.existsSync(roomsFilePath)) {
            const roomsData = JSON.parse(fs.readFileSync(roomsFilePath, 'utf8'));
            
            // Oda verilerini Map yapısına dönüştür
            roomsData.forEach(roomData => {
                const { id, songs, currentTrack, isPlaying, currentTime } = roomData;
                
                // Şarkı dosyalarının varlığını kontrol et
                const validSongs = songs.filter(song => {
                    const songFileName = song.data.split('/').pop();
                    const songPath = path.join(songsDir, songFileName);
                    return fs.existsSync(songPath);
                });
                
                if (validSongs.length > 0) {
                    rooms.set(id, {
                        songs: validSongs,
                        users: new Map(),
                        currentTrack: Math.min(currentTrack, validSongs.length - 1),
                        isPlaying: false, // Başlangıçta çalmıyor olarak ayarla
                        currentTime: currentTime || 0,
                        host: null
                    });
                    console.log(`Oda yüklendi: ${id}, ${validSongs.length} şarkı`);
                }
            });
            
            console.log(`Toplam ${rooms.size} oda yüklendi`);
        }
    } catch (err) {
        console.error('Odaları yükleme hatası:', err);
    }
}

// Odaları dosyaya kaydet
function saveRoomsToFile() {
    try {
        const roomsData = [];
        
        rooms.forEach((room, id) => {
            roomsData.push({
                id,
                songs: room.songs,
                currentTrack: room.currentTrack,
                isPlaying: room.isPlaying,
                currentTime: room.currentTime
            });
        });
        
        fs.writeFileSync(roomsFilePath, JSON.stringify(roomsData, null, 2));
        console.log(`${rooms.size} oda kaydedildi`);
    } catch (err) {
        console.error('Odaları kaydetme hatası:', err);
    }
}

// Başlangıçta odaları yükle
loadRoomsFromFile();

// Periyodik olarak odaları kaydet (her 5 dakikada bir)
setInterval(saveRoomsToFile, 5 * 60 * 1000);

// Sunucu kapanırken odaları kaydet
process.on('SIGINT', () => {
    console.log('Sunucu kapatılıyor, odalar kaydediliyor...');
    saveRoomsToFile();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Sunucu kapatılıyor, odalar kaydediliyor...');
    saveRoomsToFile();
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 