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
    if (addr.includes('@')) return addr;
    return addr + '@c.us';
}

const DISPLAY_TZ = process.env.DISPLAY_TZ || 'Europe/Madrid';

function fmtTs(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: DISPLAY_TZ,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(date);

    const v = t => parts.find(p => p.type === t).value;
    const hh = v('hour') === '24' ? '00' : v('hour');

    return `${v('year')}-${v('month')}-${v('day')} ${hh}:${v('minute')}:${v('second')}`;
}

function ffmpegPromise(inputPath, outputPath, options = []) {
    return new Promise((resolve, reject) => {
        let cmd = ffmpeg().input(inputPath);

        if (options.length)
            cmd = cmd.outputOptions(options);

        cmd.output(outputPath)
            .on("end", resolve)
            .on("error", reject)
            .run();
    });
}

async function persistMedia(message, newId) {
    try {
        const media = await message.downloadMedia();

        if (!media || !media.mimetype) {
            console.log(`[persistMedia ${newId}] sin media descargable`);
            return;
        }

        const mime = media.mimetype;
        let mediaFilename = null;

        if (message.type === 'sticker') {
            const srcPath = path.join(MEDIA_DIR, newId + '.webp');
            const pngPath = path.join(MEDIA_DIR, newId + '.png');

            fs.writeFileSync(
                srcPath,
                Buffer.from(media.data, 'base64')
            );

            try {
                await ffmpegPromise(
                    srcPath,
                    pngPath,
                    ['-frames:v 1', '-update 1']
                );

                fs.unlinkSync(srcPath);

                mediaFilename = newId + '.png';

                console.log(
                    `[persistMedia ${newId}] sticker convertido a png`
                );

            } catch (e) {
                mediaFilename = newId + '.webp';

                console.log(
                    `[persistMedia ${newId}] sticker→png falló, usando webp: ${e.message}`
                );
            }
        }

        else if (mime.startsWith('image/')) {
            const ext =
                mime === 'image/webp'
                    ? '.webp'
                    : '.jpg';

            mediaFilename = newId + ext;

            fs.writeFileSync(
                path.join(MEDIA_DIR, mediaFilename),
                Buffer.from(media.data, 'base64')
            );
        }

        else if (mime.startsWith('audio/')) {
            const srcPath =
                path.join(MEDIA_DIR, newId + '.ogg');

            const destPath =
                path.join(MEDIA_DIR, newId + '.mp3');

            fs.writeFileSync(
                srcPath,
                Buffer.from(media.data, 'base64')
            );

            await ffmpegPromise(
                srcPath,
                destPath,
                ['-codec:a libmp3lame']
            );

            fs.unlinkSync(srcPath);

            mediaFilename = newId + '.mp3';

            console.log(
                `[persistMedia ${newId}] audio convertido a mp3`
            );
        }

        else if (mime.startsWith('video/')) {
            const srcPath =
                path.join(MEDIA_DIR, newId + '.mp4');

            const destPath =
                path.join(MEDIA_DIR, newId + '.3gp');

            fs.writeFileSync(
                srcPath,
                Buffer.from(media.data, 'base64')
            );

            await ffmpegPromise(
                srcPath,
                destPath,
                [
                    '-s 352x288',
                    '-acodec aac',
                    '-strict experimental',
                    '-ac 1',
                    '-ar 8000',
                    '-ab 24k'
                ]
            );

            mediaFilename = newId + '.3gp';

            console.log(
                `[persistMedia ${newId}] vídeo convertido a 3gp`
            );
        }

        if (mediaFilename) {
            await getDb().run(
                `UPDATE messages
                 SET media_filename = ?
                 WHERE _id = ?`,
                [
                    mediaFilename,
                    newId
                ]
            );

            console.log(
                `[persistMedia ${newId}] guardado: ${mediaFilename}`
            );
        }

    } catch (err) {
        console.error(
            `[persistMedia ${newId}] error:`,
            err.message
        );
    }
}

async function extractQuoted(message, client) {
    try {
        if (!message.hasQuotedMsg)
            return {
                quotedMessage: null,
                quotedAuthor: null
            };

        const quoted =
            await message.getQuotedMessage();

        if (!quoted)
            return {
                quotedMessage: null,
                quotedAuthor: null
            };

        let preview;

        if (quoted.type === 'chat')
            preview =
                (quoted.body || '').substring(0, 120);
        else
            preview =
                `[${quoted.type}]`;

        let author;

        if (quoted.fromMe)
            author =
                client?.info?.pushname || 'Me';
        else
            author =
                quoted._data?.notifyName || '';

        return {
            quotedMessage: preview,
            quotedAuthor: author
        };

    } catch (_) {
        return {
            quotedMessage: null,
            quotedAuthor: null
        };
    }
}

