
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const qrImage = require('qr-image');
const router  = new express.Router();

const {
  startClient, clientExists, sendMessage, reactToMessage, getStatus, validate, getContactInfo,
  getAllChats, getAllMessages, loginUser, logoutUser,
  getChats, getContacts, uploadMedia, getMessages, listUsers, getProfilePic
} = require("./WhatsappClient")

const BB_WIFI_REGEX = /;interface=wifi/gi;

function parseIntParam(raw, defaultVal) {
    const n = parseInt(String(raw).replace(BB_WIFI_REGEX, ""), 10);
    return isNaN(n) ? defaultVal : n;
}

router.get('/', (req, res) => {
    res.sendFile('/index.html', { root: __dirname });
});

// Versión actual del APK Android para OTA updates.
// Lee version.json del root del servidor. Si apk_url es relativa la convierte en absoluta.
router.get('/api/version', (req, res) => {
    try {
        const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8'));
        if (info.apk_url && !info.apk_url.startsWith('http')) {
            info.apk_url = req.protocol + '://' + req.get('host') + info.apk_url;
        }
        res.json(info);
    } catch (e) {
        res.status(404).json({ error: 'version.json not found' });
    }
});

// Descarga de archivos de la app (ej. APK). Restringido al directorio raíz del servidor.
router.get('/download/:filename', function(req, res) {
    const filename = path.basename(req.params.filename);
    const file     = path.resolve(__dirname, filename);

    if (!file.startsWith(__dirname + path.sep)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    res.download(file);
});

// Descarga de archivos multimedia recibidos. Restringido al directorio ./media/.
router.get('/api/mediafile/:filename', function(req, res) {
    const filename = path.basename(
        req.params.filename.replace(BB_WIFI_REGEX, "")
    );
    const file     = path.resolve(__dirname, 'media', filename);
    const mediaDir = path.resolve(__dirname, 'media') + path.sep;

    if (!file.startsWith(mediaDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    res.download(file);
});

router.get('/login', (req, res) => {
    res.sendFile('/login.html', { root: __dirname });
});

router.get("/login-status/:phoneNumber", (req, res) => {
    res.json(getStatus(req.params.phoneNumber))
});

// QR generado en el SERVIDOR (SVG) para la página de login.
// Evita depender de una librería QR en el cliente o de un CDN externo.
router.get('/qr/:phoneNumber', (req, res) => {
    const phone = String(req.params.phoneNumber).replace(BB_WIFI_REGEX, '');
    const status = getStatus(phone);
    if (!status || !status.qr) return res.status(404).send('no qr');
    try {
        const svg = qrImage.imageSync(status.qr, { type: 'svg', margin: 1 });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(svg);
    } catch (e) {
        console.error('qr svg error:', e);
        return res.status(500).send('qr error');
    }
});

router.get('/:country/:phoneNumber/start', (req, res) => {
    const result = validate(req.params.phoneNumber, req.params.country)
    if (!result.valid) return res.status(200).json(result);

    const formattedNumber = result.formatted.replace("+", "");
    console.log(`Starting client for ${formattedNumber}`)

    // Solo arrancar si no hay ya un cliente para este número
    if (!clientExists(formattedNumber)) {
        startClient(formattedNumber)
    }
    res.status(200).json({ valid: true, formatted: formattedNumber })
})

router.get('/api/login/:user', async (req, res) => {
    const result = await loginUser(req.params.user);
    res.status(result.status).json(result.data);
});

router.get('/api/logout/:user', async (req, res) => {
    const result = await logoutUser(req.params.user);
    res.status(result.status).json(result.data);
});

// Devuelve info del contacto: nombre, teléfono y estado/about
router.get('/api/contact/:user/:contactId', async (req, res) => {
    const result = await getContactInfo(req.params.user, req.params.contactId);
    res.status(result.status).json(result.status === 200 ? result.data : result.data);
});

// Foto de perfil cacheada (descarga, cachea en disco, y sirve)
router.get('/api/profilepic/:user/:contactId', async (req, res) => {
    const result = await getProfilePic(req.params.user, req.params.contactId);
    if (result.status !== 200) {
        return res.status(result.status).json({ error: 'Profile picture not available' });
    }
    res.setHeader('Content-Type', result.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h
    res.send(result.buffer);
});

// Arranca el cliente WA para un número ya registrado.
// No crea un cliente nuevo si ya existe uno (autenticado o inicializándose),
// para evitar que múltiples llamadas concurrentes destruyan el estado del cliente.
router.get('/api/startclient/:mobile', (req, res) => {
    const mobile = req.params.mobile
        .replace(BB_WIFI_REGEX, "")
        .replace(/\D/g, "");
    if (!mobile) return res.status(400).json({ error: 'Invalid mobile number' });

    const status = getStatus(mobile);
    if (status.isAuthenticated) {
        return res.status(200).json({ message: 'Already authenticated', mobile });
    }

    if (clientExists(mobile)) {
        return res.status(200).json({ message: 'Client already initializing', mobile });
    }

    startClient(mobile);
    res.status(200).json({ message: 'Client starting', mobile });
});

router.get('/api/chats/:receiver', async (req, res) => {
    const pageSize = parseIntParam(req.query.page_size, 30);
    const page     = parseIntParam(req.query.page, 0);
    const result   = await getChats(req.params.receiver, page, pageSize);
    res.status(result.status).json(result.data);
});

router.get('/api/contacts/:user', async (req, res) => {
    // La app carga TODOS los contactos guardados de una vez y filtra la búsqueda
    // en local, por lo que el endpoint devuelve la lista completa por defecto
    // (los contactos guardados son una lista acotada, ~300). Antes el default de 30
    // hacía que solo se vieran los primeros (hasta la "A").
    const pageSize    = parseIntParam(req.query.page_size, 100000);
    const page        = parseIntParam(req.query.page, 0);
    const searchTerm  = String(req.query.search_term ?? '').replace(BB_WIFI_REGEX, "");
    const result      = await getContacts(req.params.user, searchTerm, page, pageSize);
    res.status(result.status).json(result.data);
});

router.get('/api/messages/:receiver/:sender', async (req, res) => {
    const pageSize = parseIntParam(req.query.page_size, 30);
    const page     = parseIntParam(req.query.page, 0);
    const result   = await getMessages(req.params.receiver, req.params.sender, page, pageSize);
    res.status(result.status).json(result.data);
});

router.post(['/api/messages', '/api/messages/:id'], async (req, res) => {
    // quotedMessageId (opcional): wa_id del mensaje al que se responde (reply/cita).
    const result = await sendMessage(
        req.body.sender, req.body.receiver, req.body.message, req.body.quotedMessageId
    );
    res.status(result.status).json(result.data);
});

// Reacciona a un mensaje (emoji). Body: { sender, waId, emoji }. emoji '' quita la reacción.
router.post('/api/react', async (req, res) => {
    const sender = String(req.body.sender ?? '').replace(BB_WIFI_REGEX, "");
    const waId   = String(req.body.waId ?? '').replace(BB_WIFI_REGEX, "");
    const result = await reactToMessage(sender, waId, req.body.emoji ?? '');
    res.status(result.status).json(result.data);
});

router.get('/api/allchats/:user', async (req, res) => {
    const result = await getAllChats(req.params.user);
    res.status(result.status).json(result.data);
});

router.get('/api/allmessages/:user/:chatId', async (req, res) => {
    const result = await getAllMessages(req.params.user, req.params.chatId);
    res.status(result.status).json(result.data);
});

router.post(['/api/upload/:id', '/api/upload'], async (req, res) => {
    try {
        const { media } = req.files;
        if (!media) return res.status(404).json({ statusCode: '001', statusDesc: 'No media submitted' });

        const result = await uploadMedia(media, req.body.sender, req.body.receiver);
        res.status(result.status).json(result.data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ statusCode: '003', statusDesc: error.message });
    }
});

router.get('/listusers', async (req, res) => {
    const result = await listUsers();
    res.send(result);
});

// Reset unread count when user opens a chat
router.post('/api/mark-read/:user/:contactId', async (req, res) => {
    try {
        const userRaw   = req.params.user.replace(BB_WIFI_REGEX, "");
        const contactId = req.params.contactId.replace(BB_WIFI_REGEX, "");

        // La app ya envía el usuario como "<numero>@c.us". Antes el servidor le
        // volvía a añadir "@c.us" → "<numero>@c.us@c.us", que no coincidía con
        // ninguna fila y por eso la bolita de no-leídos NO se reseteaba al entrar.
        const receiver = userRaw.includes('@') ? userRaw : userRaw + '@c.us';

        const { db } = require('./connect');
        const result = await db().run(
            `UPDATE chats SET unread_count = 0 WHERE sender = ? AND receiver = ?`,
            [contactId, receiver]
        );
        console.log(`[mark-read] ${contactId} (receiver ${receiver}) → filas afectadas: ${result.changes}`);
        res.status(200).json({ status: 'ok', changed: result.changes });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router
