const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const PORT = 3000; 

// USER CONFIGURATION (RBAC) - Kept same as before
const USUARIOS = {
    "ADMIN": { pass: "IT_0Pm**", allowed: ['all'] },
    "LOGISTIC": { pass: "Logis_0Pm**", allowed: ['Vulcas', 'CrossCutter', 'ProductionFloor'] },
    "RH": { pass: "Rh2025**", allowed: ['Reception', 'Confections'] },
};

// --- MULTER CONFIG ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/') },
    filename: function (req, file, cb) {
        // We keep unique names so we don't overwrite old videos
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- SECURITY MIDDLEWARE ---
const portero = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No autorizado' });
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (USUARIOS[auth[0]] && USUARIOS[auth[0]].pass === auth[1]) {
        req.user = { name: auth[0], permissions: USUARIOS[auth[0]].allowed };
        next(); 
    } else {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
};

// --- EXPRESS CONFIG ---
app.use(express.static('public')); 
// Removed "maxAge" to ensure fresh content loading, but kept static access
app.use('/uploads', express.static('uploads')); 
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- ROUTES ---

app.post('/api/login', portero, (req, res) => {
    res.json({ status: 'ok', allowedTVs: req.user.permissions });
});

app.get('/admin.html', portero, (req, res) => { res.sendFile(path.join(__dirname, 'public/admin.html')); });

// --- NEW ROUTE: GET LIBRARY CONTENT ---
// This allows the TV to ask: "What files exist on the server?"
app.get('/api/library', (req, res) => {
    const directoryPath = path.join(__dirname, 'uploads');
    
    fs.readdir(directoryPath, (err, files) => {
        if (err) {
            return res.status(500).send({ message: "Unable to scan files!" });
        }
        
        // Categorize files
        let library = {
            images: [],
            videos: []
        };

        files.forEach((file) => {
            const ext = path.extname(file).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
                library.images.push('/uploads/' + file);
            } else if (['.mp4', '.webm', '.mov'].includes(ext)) {
                library.videos.push('/uploads/' + file);
            }
        });

        res.json(library);
    });
});

// --- UPLOAD ROUTE (No Deletion Logic) ---
app.post('/publicar', portero, upload.array('archivos', 10), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({error: 'Falta archivo'});
        
        // NOTE: I REMOVED the cleanup functions here. 
        // Files are now kept forever unless manually deleted from the folder.

        // We still notify via Socket in case an Admin wants to force-show something immediately
        const target = req.body.target || 'all';
        const autoPlay = req.body.isAuto === 'true'; 
        const durationSec = parseInt(req.body.duration) || 10;
        
        let payload = {
            target: target,
            options: { autoPlay, duration: durationSec }
        };

        const primerArchivo = req.files[0];
        if (primerArchivo.mimetype.includes('video')) {
            payload.type = 'video';
            payload.url = `/uploads/${primerArchivo.filename}`;
        } else {
            payload.type = 'gallery';
            payload.urls = req.files.map(f => `/uploads/${f.filename}`);
        }

        if(target === 'all') io.emit('contentUpdate', payload);
        else io.to(target).emit('contentUpdate', payload); 

        res.json({ status: 'ok' });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error interno' });
    }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => { 
    socket.on('join', (room) => {
        socket.join(room);
        console.log(`Pantalla conectada a zona: ${room}`);
    });
});

http.listen(PORT, () => console.log(`Sistema Optibelt (Storage Mode) listo en puerto ${PORT}`));