function startClient(id) {

    if (clients[id]) {
        console.log(
            `[${id}] client already exists, skipping duplicate start`
        );
        return;
    }

    const lockFile =
        path.join(
            __dirname,
            '.wwebjs_auth',
            `session-${id}`,
            'SingletonLock'
        );

    try {
        fs.unlinkSync(lockFile);

        console.log(
            `[${id}] SingletonLock eliminado`
        );

    } catch (_) {}

    clients[id] = new Client({

        authStrategy:
            new LocalAuth({
                clientId: id
            }),

        puppeteer: {
            headless: true,

            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
                '--disable-background-networking'
            ],
        },
    });

    clients[id]
        .initialize()
        .catch(err =>
            console.error(
                `[${id}] init error:`,
                err
            )
        );

    clients[id].on(
        "qr",
        (qr) => {

            console.log(
                `[${id}] QR code generated`
            );

            qrcodes[id] = qr;
        }
    );

    clients[id].on(
        "ready",
        () => {

            authenticatedClients[id] = id;

            console.log(
                `[${id}] Client is ready!`
            );

            delete qrcodes[id];

            syncHistory(id)
                .catch(err =>
                    console.error(
                        `[${id}] syncHistory error:`,
                        err
                    )
                );
        }
    );

    clients[id].on(
        "auth_failure",
        (message) => {

            console.error(
                `[${id}] Authentication failure:`,
                message
            );

            delete authenticatedClients[id];
            delete qrcodes[id];
        }
    );

    clients[id].on(
        'message_create',
        async message => {

            if (!message.fromMe)
                return;

            if (!clients[id]?.info)
                return;

            const waId =
                message.id?._serialized;

            if (waId) {

                const exists =
                    await getDb().get(
                        'SELECT _id FROM messages WHERE wa_id = ?',
                        [waId]
                    );

                if (exists)
                    return;
            }

            const myAddr =
                clients[id].info.wid.user +
                '@c.us';

            const toAddr =
                normalizeAddr(
                    message.to || ''
                );

            if (
                !toAddr ||
                (toAddr === myAddr && !message.to)
            )
                return;

            const msgText =
                message.type === 'chat'
                    ? (message.body || '')
                    : `${message.type} sent`;

            const pushname =
                clients[id].info.pushname ||
                'Me';

            try {

                const contactName =
                    await resolveContactName(
                        clients[id],
                        toAddr
                    );

                const chatType =
                    message.type || 'chat';

                const {
                    quotedMessage,
                    quotedAuthor
                } =
                    await extractQuoted(
                        message,
                        clients[id]
                    );

                const ts =
                    fmtTs();

                await getDb().run(
                    'DELETE FROM chats WHERE sender = ?',
                    [toAddr]
                );

                await getDb().run(
                    `INSERT INTO chats(
                        sender,
                        receiver,
                        message,
                        status,
                        sender_name,
                        chat_type,
                        device_type,
                        unread_count,
                        last_from_me,
                        timestamp
                    )
                    VALUES(
                        ?, ?, ?, ?, ?, ?, ?, 0, 1, ?
                    )`,
                    [
                        toAddr,
                        myAddr,
                        msgText,
                        0,
                        contactName,
                        chatType,
                        message.deviceType ||
                            'unknown',
                        ts
                    ]
                );

                const result =
                    await getDb().run(
                        `INSERT INTO messages(
                            sender,
                            receiver,
                            message,
                            status,
                            sender_name,
                            chat_type,
                            device_type,
                            wa_id,
                            quoted_message,
                            quoted_author,
                            timestamp
                        )
                        VALUES(
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                        )`,
                        [
                            myAddr,
                            toAddr,
                            msgText,
                            0,
                            pushname,
                            chatType,
                            message.deviceType ||
                                'unknown',
                            waId || null,
                            quotedMessage,
                            quotedAuthor,
                            ts
                        ]
                    );

                const newId =
                    result.lastID;

                if (message.hasMedia) {
                    await persistMedia(
                        message,
                        newId
                    );
                }

                console.log(
                    `[message_create] guardado: ${pushname} → ${toAddr}: ${msgText.substring(0, 40)}`
                );

            } catch (err) {
                console.error(
                    '[message_create] error:',
                    err.message
                );
            }
        }
    );

    clients[id].on(
        'disconnected',
        async (reason) => {

            console.log(
                `[${id}] Client disconnected (${reason})`
            );

            delete authenticatedClients[id];
            delete qrcodes[id];

            const oldClient =
                clients[id];

            delete clients[id];

            try {
                await oldClient.destroy();

            } catch (err) {
                console.error(
                    `[${id}] destroy error:`,
                    err.message
                );
            }

            setTimeout(
                () => {

                    console.log(
                        `[${id}] restarting client...`
                    );

                    startClient(id);

                },
                5000
            );
        }
    );

    clients[id].on(
        'change_state',
        (state) => {

            console.log(
                `[${id}] Connection state changed:`,
                state
            );
        }
    );

    clients[id].on(
        'message',
        async message => {

            try {

                console.log(
                    `Message from: ${message.from}`
                );

                let waChat = null;

                try {
                    waChat =
                        await message.getChat();

                } catch (e) {
                    console.error(
                        '[message] getChat:',
                        e.message
                    );
                }

                let msg;

                if (message.type == 'ptt')
                    msg = 'Voice received';

                else if (message.type == 'image')
                    msg = 'Image received';

                else if (message.type == 'audio')
                    msg = 'Audio received';

                else if (message.type == 'video')
                    msg = 'Video received';

                else if (message.type == 'chat')
                    msg = message.body;

                else
                    msg =
                        `${message.type} received`;

                console.log(
                    `Message: ${msg}`
                );

                if (
                    message.from ===
                    'status@broadcast'
                )
                    return;

                const waId =
                    message.id?._serialized;

                if (waId) {

                    const exists =
                        await getDb().get(
                            'SELECT _id FROM messages WHERE wa_id = ?',
                            [waId]
                        );

                    if (exists) {

                        console.log(
                            `[message] Skipping duplicate wa_id: ${waId}`
                        );

                        return;
                    }
                }

                let senderNameForChat =
                    message._data.notifyName;

                let senderNameForMessages =
                    message._data.notifyName;

                if (waChat?.isGroup)
                    senderNameForChat =
                        waChat.name;

                if (!senderNameForMessages)
                    senderNameForMessages =
                        message.from;

                if (!senderNameForChat)
                    senderNameForChat =
                        message.from;

                const existingChat =
                    await getDb().get(
                        'SELECT unread_count FROM chats WHERE sender = ?',
                        [message.from]
                    );

                const newUnreadCount =
                    (
                        existingChat?.unread_count ||
                        0
                    ) + 1;

                await getDb().run(
                    'DELETE FROM chats WHERE sender = ?',
                    [message.from]
                );

                const {
                    quotedMessage,
                    quotedAuthor
                } =
                    await extractQuoted(
                        message,
                        clients[id]
                    );

                const ts =
                    fmtTs();

                await getDb().run(
                    `INSERT INTO chats(
                        sender,
                        receiver,
                        message,
                        status,
                        sender_name,
                        chat_type,
                        device_type,
                        unread_count,
                        last_from_me,
                        timestamp
                    )
                    VALUES(
                        ?, ?, ?, ?, ?, ?, ?, ?, 0, ?
                    )`,
                    [
                        message.from,
                        message.to,
                        msg,
                        0,
                        senderNameForChat,
                        message.type,
                        message.deviceType,
                        newUnreadCount,
                        ts
                    ]
                );

                const result =
                    await getDb().run(
                        `INSERT INTO messages(
                            sender,
                            receiver,
                            message,
                            status,
                            sender_name,
                            chat_type,
                            device_type,
                            wa_id,
                            quoted_message,
                            quoted_author,
                            timestamp
                        )
                        VALUES(
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                        )`,
                        [
                            message.from,
                            message.to,
                            msg,
                            0,
                            senderNameForMessages,
                            message.type,
                            message.deviceType,
                            waId,
                            quotedMessage,
                            quotedAuthor,
                            ts
                        ]
                    );

                const newId =
                    result.lastID;

                if (message.hasMedia) {
                    await persistMedia(
                        message,
                        newId
                    );
                }

            } catch (err) {
                console.error(
                    '[message] error:',
                    err.message
                );
            }
        }
    );

    clients[id].on(
        'message_reaction',
        async reaction => {

            try {

                const targetWaId =
                    reaction.msgId?._serialized;

                if (!targetWaId)
                    return;

                const emoji =
                    reaction.reaction || '';

                const result =
                    await getDb().run(
                        `UPDATE messages
                         SET reaction = ?
                         WHERE wa_id = ?`,
                        [
                            emoji,
                            targetWaId
                        ]
                    );

                console.log(
                    `[message_reaction] ${targetWaId} → "${emoji}" (filas: ${result.changes})`
                );

            } catch (err) {
                console.error(
                    '[message_reaction] error:',
                    err.message
                );
            }
        }
    );
}
