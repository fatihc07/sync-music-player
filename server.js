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

// Periyodik senkronizasyon için interval
const syncIntervals = new Map();

// Odaya özel senkronizasyon interval'i başlat
function startRoomSyncInterval(roomId) {
    // Eğer bu oda için zaten bir interval varsa, önce onu temizle
    if (syncIntervals.has(roomId)) {
        clearInterval(syncIntervals.get(roomId));
    }
    
    // Her 2 saniyede bir odadaki tüm kullanıcılara senkronizasyon bilgisi gönder
    // (3 saniyeden 2 saniyeye düşürdük)
    const intervalId = setInterval(() => {
        const room = rooms.get(roomId);
        if (room && room.isPlaying) {
            // Çalma süresi hesapla (son senkronizasyondan bu yana geçen süre)
            const elapsedTime = (Date.now() - room.lastSyncTime) / 1000;
            const syncedTime = room.currentTime + elapsedTime;
            
            // Odadaki tüm kullanıcılara senkronizasyon bilgisi gönder
            io.to(roomId).emit('syncPlayback', {
                currentTime: syncedTime,
                serverTime: Date.now(),
                currentTrack: room.currentTrack,
                isPlaying: room.isPlaying
            });
            
            console.log(`Oda ${roomId} için senkronizasyon gönderildi: ${syncedTime.toFixed(2)}s, şarkı: ${room.currentTrack}`);
        }
    }, 2000); // 2 saniyede bir senkronize et
    
    syncIntervals.set(roomId, intervalId);
}

