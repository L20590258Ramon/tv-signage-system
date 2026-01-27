const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const PORT = 3000; 

// --- STATE MEMORY ---
// Saves what is playing where, so if a TV restarts, it knows what to show.
let estadoActual = {}; 

// --- 1. USER CONFIGURATION ---
// We changed this from a simple string to an Object to store permissions.
const USUARIOS = {
    "IT": { 
        pass: "IT_0Pm**", 
        allowed: ['all'] // Can control everything
    },
    "LOGISTIC": { 
        pass: "Logis_0Pm**", 
        allowed: ['Vulcas', 'CrossCutter'] // Only production areas
    },
    "PRODUCTION": { 
        pass: "Production_0Pm**", 
        allowed: ['Confection'] // Only production areas
    },
    
    "RH": { 
        pass: "Rh2025**", 
        allowed: ['Reception'] // Only office/soft areas
    },
};

const DIAS_PARA_BORRAR = 30; 

// --- MULTER CONFIG ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/') },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- CLEANUP FUNCTIONS ---
const borrarVersionesAnteriores = (archivoNuevo) => {
    const carpeta = 'uploads/';
    const nombreOriginal = archivoNuevo.originalname; 
    const nombreGuardado = archivoNuevo.filename;
    fs.readdir(carpeta, (err, files) => {
        if (err) return;
        files.forEach(file => {
            if (file.endsWith(nombreOriginal) && file !== nombreGuardado) {
                fs.unlink(path.join(carpeta, file), ()=>{});
            }
        });
    });
};

const limpiarArchivosMuyViejos = () => {
    const carpeta = 'uploads/';
    fs.readdir(carpeta, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const ruta = path.join(carpeta, file);
            fs.stat(ruta, (err, s) => {
                if (err) return;
                const dias = (new Date().getTime() - new Date(s.birthtime).getTime()) / (1000 * 3600 * 24);
                if (dias > DIAS_PARA_BORRAR) fs.unlink(ruta, ()=>{});
            });
        });
    });
};

// --- 2. SECURITY MIDDLEWARE (El Portero) ---
const portero = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No autorizado' });
    
    // Decode Basic Auth (User:Pass)
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const username = auth[0];
    const password = auth[1];

    // Check if user exists and password matches
    if (USUARIOS[username] && USUARIOS[username].pass === password) {
        // IMPORTANT: Attach the user info to the request for the next steps
        req.user = { 
            name: username, 
            permissions: USUARIOS[username].allowed 
        };
        next(); 
    } else {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
};

// --- EXPRESS CONFIG ---
app.use(express.static('public')); 
app.use('/uploads', express.static('uploads', { maxAge: '30d' })); 
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- ROUTES ---

// 3. LOGIN ROUTE (UPDATED)
// Now returns the list of allowed TVs to the frontend
app.post('/api/login', portero, (req, res) => {
    res.json({ 
        status: 'ok', 
        allowedTVs: req.user.permissions 
    });
});

app.get('/admin.html', portero, (req, res) => { res.sendFile(path.join(__dirname, 'public/admin.html')); });

// 4. PUBLISH ROUTE (UPDATED WITH SECURITY CHECK)
app.post('/publicar', portero, upload.array('archivos', 10), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) return res.status(400).json({error: 'Falta archivo'});
        
        const target = req.body.target || 'all';
        const userPerms = req.user.permissions;

        // --- SECURITY CHECKPOINT ---
        // If user is NOT Admin ('all') AND the target is NOT in their allowed list...
        const isAdmin = userPerms.includes('all');
        const canAccess = userPerms.includes(target);

        if (!isAdmin && !canAccess) {
            console.log(`⚠️ ALERTA DE SEGURIDAD: Usuario ${req.user.name} intentó publicar en ${target}`);
            return res.status(403).json({ error: '⛔ No tienes permiso para controlar esta pantalla.' });
        }
        // ---------------------------

        limpiarArchivosMuyViejos(); 
        req.files.forEach(file => borrarVersionesAnteriores(file));

        const autoPlay = req.body.isAuto === 'true'; 
        const durationSec = parseInt(req.body.duration) || 10;
        const primerArchivo = req.files[0];

        // Build Payload
        let payload = {
            target: target,
            options: { autoPlay, duration: durationSec }
        };

        if (primerArchivo.mimetype.includes('video')) {
            payload.type = 'video';
            payload.url = `/uploads/${primerArchivo.filename}`;
        } else {
            payload.type = 'gallery';
            payload.urls = req.files.map(f => `/uploads/${f.filename}`);
        }

        // 1. Save to Memory
        if (target === 'all') {
            estadoActual = { 'all': payload }; // Override everything if sending to ALL
        } else {
            estadoActual[target] = payload;
        }

        // 2. Emit to Screens
        // Using io.emit is fine because the filtering happens on the Client (TV) side
        // But for better performance, we can use Rooms. 
        // For now, keeping your logic is fine, but using Rooms is better:
        if(target === 'all') {
             io.emit('contentUpdate', payload);
        } else {
             // Sends only to sockets in that room
             io.to(target).emit('contentUpdate', payload); 
        }

        console.log(`✅ ${req.user.name} publicó contenido en: ${target}`);
        res.json({ status: 'ok' });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error interno' });
    }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => { 
    socket.on('join', (room) => {
        socket.join(room); // The TV joins a specific room (e.g., 'Reception')
        console.log(`Pantalla conectada a zona: ${room}`);

        // RECOVERY LOGIC
        // Priority 1: Specific content for this room
        if (estadoActual[room]) {
            socket.emit('contentUpdate', estadoActual[room]);
        } 
        // Priority 2: Global content
        else if (estadoActual['all']) {
            socket.emit('contentUpdate', estadoActual['all']);
        }
    });
});

http.listen(PORT, () => console.log(`Sistema Optibelt v2.0.4 listo en puerto ${PORT}`));