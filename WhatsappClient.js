const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js")
const qrcode = require("qrcode-terminal")
const qrimage = require("qr-image");

const fs = require("fs");
const path = require("path");
const { PhoneNumberUtil, PhoneNumberFormat } = require("google-libphonenumber");
const phoneUtil = PhoneNumberUtil.getInstance();
const ffmpeg = require("fluent-ffmpeg");
const { db: getDb } = require("./connect.js");

const clients = {}
const authenticatedClients = {}
const qrcodes = {}

const MEDIA_DIR     = path.resolve(__dirname, 'media');
const PICS_CACHE_DIR = path.resolve(__dirname, 'cache', 'pics');
const PICS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 horas

try { fs.mkdirSync(PICS_CACHE_DIR, { recursive: true }); } catch (_) {}

// Normaliza una dirección WA sin mutilar el sufijo de servidor.
// Soporta @c.us (teléfono), @lid (multi-device), @g.us (grupo).
function normalizeAddr(addr) {
    addr = String(addr).replace(/;interface=wifi/gi, "").trim();
    if (addr.includes('@')) return addr;   // ya tiene sufijo → no tocar
    return addr + '@c.us';                 // número sin sufijo → añadir @c.us
}

// Zona horaria de visualización. El cliente (BlackBerry Q20) tiene una base de
// datos de zonas horarias obsoleta y aplica mal el horario de verano (muestra la
// hora 1h atrasada). Por eso el SERVIDOR es la fuente de la hora: formatea los
// timestamps en esta zona y la app los muestra tal cual, sin reconvertir.
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'Europe/Madrid';

// Devuelve 'YYYY-MM-DD HH:MM:SS' en DISPLAY_TZ. Usa Intl (ICU incluido en Node 20),
// así no depende de tzdata del sistema operativo.
function fmtTs(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: DISPLAY_TZ, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date);
    const v = t => parts.find(p => p.type === t).value;
    // 'en-CA' da hora 24h; algunos ICU devuelven '24' a medianoche → normalizar.
    const hh = v('hour') === '24' ? '00' : v('hour');
    return `${v('year')}-${v('month')}-${v('day')} ${hh}:${v('minute')}:${v('second')}`;
}

function ffmpegPromise(inputPath, outputPath, options = []) {
    return new Promise((resolve, reject) => {
        let cmd = ffmpeg().input(inputPath);
        if (options.length) cmd = cmd.outputOptions(options);
        cmd.output(outputPath)
            .on("end", resolve)
            .on("error", reject)
            .run();
    });
}

// Descarga el multimedia de un mensaje, lo guarda en ./media/ (convirtiendo
// audio→mp3 y vídeo→3gp para compatibilidad con BB10) y enlaza el archivo en
// la fila de messages vía media_filename. Decide el tipo por el MIME real del
// archivo, no por message.type, para soportar también audios/imágenes enviados
// desde la app (que WhatsApp puede reportar como 'document').
// Usado tanto por el evento 'message' (recibidos) como por 'message_create' (enviados).
async function persistMedia(message, newId) {
    try {
        const media = await message.downloadMedia();
        if (!media || !media.mimetype) {
            console.log(`[persistMedia ${newId}] sin media descargable`);
            return;
        }

        const mime = media.mimetype;
        let mediaFilename = null;

        // Stickers (webp, a veces animados): convertir a PNG para preservar la
        // transparencia y garantizar el render en el runtime viejo de BB10. De los
        // animados se queda el primer fotograma (-frames:v 1). Fallback al webp.
        if (message.type === 'sticker') {
            const srcPath = path.join(MEDIA_DIR, newId + '.webp');
            const pngPath = path.join(MEDIA_DIR, newId + '.png');
            fs.writeFileSync(srcPath, Buffer.from(media.data, 'base64'));
            try {
                await ffmpegPromise(srcPath, pngPath, ['-frames:v 1', '-update 1']);
                fs.unlinkSync(srcPath);
                mediaFilename = newId + '.png';
                console.log(`[persistMedia ${newId}] sticker convertido a png`);
            } catch (e) {
                mediaFilename = newId + '.webp';
                console.log(`[persistMedia ${newId}] sticker→png falló, usando webp: ${e.message}`);
            }
        }

        else if (mime.startsWith('image/')) {
            const ext = mime === 'image/webp' ? '.webp' : '.jpg';
            mediaFilename = newId + ext;
            fs.writeFileSync(path.join(MEDIA_DIR, mediaFilename), Buffer.from(media.data, 'base64'));
        }

        else if (mime.startsWith('audio/')) {
            const srcPath  = path.join(MEDIA_DIR, newId + '.ogg');
            const destPath = path.join(MEDIA_DIR, newId + '.mp3');
            fs.writeFileSync(srcPath, Buffer.from(media.data, 'base64'));
            await ffmpegPromise(srcPath, destPath, ['-codec:a libmp3lame']);
            fs.unlinkSync(srcPath);
            mediaFilename = newId + '.mp3';
            console.log(`[persistMedia ${newId}] audio convertido a mp3`);
        }

        else if (mime.startsWith('video/')) {
            const srcPath  = path.join(MEDIA_DIR, newId + '.mp4');
            const destPath = path.join(MEDIA_DIR, newId + '.3gp');
            fs.writeFileSync(srcPath, Buffer.from(media.data, 'base64'));
            await ffmpegPromise(srcPath, destPath, [
                '-s 352x288', '-acodec aac', '-strict experimental',
                '-ac 1', '-ar 8000', '-ab 24k'
            ]);
            mediaFilename = newId + '.3gp';
            console.log(`[persistMedia ${newId}] vídeo convertido a 3gp`);
        }

        if (mediaFilename) {
            await getDb().run(
                `UPDATE messages SET media_filename = ? WHERE _id = ?`,
                [mediaFilename, newId]
            );
            console.log(`[persistMedia ${newId}] guardado: ${mediaFilename}`);
        }
    } catch (err) {
        console.error(`[persistMedia ${newId}] error:`, err.message);
    }
}