// Oda için senkronizasyon interval'ini durdur
function stopRoomSyncInterval(roomId) {
    if (syncIntervals.has(roomId)) {
        clearInterval(syncIntervals.get(roomId));
        syncIntervals.delete(roomId);
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
            console.log('Oda oluşturma isteği alındı:', socket.id);
            
            // Benzersiz bir oda ID'si oluştur
            const roomId = generateRoomId();
            
            // Odayı oluştur
            rooms.set(roomId, {
                id: roomId,
                users: new Map(),
                songs: [],
                isPlaying: false,
                currentTrack: 0,
                currentTime: 0,
                lastSyncTime: Date.now(),
                createdAt: Date.now()
            });
            
            console.log(`Oda oluşturuldu: ${roomId} (${socket.id} tarafından)`);
            
            // Callback fonksiyonu varsa başarı durumunu bildir
            if (callback && typeof callback === 'function') {
                callback({ success: true });
            }
            
            // Oda ID'sini istemciye gönder
            socket.emit('roomCreated', roomId);
        } catch (error) {
            console.error('Oda oluşturma hatası:', error);
            
            // Callback fonksiyonu varsa hatayı bildir
            if (callback && typeof callback === 'function') {
                callback({ error: 'Oda oluşturulurken bir hata oluştu' });
            }
            
            // Hata mesajını istemciye gönder
            socket.emit('error', 'Oda oluşturulurken bir hata oluştu');
        }
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
            
            // Eğer şarkı çalıyorsa, çalma süresini güncelle
            if (room.isPlaying) {
                const elapsedTime = (Date.now() - room.lastSyncTime) / 1000;
                const currentTime = room.currentTime + elapsedTime;
                
                // Yeni kullanıcıya daha detaylı senkronizasyon bilgisi gönder
                socket.emit('syncState', {
                    currentTime: currentTime,
                    isPlaying: room.isPlaying,
                    currentTrack: room.currentTrack,
                    serverTime: Date.now()
                });
                
                console.log(`Yeni kullanıcı ${username} odaya katıldı, çalan şarkı senkronize ediliyor: ${currentTime.toFixed(2)}s, şarkı: ${room.currentTrack}`);
            } else {
                socket.emit('syncState', {
                    currentTime: room.currentTime,
                    isPlaying: room.isPlaying,
                    currentTrack: room.currentTrack,
                    serverTime: Date.now()
                });
                
                console.log(`Yeni kullanıcı ${username} odaya katıldı, şarkı çalmıyor`);
            }
            
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
            
            try {
                // Base64 veriyi dosyaya kaydet
                const filePath = saveBase64ToFile(song.data, song.name);
                
                // Şarkı nesnesini güncelle
                const songObj = {
                    name: song.name,
                    data: filePath, // Artık base64 değil, dosya yolu
                    addedBy: song.addedBy,
                    addedAt: Date.now()
                };
                
                // Şarkıyı çalma listesine ekle
                room.songs.push(songObj);
                
                // Tüm kullanıcılara güncel çalma listesini gönder
                io.to(roomId).emit('updatePlaylist', room.songs);
                
                // Yeni şarkı eklendi bildirimi
                io.to(roomId).emit('songAdded', { 
                    songName: song.name, 
                    addedBy: song.addedBy 
                });
                
                console.log(`Şarkı eklendi: ${song.name}, Toplam: ${room.songs.length}`);
                
                // Eğer ilk şarkıysa veya hiçbir şarkı çalmıyorsa, şarkıyı hazırla ama otomatik başlatma
                if (room.songs.length === 1 || !room.isPlaying) {
                    const index = room.songs.length - 1;
                    room.currentTrack = index;
                    // Otomatik çalmayı kaldıralım
                    room.isPlaying = false; // Şarkı çalmıyor olarak işaretle
                    room.currentTime = 0;
                    io.to(roomId).emit('playSong', { 
                        song: room.songs[index], 
                        index: index,
                        autoplay: false // Otomatik çalma kapalı
                    });
                }
            } catch (error) {
                console.error('Şarkı kaydetme hatası:', error);
                socket.emit('error', 'Şarkı kaydedilemedi: ' + error.message);
            }
            
            // Şarkı eklendiğinde odaları kaydet
            saveRoomsToFile();
        }
    });

    socket.on('play', ({ roomId, currentTime }) => {
        const room = rooms.get(roomId);
        if (room) {
            room.isPlaying = true;
            room.currentTime = currentTime;
            room.lastSyncTime = Date.now();
            
            // Tüm kullanıcılara çalma durumunu bildir
            io.to(roomId).emit('play', {
                currentTime: currentTime,
                serverTime: Date.now(),
                currentTrack: room.currentTrack // Şarkı indeksini de gönder
            });
            
            console.log(`Oda ${roomId}: Şarkı çalınıyor, süre: ${currentTime.toFixed(2)}s, şarkı: ${room.currentTrack}, kullanıcı: ${socket.id}`);
            
            // Oda için senkronizasyon interval'ini başlat
            startRoomSyncInterval(roomId);
            
            // Kullanıcı adını al
            const username = room.users.get(socket.id) || 'Bilinmeyen Kullanıcı';
            
            // Şarkı çalma bildirimi gönder (kim tarafından başlatıldığı bilgisiyle)
            io.to(roomId).emit('notification', {
                message: `${username} şarkıyı başlattı`,
                type: 'info'
            });
        }
    });

    socket.on('pause', ({ roomId, currentTime }) => {
        const room = rooms.get(roomId);
        if (room) {
            room.isPlaying = false;
            room.currentTime = currentTime;
            
            // Tüm kullanıcılara duraklatma durumunu bildir
            io.to(roomId).emit('pause', {
                currentTime: currentTime,
                serverTime: Date.now(),
                currentTrack: room.currentTrack // Şarkı indeksini de gönder
            });
            
            console.log(`Oda ${roomId}: Şarkı duraklatıldı, süre: ${currentTime.toFixed(2)}s, şarkı: ${room.currentTrack}, kullanıcı: ${socket.id}`);
            
            // Oda için senkronizasyon interval'ini durdur
            stopRoomSyncInterval(roomId);
            
            // Kullanıcı adını al
            const username = room.users.get(socket.id) || 'Bilinmeyen Kullanıcı';
            
            // Şarkı duraklatma bildirimi gönder (kim tarafından duraklatıldığı bilgisiyle)
            io.to(roomId).emit('notification', {
                message: `${username} şarkıyı duraklattı`,
                type: 'info'
            });
        }
    });

    socket.on('playSong', ({ roomId, index }) => {
        const room = rooms.get(roomId);
        if (room && room.songs[index]) {
            room.currentTrack = index;
            room.isPlaying = true;
            room.currentTime = 0;
            room.lastSyncTime = Date.now();
            
            // Şarkı değiştiğinde tüm kullanıcılara bildir
            // 5 saniyelik bir gecikme ekleyelim
            const startDelay = 5000; // 5 saniye gecikme
            
            io.to(roomId).emit('playSong', { 
                song: room.songs[index], 
                index: index,
                autoplay: true,
                serverTime: Date.now(),
                startDelay: startDelay // Gecikme süresini ekle
            });
            
            console.log(`Oda ${roomId}: ${index}. şarkı çalınıyor: ${room.songs[index].name} (5 sn gecikme ile)`);
            
            // Oda için senkronizasyon interval'ini başlat
            // Gecikme süresinden sonra başlat
            setTimeout(() => {
                startRoomSyncInterval(roomId);
            }, startDelay);
            
            // Odalar değiştiğinde kaydet
            saveRoomsToFile();
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
            
            // Çalma listesi değiştiğinde odaları kaydet
            saveRoomsToFile();
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
            // Senkronizasyon interval'ini durdur
            stopRoomSyncInterval(roomId);
            
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
                        const songFileName = song.data.split('/').pop(); // /songs/filename.mp3 -> filename.mp3
                        
                        files.forEach(file => {
                            if (file === songFileName) {
                                fs.unlinkSync(path.join(songsDir, file));
                                deletedCount++;
                            }
                        });
                    });
                    
                    console.log(`Oda silindi: ${roomId}, ${deletedCount} şarkı dosyası temizlendi`);
                }
            } catch (err) {
                console.error('Oda şarkılarını silme hatası:', err);
            }
            
            // Odayı sil
            rooms.delete(roomId);
            
            // Odalar değiştiğinde kaydet
            saveRoomsToFile();
        }
    });

    // Yeni: Periyodik senkronizasyon için event handler ekle
    socket.on('requestSync', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room) {
            // Çalma süresi hesapla (son senkronizasyondan bu yana geçen süre)
            const elapsedTime = room.isPlaying ? (Date.now() - room.lastSyncTime) / 1000 : 0;
            const syncedTime = room.currentTime + elapsedTime;
            
            // Sadece istek yapan kullanıcıya senkronizasyon bilgisi gönder
            socket.emit('syncPlayback', {
                currentTime: syncedTime,
                serverTime: Date.now(),
                currentTrack: room.currentTrack,
                isPlaying: room.isPlaying
            });
            
            console.log(`Oda ${roomId} için senkronizasyon isteği yanıtlandı: ${syncedTime.toFixed(2)}s, şarkı: ${room.currentTrack}, çalıyor: ${room.isPlaying}`);
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
                    // Oda boşaldıysa senkronizasyon interval'ini durdur
                    stopRoomSyncInterval(roomId);
                    rooms.delete(roomId);
                }
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
                        lastSyncTime: Date.now()
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