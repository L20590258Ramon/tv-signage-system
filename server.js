const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const PORT = 3000;
const DATA_FILE = 'playlist.json'; // Aquí guardamos la configuración

// --- USUARIOS Y CARPETAS ---
const USUARIOS = {
    "IT":      { pass: "IT_0Pm**",    folder: 'IT' },
    "PRODUCTION": { pass: "Prod_0Pm**",  folder: 'Production' },
    "RH":         { pass: "Rh2025**",    folder: 'RH' },
    "LOGISTIC":   { pass: "Logis_0Pm**", folder: 'Logistic' },
};

// --- LEER/GUARDAR CONFIGURACIÓN ---
// Estructura: { "Production": { activeImages: [], interval: 10000 }, "RH": ... }
let playlists = {};
if (fs.existsSync(DATA_FILE)) {
    playlists = JSON.parse(fs.readFileSync(DATA_FILE));
}

// --- MIDDLEWARES ---
app.use(express.json()); // Necesario para recibir JSON del admin
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const portero = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No auth' });
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (USUARIOS[auth[0]] && USUARIOS[auth[0]].pass === auth[1]) {
        req.userFolder = USUARIOS[auth[0]].folder;
        next(); 
    } else {
        return res.status(401).json({ error: 'Error credenciales' });
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const p = path.join('uploads', req.userFolder || 'General');
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
        cb(null, p);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// --- RUTAS ---

app.post('/api/login', portero, (req, res) => res.json({ status: 'ok', folder: req.userFolder }));

// 1. OBTENER TODO EL CONTENIDO (Para el Admin: Ver todo lo que existe)
app.get('/api/admin-content', portero, (req, res) => {
    const folder = req.userFolder;
    const dir = path.join(__dirname, 'uploads', folder);
    
    // Leemos archivos físicos
    let files = [];
    try {
        files = fs.readdirSync(dir).map(f => `/uploads/${folder}/${f}`);
    } catch(e) { files = []; }

    // Leemos la configuración actual de este usuario
    const config = playlists[folder] || { activeImages: [], interval: 10000 };

    res.json({
        allFiles: files,
        config: config
    });
});

// 2. GUARDAR CONFIGURACIÓN (El Admin decide qué se ve)
app.post('/api/save-config', portero, (req, res) => {
    const folder = req.userFolder;
    
    // Guardamos en memoria y disco
    playlists[folder] = {
        activeImages: req.body.activeImages, // Array de URLs seleccionadas
        interval: req.body.interval || 10000
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(playlists, null, 2));

    // Avisamos a la TV de este departamento
    io.emit('refresh_' + folder); 

    res.json({ status: 'ok' });
});

// 3. OBTENER CONTENIDO FILTRADO (Para la TV: Solo lo aprobado)
app.get('/api/tv-content', (req, res) => {
    const folder = req.query.folder || 'General';
    const dir = path.join(__dirname, 'uploads', folder);
    
    // 1. Obtener videos (La TV siempre ve TODOS los videos disponibles para tutoriales)
    let allVideos = [];
    try {
        allVideos = fs.readdirSync(dir)
            .filter(f => f.match(/\.(mp4|mov|webm)$/i))
            .map(f => `/uploads/${folder}/${f}`);
    } catch (e) {}

    // 2. Obtener imágenes (Solo las que el Admin activó en el JSON)
    const config = playlists[folder] || { activeImages: [], interval: 10000 };
    
    // Verificamos que los archivos sigan existiendo (limpieza)
    const validImages = config.activeImages.filter(url => {
        const localPath = path.join(__dirname, url);
        return fs.existsSync(localPath); 
    });

    res.json({
        images: validImages,      // SOLO las seleccionadas
        videos: allVideos,        // TODOS los videos (menú tutoriales)
        interval: config.interval // Tiempo del slide
    });
});

app.post('/upload', portero, upload.array('files'), (req, res) => {
    res.json({ status: 'ok' }); // Solo sube, no actualiza la TV automáticamente
});

io.on('connection', socket => console.log("TV Conectada"));
http.listen(PORT, () => console.log(`Server Optibelt v4 (Playlist Mode) en ${PORT}`));