// Extrae la info de cita (reply) de un mensaje, si responde a otro.
// Devuelve { quotedMessage, quotedAuthor } o { null, null }.
// quotedMessage es una vista previa de texto; para media se usa un marcador.
async function extractQuoted(message, client) {
    try {
        if (!message.hasQuotedMsg) return { quotedMessage: null, quotedAuthor: null };
        const quoted = await message.getQuotedMessage();
        if (!quoted) return { quotedMessage: null, quotedAuthor: null };

        let preview;
        if (quoted.type === 'chat') preview = (quoted.body || '').substring(0, 120);
        else                        preview = `[${quoted.type}]`;

        let author;
        if (quoted.fromMe) author = client?.info?.pushname || 'Me';
        else               author = quoted._data?.notifyName || '';

        return { quotedMessage: preview, quotedAuthor: author };
    } catch (_) {
        return { quotedMessage: null, quotedAuthor: null };
    }
}

function startClient(id) {
    if (clients[id]) {
        console.log(`[${id}] client already exists, skipping duplicate start`);
        return;
    }

    // Eliminar SingletonLock obsoleto si existe...

    clients[id].initialize().catch(err => console.error(`[${id}] init error:`, err))

    clients[id].on("qr", (qr) => {
        console.log("QR code generated");
        qrcodes[id] = qr;
    })

    clients[id].on("ready", () => {
        authenticatedClients[id] = id;
        console.log("Client is ready!")
        syncHistory(id).catch(err => console.error(`[${id}] syncHistory error:`, err));
    })

    // Captura mensajes enviados desde OTROS dispositivos vinculados (móvil, web, PC).
    clients[id].on('message_create', async message => {
        if (!message.fromMe) return; // los recibidos los gestiona el evento 'message'
        if (!clients[id]?.info) return;

        const waId = message.id?._serialized;

        // Deduplicar: saltar si ya fue guardado por sendMessage() o por sincronización anterior
        if (waId) {
            const exists = await getDb().get('SELECT _id FROM messages WHERE wa_id = ?', [waId]);
            if (exists) return;
        }

        const myAddr  = clients[id].info.wid.user + '@c.us';
        const toAddr  = normalizeAddr(message.to || '');
        if (!toAddr || toAddr === myAddr && !message.to) return; // ignorar mensajes malformados

        const msgText = message.type === 'chat' ? (message.body || '') : `${message.type} sent`;
        const pushname = clients[id].info.pushname || 'Me';

        try {
            const contactName = await resolveContactName(clients[id], toAddr);
            const chatType    = message.type || 'chat';
            const { quotedMessage, quotedAuthor } = await extractQuoted(message, clients[id]);

            // unread_count=0 y last_from_me=1: lo que YO envío no es no leído ni se notifica.
            const ts = fmtTs();
            await getDb().run('DELETE FROM chats WHERE sender = ?', [toAddr]);
            await getDb().run(
                `INSERT INTO chats(sender, receiver, message, status, sender_name, chat_type, device_type, unread_count, last_from_me, timestamp)
                 VALUES(?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
                [toAddr, myAddr, msgText, 0, contactName, chatType, message.deviceType || 'unknown', ts]
            );
            const result = await getDb().run(
                `INSERT INTO messages(sender, receiver, message, status, sender_name, chat_type, device_type, wa_id, quoted_message, quoted_author, timestamp)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [myAddr, toAddr, msgText, 0, pushname, chatType, message.deviceType || 'unknown', waId || null, quotedMessage, quotedAuthor, ts]
            );
            const newId = result.lastID;

            // Descargar y enlazar multimedia (imágenes enviadas desde la app, móvil, etc.)
            if (message.hasMedia) {
                await persistMedia(message, newId);
            }

            console.log(`[message_create] guardado: ${pushname} → ${toAddr}: ${msgText.substring(0, 40)}`);
        } catch (err) {
            console.error('[message_create] error:', err.message);
        }
    })

    clients[id].on('disconnected', async (reason) => {
        console.log(`Client disconnected (${reason}), restarting...`);
        delete authenticatedClients[id];
        try {
            await clients[id].destroy();
            await clients[id].initialize();
        } catch (err) {
            console.error(`[${id}] restart error:`, err);
        }
    });

    clients[id].on('change_state', (state) => {
        console.log('Connection state changed:', state);
    });

    clients[id].on('message', async message => {
      try {
        console.log(`Message from: ${message.from}`);

        // getChat() puede lanzar en la build actual de WA Web (fetchBizProfile →
        // "reading 'id'"). Solo se usa para el nombre de grupo, así que toleramos
        // el fallo en vez de dejar que un rechazo no capturado tumbe el proceso.
        let waChat = null;
        try { waChat = await message.getChat(); } catch (e) { console.error('[message] getChat:', e.message); }

        let msg;
        if (message.type == 'ptt')        msg = 'Voice received';
        else if (message.type == 'image') msg = 'Image received';
        else if (message.type == 'audio') msg = 'Audio received';
        else if (message.type == 'video') msg = 'Video received';
        else if (message.type == 'chat')  msg = message.body;
        else                              msg = `${message.type} received`;

        console.log(`Message: ${msg}`);

        if (message.from === 'status@broadcast') return;

        const waId = message.id?._serialized;

        // Deduplicate: skip if already in DB (from uploadMedia or previous sync)
        if (waId) {
            const exists = await getDb().get('SELECT _id FROM messages WHERE wa_id = ?', [waId]);
            if (exists) {
                console.log(`[message] Skipping duplicate wa_id: ${waId}`);
                return;
            }
        }

        let senderNameForChat     = message._data.notifyName;
        let senderNameForMessages = message._data.notifyName;

        if (waChat?.isGroup)         senderNameForChat     = waChat.name;
        if (!senderNameForMessages)  senderNameForMessages = message.from;
        if (!senderNameForChat)      senderNameForChat     = message.from;

        // Update or insert chat; increment unread_count for new messages
        const existingChat = await getDb().get('SELECT unread_count FROM chats WHERE sender = ?', [message.from]);
        const newUnreadCount = (existingChat?.unread_count || 0) + 1;

        await getDb().run(
            `DELETE FROM chats WHERE sender = ?`,
            [message.from]
        );

        const { quotedMessage, quotedAuthor } = await extractQuoted(message, clients[id]);

        const ts = fmtTs();
        await getDb().run(
            `INSERT INTO chats(sender, receiver, message, status, sender_name, chat_type, device_type, unread_count, last_from_me, timestamp)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            [message.from, message.to, msg, 0, senderNameForChat, message.type, message.deviceType, newUnreadCount, ts]
        );

        const result = await getDb().run(
            `INSERT INTO messages(sender, receiver, message, status, sender_name, chat_type, device_type, wa_id, quoted_message, quoted_author, timestamp)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [message.from, message.to, msg, 0, senderNameForMessages, message.type, message.deviceType, waId, quotedMessage, quotedAuthor, ts]
        );

        const newId = result.lastID;

        if (message.hasMedia) {
            await persistMedia(message, newId);
        }
      } catch (err) {
        console.error('[message] error:', err.message);
      }
    });

    // Reacciones (emoji) sobre un mensaje. reaction.reaction == '' significa que
    // se quitó la reacción. Se identifica el mensaje por su wa_id (msgId serializado).
    // Las reacciones NO cambian el timestamp del mensaje, así que la app detecta el
    // cambio comparando una firma de reacciones (ver retrieveAndDisplayMessages).
    clients[id].on('message_reaction', async (reaction) => {
        try {
            const targetWaId = reaction.msgId?._serialized;
            if (!targetWaId) return;
            const emoji = reaction.reaction || '';
            const result = await getDb().run(
                `UPDATE messages SET reaction = ? WHERE wa_id = ?`,
                [emoji, targetWaId]
            );
            console.log(`[message_reaction] ${targetWaId} → "${emoji}" (filas: ${result.changes})`);
        } catch (err) {
            console.error('[message_reaction] error:', err.message);
        }
    });
}


