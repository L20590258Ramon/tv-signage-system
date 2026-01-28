const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DATA_FILE = 'playlist.json';

const USUARIOS = {
    "IT":         { pass: "IT_0Pm**",    folder: 'It' },
    "PRODUCTION": { pass: "Prod_0Pm**",  folder: 'Production' },
    "RH":         { pass: "Rh2025**",    folder: 'Rh' },
    "LOGISTIC":   { pass: "Logis_0Pm**", folder: 'Logistic' },
};

let playlists = {};
if (fs.existsSync(DATA_FILE)) {
    try { playlists = JSON.parse(fs.readFileSync(DATA_FILE)); } catch(e){}
}

app.use(express.json());
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
    } else { return res.status(401).json({ error: 'Error' }); }
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

app.get('/api/admin-content', portero, (req, res) => {
    const folder = req.userFolder;
    const dir = path.join(__dirname, 'uploads', folder);
    
    let files = [];
    try {
        files = fs.readdirSync(dir).map(f => `/uploads/${folder}/${f}`);
    } catch(e) { files = []; }

    // AQUI ESTABA EL ERROR: Necesitamos leer activeVideos tambien
    const config = playlists[folder] || { activeImages: [], activeVideos: [], interval: 10000, isAuto: false };

    res.json({ allFiles: files, config: config });
});

app.post('/api/save-config', portero, (req, res) => {
    const folder = req.userFolder;
    
    // AQUI GUARDAMOS LA LISTA DE VIDEOS SELECCIONADOS
    playlists[folder] = {
        activeImages: req.body.activeImages, 
        activeVideos: req.body.activeVideos, // <--- ESTO FALTABA
        interval: req.body.interval || 10000,
        isAuto: req.body.isAuto 
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(playlists, null, 2));

    io.emit('refresh_' + folder); 
    res.json({ status: 'ok' });
});

app.get('/api/tv-content', (req, res) => {
    const folder = req.query.folder || 'General';
    const config = playlists[folder] || { activeImages: [], activeVideos: [], interval: 10000, isAuto: false };
    
    // FILTRADO DE SEGURIDAD:
    // Solo enviamos los videos que estan en la lista 'activeVideos'
    const validVideos = (config.activeVideos || []).filter(url => {
        const localPath = path.join(__dirname, url);
        return fs.existsSync(localPath);
    });

    res.json({
        images: config.activeImages,
        videos: validVideos, // <--- ENVIAMOS SOLO LOS APROBADOS
        interval: config.interval,
        isAuto: config.isAuto 
    });
});

app.post('/upload', portero, upload.array('files'), (req, res) => res.json({ status: 'ok' }));

io.on('connection', socket => console.log("TV Conectada"));
http.listen(PORT, () => console.log(`Server listo en puerto ${PORT}`));