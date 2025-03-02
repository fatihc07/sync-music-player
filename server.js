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
const crypto = require('crypto');

// Geçici dosyalar için klasör
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`Geçici klasör oluşturuldu: ${tempDir}`);
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

// Sunucu başlatıldığında songs klasörünü temizle
console.log('Başlangıçta şarkı klasörü temizleniyor...');
try {
    if (fs.existsSync(songsDir)) {
        const files = fs.readdirSync(songsDir);
        for (const file of files) {
            fs.unlinkSync(path.join(songsDir, file));
        }
        console.log(`${files.length} şarkı dosyası temizlendi`);
    }
} catch (err) {
    console.error('Başlangıç temizleme hatası:', err);
}

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

const rooms = new Map();

// Oda başına klasör oluşturma fonksiyonu
function ensureRoomDirectory(roomId) {
    const roomDir = path.join(tempDir, roomId);
    if (!fs.existsSync(roomDir)) {
        fs.mkdirSync(roomDir, { recursive: true });
        console.log(`Oda klasörü oluşturuldu: ${roomDir}`);
    }
    return roomDir;
}

// Base64 veriyi dosyaya kaydet ve dosya yolunu döndür
function saveBase64ToFile(base64Data, fileName) {
    console.log(`saveBase64ToFile çağrıldı: ${fileName}`);
    
    // Dosya adını güvenli hale getir
    const safeFileName = fileName.replace(/[^a-zA-Z0-9.]/g, '_');
    
    // Benzersiz bir dosya adı oluştur
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const fileExt = path.extname(safeFileName);
    const baseName = path.basename(safeFileName, fileExt);
    const uniqueFileName = `${baseName}_${uniqueId}${fileExt}`;
    
    const filePath = path.join(songsDir, uniqueFileName);
    console.log(`Hedef dosya yolu: ${filePath}`);
    
    try {
        // Base64 veriyi ayır (data:audio/mp3;base64,...)
        const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        
        if (!matches || matches.length !== 3) {
            console.error('Geçersiz base64 veri formatı');
            throw new Error('Geçersiz base64 veri formatı');
        }
        
        const buffer = Buffer.from(matches[2], 'base64');
        console.log(`Buffer oluşturuldu, boyut: ${buffer.length} byte`);
        
        // Klasörün varlığını kontrol et
        if (!fs.existsSync(songsDir)) {
            console.log(`Klasör bulunamadı, oluşturuluyor: ${songsDir}`);
            fs.mkdirSync(songsDir, { recursive: true });
        }
        
        // Dosyayı yaz
        fs.writeFileSync(filePath, buffer);
        console.log(`Dosya başarıyla yazıldı: ${filePath}`);
        
        return `/songs/${uniqueFileName}`;
    } catch (error) {
        console.error(`Dosya kaydetme hatası: ${error.message}`);
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

    socket.on('addSong', async (data, callback) => {
        console.log(`Şarkı ekleme isteği alındı: ${data.song.name}, Oda: ${data.roomId}`);
        
        try {
            const roomId = data.roomId;
            const song = data.song;
            
            // Oda var mı kontrol et
            if (!rooms.get(roomId)) {
                console.error(`Oda bulunamadı: ${roomId}`);
                if (callback) callback({ success: false, error: 'Oda bulunamadı' });
                return;
            }
            
            // Şarkıyı ekleyen kullanıcıyı ekle (eğer yoksa)
            if (!song.addedBy && socket.username) {
                song.addedBy = socket.username;
            }
            
            // Şarkı ekleme zamanını ekle
            song.addedAt = Date.now();
            
            // Base64 veri formatını kontrol et
            if (!song.data || typeof song.data !== 'string' || !song.data.startsWith('data:')) {
                console.error('Geçersiz şarkı verisi formatı');
                if (callback) callback({ success: false, error: 'Geçersiz şarkı verisi formatı' });
                return;
            }
            
            // Oda klasörünü oluştur
            const roomDir = ensureRoomDirectory(roomId);
            
            // Dosya adını temizle ve benzersiz yap
            const cleanFileName = song.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
            const uniqueFileName = `${Date.now()}_${cleanFileName}`;
            const filePath = path.join(roomDir, uniqueFileName);
            
            console.log(`Şarkı dosyası kaydediliyor: ${filePath}`);
            
            // Base64 veriyi dosyaya kaydet
            await saveBase64ToFile(song.data, filePath);
            
            // Şarkı nesnesini güncelle - base64 veri yerine dosya yolunu sakla
            song.data = filePath;
            delete song.base64Data; // Eğer varsa eski base64 verisini temizle
            
            // Şarkıyı çalma listesine ekle
            rooms.get(roomId).songs.push(song);
            
            console.log(`Şarkı başarıyla eklendi: ${song.name}, Toplam şarkı: ${rooms.get(roomId).songs.length}`);
            
            // Tüm kullanıcılara güncel çalma listesini gönder
            io.to(roomId).emit('updatePlaylist', rooms.get(roomId).songs);
            
            // Şarkı eklendi bildirimini gönder
            io.to(roomId).emit('songAdded', {
                songName: song.name,
                addedBy: song.addedBy
            });
            
            // İlk şarkı eklendiyse veya hiçbir şarkı çalmıyorsa, sadece çalma listesini güncelle
            // Otomatik başlatma kaldırıldı
            if (rooms.get(roomId).songs.length === 1 || rooms.get(roomId).currentTrack === -1) {
                rooms.get(roomId).currentTrack = 0;
                // Otomatik çalmayı iptal et, isPlaying false olarak kalsın
                rooms.get(roomId).isPlaying = false;
                
                // Tüm kullanıcılara şarkı bilgisini gönder ama autoplay false olarak ayarla
                io.to(roomId).emit('playSong', {
                    song: rooms.get(roomId).songs[0],
                    index: 0,
                    autoplay: false, // Otomatik çalmayı devre dışı bırak
                    serverTime: Date.now()
                });
            }
            
            // Başarı yanıtı gönder
            if (callback) callback({ success: true });
            
        } catch (error) {
            console.error('Şarkı eklenirken hata:', error);
            if (callback) callback({ success: false, error: error.message });
        }
    });

    socket.on('play', ({ roomId, currentTime }) => {
        const room = rooms.get(roomId);
        if (room) {
            room.isPlaying = true;
            room.currentTime = currentTime;
            room.lastSyncTime = Date.now();
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
            room.lastSyncTime = Date.now();
            io.to(roomId).emit('playSong', { 
                song: room.songs[index], 
                index: index,
                autoplay: true,
                serverTime: Date.now()
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
    
    // Çalma listesini yenileme isteği
    socket.on('requestPlaylist', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room) {
            // Sadece istek yapan kullanıcıya güncel çalma listesini gönder
            socket.emit('updatePlaylist', room.songs);
            socket.emit('currentTrackChanged', room.currentTrack);
            
            // Kullanıcı adını al
            const username = room.users.get(socket.id) || 'Bilinmeyen Kullanıcı';
            console.log(`${username} çalma listesini yeniledi, ${room.songs.length} şarkı gönderildi`);
        }
    });

    // Oda silme işlemi
    socket.on('deleteRoom', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room) {
            // Odadaki tüm kullanıcılara bildirim gönder
            io.to(roomId).emit('roomDeleted', { 
                message: 'Oda silindi. Ana sayfaya yönlendiriliyorsunuz...'
            });
            
            // Odaya ait şarkı dosyalarını temizle
            try {
                if (fs.existsSync(songsDir)) {
                    const files = fs.readdirSync(songsDir);
                    let deletedCount = 0;
                    
                    // Odaya ait şarkıları bul ve sil
                    room.songs.forEach(song => {
                        if (song.data && song.data.startsWith('/songs/')) {
                            const songFileName = song.data.split('/').pop(); // /songs/filename.mp3 -> filename.mp3
                            
                            files.forEach(file => {
                                if (file === songFileName) {
                                    const filePath = path.join(songsDir, file);
                                    if (fs.existsSync(filePath)) {
                                        fs.unlinkSync(filePath);
                                        deletedCount++;
                                    }
                                }
                            });
                        }
                    });
                    
                    console.log(`Oda silindi: ${roomId}, ${deletedCount} şarkı dosyası temizlendi`);
                }
            } catch (err) {
                console.error('Oda şarkılarını silme hatası:', err);
            }
            
            // Odadaki tüm kullanıcıları odadan çıkar
            const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
            if (socketsInRoom) {
                for (const socketId of socketsInRoom) {
                    const clientSocket = io.sockets.sockets.get(socketId);
                    if (clientSocket) {
                        clientSocket.leave(roomId);
                    }
                }
            }
            
            // Odayı sil
            rooms.delete(roomId);
            console.log(`Oda başarıyla silindi: ${roomId}`);
        } else {
            socket.emit('error', 'Oda bulunamadı veya zaten silinmiş');
        }
    });

    // Yeni: Periyodik senkronizasyon için event handler ekle
    socket.on('requestSync', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room && room.isPlaying) {
            // Çalma süresi hesapla (son senkronizasyondan bu yana geçen süre)
            const elapsedTime = (Date.now() - room.lastSyncTime) / 1000;
            const syncedTime = room.currentTime + elapsedTime;
            
            // Sadece istek yapan kullanıcıya senkronizasyon bilgisi gönder
            socket.emit('syncPlayback', {
                currentTime: syncedTime,
                serverTime: Date.now()
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

// Sunucu başlatıldığında geçici klasörü temizle
function cleanupTempDirectory() {
    if (fs.existsSync(tempDir)) {
        try {
            // Tüm oda klasörlerini kontrol et
            const roomDirs = fs.readdirSync(tempDir);
            let totalFiles = 0;
            
            for (const roomDir of roomDirs) {
                const fullPath = path.join(tempDir, roomDir);
                
                // Klasör mü kontrol et
                if (fs.statSync(fullPath).isDirectory()) {
                    // Aktif oda mı kontrol et
                    if (!rooms.has(roomDir)) {
                        // Aktif olmayan odanın dosyalarını sil
                        const files = fs.readdirSync(fullPath);
                        totalFiles += files.length;
                        
                        for (const file of files) {
                            fs.unlinkSync(path.join(fullPath, file));
                        }
                        
                        // Klasörü sil
                        fs.rmdirSync(fullPath);
                        console.log(`Kullanılmayan oda klasörü temizlendi: ${roomDir}`);
                    }
                }
            }
            
            console.log(`Geçici klasör temizlendi: ${totalFiles} dosya silindi`);
        } catch (error) {
            console.error(`Geçici klasör temizlenirken hata: ${error.message}`);
        }
    }
}

// Sunucu başlatıldığında temizlik yap
cleanupTempDirectory();

// Periyodik temizlik (her 6 saatte bir)
setInterval(cleanupTempDirectory, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 8080;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 