function getStatus(clientId) {
    if (authenticatedClients[clientId] == undefined) {
        return { isAuthenticated: false, qr: qrcodes[clientId], pushname: null, user: null, platform: null }
    }
    return {
        isAuthenticated: true,
        qr:       qrcodes[clientId],
        pushname: clients[clientId]?.info?.pushname  ?? "",
        user:     clients[clientId]?.info?.wid?.user ?? "",
        platform: clients[clientId]?.info?.platform  ?? ""
    }
}

function validate(input, countryCode) {
    try {
        if (countryCode == "0")
            return { valid: false, reason: "Country code is required" }

        const number = phoneUtil.parse(input, countryCode);
        return {
            valid:     phoneUtil.isValidNumber(number),
            formatted: phoneUtil.format(number, PhoneNumberFormat.E164),
            type:      phoneUtil.getNumberType(number),
            country:   phoneUtil.getRegionCodeForNumber(number),
        };
    } catch (e) {
        return { valid: false, reason: e.message };
    }
}

async function loginUser(mobileNumber) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");

        console.log(`login user = ${mobileNumber}`);

        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client?.info?.wid?.user)
            return { status: 401, data: { error: "User session not found" } };

        return {
            status: 200,
            data: {
                pushname: client.info.pushname,
                user:     client.info.wid.user,
                platform: client.info.platform
            }
        };
    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function logoutUser(mobileNumber) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");
        const id = mobileNumber.replace("@c.us", "");

        if (clients[id]) {
            await clients[id].destroy();
            delete clients[id];
        }
        delete authenticatedClients[id];
        delete qrcodes[id];

        return { status: 200, data: { message: 'Logged out successfully' } };
    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

function parsePagination(pageRaw, pageSizeRaw) {
    const page     = Math.max(0, parseInt(pageRaw, 10)     || 0);
    const pageSize = Math.max(1, parseInt(pageSizeRaw, 10) || 30);
    return { page, pageSize };
}

async function getChats(receiver, pageRaw, pageSizeRaw) {
    try {
        const regex = /;interface=wifi/gi;
        receiver = receiver.replace(regex, "");

        const client = clients[receiver.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);

        const rows = await getDb().all(
            `SELECT * FROM chats WHERE receiver = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
            [receiver, pageSize, page * pageSize]
        );

        const chats = rows.map(row => ({
            _id:         row._id,
            sender:      row.sender,
            senderName:  row.sender_name,
            message:     row.message,
            status:      row.status,
            unreadCount: row.unread_count || 0,
            lastFromMe:  row.last_from_me || 0,
            createdAt:   row.timestamp,
            updatedAt:   row.timestamp
        }));

        return { status: 200, data: { chats } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function getAllChats(mobileNumber) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");

        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const chats = await client.getChats();
        return { status: 200, data: { chats } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function getAllMessages(mobileNumber, chatId) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");

        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const chat = await client.getChatById(chatId);
        if (!chat)
            return { status: 404, data: { error: "Chat not found" } };

        const messages = await chat.fetchMessages({ limit: 50 });
        return { status: 200, data: { messages } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function getMessages(receiver, sender, pageRaw, pageSizeRaw) {
    try {
        const regex = /;interface=wifi/gi;
        sender   = sender.replace(regex, "");
        receiver = receiver.replace(regex, "");

        const client = clients[receiver.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);

        const rows = await getDb().all(
            `SELECT * FROM messages
             WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`,
            [receiver, sender, sender, receiver, pageSize, page * pageSize]
        );

        const messages = rows.map(row => ({
            _id:           row._id,
            sender:        row.sender,
            receiver:      row.receiver,
            message:       row.message,
            status:        row.status,
            senderName:    row.sender_name,
            chatType:      row.chat_type,
            deviceType:    row.device_type,
            mediaFilename: row.media_filename,
            waId:          row.wa_id,
            reaction:      row.reaction || '',
            quotedMessage: row.quoted_message || '',
            quotedAuthor:  row.quoted_author || '',
            createdAt:     row.timestamp,
            updatedAt:     row.timestamp
        }));

        return { status: 200, data: { messages } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function getContacts(mobileNumber, searchTerm, pageRaw, pageSizeRaw) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");

        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: "User session not found" } };

        const contacts = await client.getContacts();

        // Solo contactos GUARDADOS en la agenda del usuario (isMyContact).
        // isWAContact incluía a CUALQUIER usuario de WhatsApp con quien se ha tenido
        // contacto (miembros de grupos, gente que escribió, etc.) → 3500+ números random.
        // Excluimos también nuestra propia cuenta y grupos, y usamos la identidad @c.us.
        const filtered = contacts
            .filter(c => c.isMyContact && !c.isMe && !c.isGroup && c.id.server === "c.us")
            .map(c => ({ id: c.id._serialized, name: c.name ?? c.pushname ?? c.id.user }))
            .filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
            .sort((a, b) => a.name.localeCompare(b.name));

        const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
        const start = page * pageSize;

        return {
            status: 200,
            data: { contacts: filtered.slice(start, start + pageSize), count: filtered.length }
        };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { error: error.message } };
    }
}

async function uploadMedia(media, sender, receiver) {
    // uploadMedia SOLO envía el archivo a WhatsApp. NO inserta en la BD:
    // el evento 'message_create' (disparado por este mismo envío) se encarga de
    // insertar la fila y descargar/guardar la copia permanente vía persistMedia.
    // Este es el mismo patrón que sendMessage() para texto y evita duplicados.
    let srcPath = null, targetPath = null;
    try {
        const client = clients[sender.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { statusCode: '002', statusDesc: 'User session not found' } };

        let fileExt, fileExtTarget, chatType;

        if (media.mimetype === 'audio/mpeg') {
            fileExt = '.mp3'; fileExtTarget = '.ogg'; chatType = 'audio';
        } else if (media.mimetype === 'video/mp4') {
            fileExt = '.mp4'; fileExtTarget = '.mp4'; chatType = 'video';
        } else if (media.mimetype === 'image/jpeg') {
            fileExt = '.jpg'; fileExtTarget = '.jpg'; chatType = 'image';
        } else {
            return { status: 400, data: { statusCode: '004', statusDesc: 'Unsupported media type' } };
        }

        // Archivos temporales (prefijo upload_) — se borran tras enviar.
        const tmpId = 'upload_' + Date.now();
        srcPath    = path.join(MEDIA_DIR, tmpId + fileExt);
        targetPath = path.join(MEDIA_DIR, tmpId + fileExtTarget);

        fs.writeFileSync(srcPath, Buffer.from(media.data, 'binary'));

        if (media.mimetype === 'audio/mpeg') {
            await ffmpegPromise(srcPath, targetPath, ['-c:a libopus', '-b:a 128k']);
            console.log("Audio upload conversion finished");
        }

        const mediaObject = MessageMedia.fromFilePath(targetPath);
        const sendAsVoice = (chatType === 'audio') ? { sendAudioAsVoice: true } : {};
        const sentMsg = await client.sendMessage(receiver, mediaObject, sendAsVoice);
        const waId = sentMsg?.id?._serialized || null;

        console.log(`[uploadMedia] enviado ${chatType} a ${receiver}, wa_id: ${waId} (persistencia vía message_create)`);

        return { status: 200, data: { statusCode: '000', statusDesc: 'media uploaded successfully', wa_id: waId } };

    } catch (error) {
        console.error(error);
        return { status: 500, data: { statusCode: '003', statusDesc: error.message } };
    } finally {
        // Limpieza de temporales; message_create guarda la copia definitiva.
        try { if (srcPath)    fs.unlinkSync(srcPath); }    catch (_) {}
        try { if (targetPath) fs.unlinkSync(targetPath); } catch (_) {}
    }
}

// Resuelve el nombre de un contacto a partir de su dirección WA.
// Intenta primero la API de WA; si falla, busca en la BD un mensaje previo del contacto.
async function resolveContactName(client, addr) {
    try {
        const contact = await client.getContactById(addr);
        const name = contact.name || contact.pushname;
        if (name) return name;
    } catch (_) {}

    // Fallback: nombre guardado en mensajes previos recibidos de este contacto
    try {
        const row = await getDb().get(
            `SELECT sender_name FROM messages WHERE sender = ? AND sender_name IS NOT NULL LIMIT 1`,
            [addr]
        );
        if (row?.sender_name) return row.sender_name;
    } catch (_) {}

    return addr; // último recurso: el número en bruto
}

// Obtiene la URL de la foto de perfil sin usar client.getProfilePicUrl(),
// que está roto en esta build de WhatsApp Web (lanza "Cannot read ... 'isNewsletter'"
// dentro de requestProfilePicFromServer). El camino que SÍ funciona es
// window.Store.ProfilePicThumb.find(wid), que devuelve un modelo con .eurl.
// Probamos también con el id resuelto @lid → @c.us (que da el número real).
async function fetchProfilePicUrlSafe(client, contactId) {
    const candidates = [];

    if (contactId.includes('@lid')) {
        // El número real se resuelve vía getContactById(lid).number (verificado).
        try {
            const contact = await client.getContactById(contactId);
            if (contact?.number) candidates.push(contact.number + '@c.us');
        } catch (_) {}
    }
    candidates.push(contactId); // siempre probar también el id original

    for (const cid of candidates) {
        try {
            const eurl = await client.pupPage.evaluate(async (id) => {
                try {
                    const wid = window.Store.WidFactory.createWid(id);
                    // window.Store.ProfilePicThumb.find(wid) es el camino que SÍ funciona
                    // en esta build de WhatsApp Web (getProfilePicUrl/requestProfilePicFromServer
                    // lanzan "isNewsletter" sobre undefined). Devuelve un modelo con .eurl.
                    const thumb = await window.Store.ProfilePicThumb.find(wid);
                    return thumb && thumb.eurl ? thumb.eurl : null;
                } catch (e) {
                    return null;
                }
            }, cid);

            if (eurl) {
                console.log(`[profilepic] URL obtenida vía ${cid}`);
                return eurl;
            }
            console.log(`[profilepic] sin URL para candidato ${cid}`);
        } catch (e) {
            console.log(`[profilepic] evaluate falló para ${cid}: ${e.message}`);
        }
    }
    return null;
}

async function getProfilePic(mobileNumber, contactId) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");
        const userId = mobileNumber.replace("@c.us", "");

        console.log(`[profilepic] STEP 1: buscando cliente para usuario: ${userId}`);
        const client = clients[userId];
        if (!client) {
            console.log(`[profilepic] STEP 1 FAIL: cliente no encontrado para: ${userId}`);
            return { status: 401 };
        }
        console.log(`[profilepic] STEP 1 OK: cliente encontrado`);

        const cacheKey  = contactId.replace(/[^a-zA-Z0-9]/g, '_') + '.jpg';
        const cachePath = path.join(PICS_CACHE_DIR, cacheKey);

        // Cache check
        console.log(`[profilepic] STEP 2: checando caché: ${cacheKey}`);
        try {
            const stat = fs.statSync(cachePath);
            if (Date.now() - stat.mtimeMs < PICS_CACHE_TTL) {
                console.log(`[profilepic] STEP 2 OK: foto en caché (${(stat.size/1024).toFixed(1)}KB)`);
                return { status: 200, buffer: fs.readFileSync(cachePath), contentType: 'image/jpeg' };
            }
            console.log(`[profilepic] STEP 2: caché expirado`);
        } catch (e) {
            console.log(`[profilepic] STEP 2: caché miss (${e.message})`);
        }

        // Obtener URL de foto (workaround del bug isNewsletter de getProfilePicUrl)
        console.log(`[profilepic] STEP 3: resolviendo URL para ${contactId}`);
        const url = await fetchProfilePicUrlSafe(client, contactId);

        if (!url) {
            console.log(`[profilepic] FAIL: No URL disponible para ${contactId} (privacidad, sin foto, o build de WA incompatible)`);
            return { status: 404 };
        }

        // Descargar y cachear
        console.log(`[profilepic] STEP 5: descargando imagen...`);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.error(`[profilepic] STEP 5 ERROR: HTTP ${response.status}`);
                return { status: 404 };
            }

            const buffer      = Buffer.from(await response.arrayBuffer());
            const contentType = response.headers.get('content-type') || 'image/jpeg';

            console.log(`[profilepic] STEP 5 OK: imagen descargada (${(buffer.length/1024).toFixed(1)}KB)`);

            try {
                fs.writeFileSync(cachePath, buffer);
                console.log(`[profilepic] OK FINAL: foto cacheada para ${contactId}`);
            } catch (e) {
                console.error(`[profilepic] ERROR guardando caché: ${e.message}`);
            }

            return { status: 200, buffer, contentType };
        } catch (err) {
            console.error(`[profilepic] STEP 5 ERROR descargando: ${err.message}`);
            return { status: 404 };
        }

    } catch (error) {
        console.error(`[profilepic] ERROR CRÍTICO:`, error.name, error.message);
        console.error(error.stack);
        return { status: 404 };
    }
}

// Sincroniza el historial de mensajes de WhatsApp a la BD local al arrancar el cliente.
// Usa wa_id para deduplicar y evitar duplicados en reinicios.
async function syncHistory(id) {
    const client = clients[id];
    if (!client?.info) return;

    const myAddr = client.info.wid.user + '@c.us';
    console.log(`[${id}] Iniciando sync de historial...`);

    try {
        const waChats = await client.getChats();

        for (const waChat of waChats.slice(0, 30)) {
            try {
                const contactAddr = waChat.id._serialized;
                const contactName = waChat.name || contactAddr;
                const messages = await waChat.fetchMessages({ limit: 50 });

                let lastMsg = null;

                for (const msg of messages) {
                    if (msg.from === 'status@broadcast') continue;

                    const waId = msg.id?._serialized;
                    if (!waId) continue;

                    // Saltar si ya está en BD
                    const exists = await getDb().get(
                        `SELECT _id FROM messages WHERE wa_id = ?`, [waId]
                    );
                    if (exists) { lastMsg = msg; continue; }

                    const sender     = msg.fromMe ? myAddr : normalizeAddr(msg.from);
                    const receiver   = msg.fromMe ? normalizeAddr(msg.to) : myAddr;
                    const senderName = msg.fromMe
                        ? (client.info.pushname || 'Me')
                        : (msg._data?.notifyName || contactName);
                    const msgText    = msg.type === 'chat' ? (msg.body || '') : `${msg.type} received`;
                    const timestamp  = fmtTs(new Date(msg.timestamp * 1000));
                    const { quotedMessage, quotedAuthor } = await extractQuoted(msg, client);

                    await getDb().run(
                        `INSERT INTO messages
                         (sender, receiver, message, status, sender_name, chat_type, device_type, wa_id, quoted_message, quoted_author, timestamp)
                         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [sender, receiver, msgText, 0, senderName, msg.type || 'chat', 'history', waId, quotedMessage, quotedAuthor, timestamp]
                    );
                    lastMsg = msg;
                }

                // Actualizar chats con el último mensaje del contacto
                if (lastMsg) {
                    const msgText   = lastMsg.type === 'chat' ? (lastMsg.body || '') : `${lastMsg.type} received`;
                    const timestamp = fmtTs(new Date(lastMsg.timestamp * 1000));

                    const existing = await getDb().get(
                        `SELECT _id FROM chats WHERE sender = ?`, [contactAddr]
                    );
                    if (!existing) {
                        await getDb().run(
                            `INSERT INTO chats
                             (sender, receiver, message, status, sender_name, chat_type, device_type, last_from_me, timestamp)
                             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [contactAddr, myAddr, msgText, 0, contactName, lastMsg.type || 'chat', 'history',
                             lastMsg.fromMe ? 1 : 0, timestamp]
                        );
                    }
                }

            } catch (chatErr) {
                // Continuar con el siguiente chat si uno falla
            }
        }
        console.log(`[${id}] Sync de historial completado.`);
    } catch (err) {
        console.error(`[${id}] syncHistory error:`, err.message);
    }
}

async function sendMessage(sender, receiver, message, quotedMessageId) {
    try {
        const client = clients[sender.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { statusCode: '002', statusDesc: 'User session not found' } };

        // Si es una respuesta (reply), citar el mensaje original. La info de cita
        // se persiste automáticamente en el evento message_create (single writer),
        // que ve message.hasQuotedMsg en el mensaje que acabamos de enviar.
        const options = quotedMessageId ? { quotedMessageId } : {};

        // Guardar wa_id del mensaje enviado para deduplicar con message_create
        const sentMsg = await client.sendMessage(receiver, message, options);
        const waId = sentMsg?.id?._serialized || null;

        // Don't insert into chats table here — message_create event will handle it
        // This prevents duplicate chats when messages are sent
        return { status: 200, data: { message: 'message sent successfully' } };

    } catch (error) {
        const firstLine = error.message.split(/\r?\n/)[0];
        console.error(firstLine);
        return { status: 500, data: { error: firstLine } };
    }
}

// Reacciona (emoji) a un mensaje identificado por su wa_id. emoji === '' quita la reacción.
async function reactToMessage(sender, waId, emoji) {
    try {
        const client = clients[sender.replace("@c.us", "")];
        if (!client)
            return { status: 401, data: { error: 'User session not found' } };
        if (!waId)
            return { status: 400, data: { error: 'wa_id required' } };

        const msg = await client.getMessageById(waId);
        if (!msg)
            return { status: 404, data: { error: 'Message not found' } };

        await msg.react(emoji || '');

        // Reflejar de inmediato en la BD (el evento message_reaction también lo hará).
        await getDb().run(`UPDATE messages SET reaction = ? WHERE wa_id = ?`, [emoji || '', waId]);

        return { status: 200, data: { message: 'reaction sent', emoji: emoji || '' } };
    } catch (error) {
        const firstLine = (error.message || '').split(/\r?\n/)[0];
        console.error('[reactToMessage]', firstLine);
        return { status: 500, data: { error: firstLine } };
    }
}

async function listUsers() {
    let html = "<style>table,th,td{border:1px solid black;border-collapse:collapse;padding:4px}</style>";
    html += "<table><tr><th>User</th><th>Platform</th></tr>";
    for (const userId in clients) {
        const c = clients[userId];
        html += `<tr><td>${c.info?.pushname ?? ""}</td><td>${c.info?.platform ?? ""}</td></tr>`;
    }
    html += "</table>";
    return html;
}

function clientExists(id) {
    return clients[id] !== undefined;
}

async function getContactInfo(mobileNumber, contactId) {
    try {
        const regex = /;interface=wifi/gi;
        mobileNumber = mobileNumber.replace(regex, "");
        contactId    = contactId.replace(regex, "");
        const client = clients[mobileNumber.replace("@c.us", "")];
        if (!client) return { status: 401, data: { error: "User session not found" } };

        let name = "", phone = "", about = "";

        // 1) Resolver el contacto. Para @lid, getContactById(lid).number devuelve el teléfono real.
        try {
            const contact = await client.getContactById(contactId);
            if (contact) {
                name  = contact.name || contact.pushname || "";
                phone = contact.number ? `+${contact.number}` : "";
                try { about = (await contact.getAbout()) || ""; } catch (_) {}
            }
        } catch (e) {
            console.log(`[contactinfo] getContactById falló para ${contactId}: ${e.message}`);
        }

        // 2) Fallback del teléfono: si el id ya es @c.us, el número está en el id.
        if (!phone && contactId.includes('@c.us')) {
            phone = `+${contactId.replace('@c.us', '')}`;
        }

        // 3) Fallback del nombre: nombre guardado en mensajes previos.
        if (!name) {
            try {
                const row = await getDb().get(
                    `SELECT sender_name FROM messages WHERE sender = ? AND sender_name IS NOT NULL LIMIT 1`,
                    [contactId]
                );
                if (row?.sender_name) name = row.sender_name;
            } catch (_) {}
        }

        console.log(`[contactinfo] ${contactId} → name="${name}" phone="${phone}" about="${about.substring(0,30)}"`);
        return { status: 200, data: { name, phone, about } };
    } catch (error) {
        return { status: 500, data: { error: error.message } };
    }
}

module.exports = {
    startClient, clientExists, sendMessage, reactToMessage, getStatus, validate,
    getAllChats, getAllMessages, loginUser, logoutUser,
    getChats, getContacts, uploadMedia, getMessages, listUsers,
    getProfilePic, getContactInfo
}
