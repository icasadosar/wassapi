require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const wppconnect = require('@wppconnect-team/wppconnect');
const { getAuthenticatedClient, cargarMapaContactosGoogle, sincronizarContactoGoogle } = require('./googleContacts');

// Cargar variables de entorno con valores por defecto
const GROUP_NAME = process.env.GROUP_NAME || 'Nombre De Tu Grupo';
const CSV_PATH = path.resolve(process.env.CSV_PATH || './cd_cigales_20260808_jugador.csv');
const PHONE_COLUMN = process.env.PHONE_COLUMN || 'Teléfono tutor';
const NAME_COLUMN = process.env.NAME_COLUMN || 'Nombre tutor';

// Columnas para Google Contacts: "Nombre tutor", "Teléfono tutor", "Nombre", "Apellidos", "Equipos"
const TUTOR_NAME_COLUMN = process.env.TUTOR_NAME_COLUMN || 'Nombre tutor';
const PLAYER_NAME_COLUMN = process.env.PLAYER_NAME_COLUMN || 'Nombre';
const PLAYER_SURNAME_COLUMN = process.env.PLAYER_SURNAME_COLUMN || 'Apellidos';
const PLAYER_TEAM_COLUMN = process.env.PLAYER_TEAM_COLUMN || 'Equipos';

const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '34';
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_MS || '5000', 10);
const MAX_DELAY_MS = parseInt(process.env.MAX_DELAY_MS || '10000', 10);
const IS_DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
const USER_PHONE = process.env.USER_PHONE || '';

// Opciones de Google Contacts
const SYNC_GOOGLE_CONTACTS = process.env.SYNC_GOOGLE_CONTACTS === 'true' || process.argv.includes('--sync-google-contacts');
const GOOGLE_CREDENTIALS_PATH = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json');
const GOOGLE_TOKEN_PATH = path.resolve(process.env.GOOGLE_TOKEN_PATH || './token.json');

// Ruta del archivo local de persistencia de estado
const SYNC_STATE_PATH = path.resolve('./sync_state.json');

/**
 * Carga la base de datos local de contactos totalmente procesados
 */
function cargarEstadoSync() {
    try {
        if (fs.existsSync(SYNC_STATE_PATH)) {
            const raw = fs.readFileSync(SYNC_STATE_PATH, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {}
    return {};
}

/**
 * Guarda o actualiza el estado de un contacto en el archivo local sync_state.json
 */
function guardarEstadoSync(phone, data) {
    try {
        const state = cargarEstadoSync();
        state[phone] = {
            ...(state[phone] || {}),
            ...data,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {}
}

/**
 * Genera una pausa aleatoria entre min y max milisegundos para simular comportamiento humano
 */
function randomDelay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normaliza un teléfono a formato internacional (ej: "34652924590")
 */
function normalizarTelefono(rawPhone) {
    if (!rawPhone) return null;

    let clean = rawPhone.toString().replace(/\D/g, '');
    if (!clean) return null;

    if (clean.startsWith('0034')) {
        clean = clean.substring(2);
    }

    if (clean.length === 9 && DEFAULT_COUNTRY_CODE) {
        clean = `${DEFAULT_COUNTRY_CODE}${clean}`;
    }

    return clean;
}

/**
 * Lee el archivo CSV y retorna la lista de contactos adaptada
 */
function cargarContactosDesdeCSV(filePath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            return reject(new Error(`El archivo CSV no existe en la ruta: ${filePath}`));
        }

        const contactos = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const rawPhone = row[PHONE_COLUMN] || row['Teléfono tutor'] || row['telefono'] || row['teléfono'] || row['phone'] || row['Phone'] || '';
                const phoneNorm = normalizarTelefono(rawPhone);

                const tutor = (row[TUTOR_NAME_COLUMN] || row[NAME_COLUMN] || row['Nombre tutor'] || row['nombre'] || row['name'] || 'Tutor').trim();
                const player = (row[PLAYER_NAME_COLUMN] || row['Nombre'] || '').trim();
                const surname = (row[PLAYER_SURNAME_COLUMN] || row['Apellidos'] || '').trim();
                const team = (row[PLAYER_TEAM_COLUMN] || row['Equipos'] || '').trim();

                const whatsappName = tutor;
                
                let googleName = '';
                if (player || surname) {
                    const fullPlayer = `${player} ${surname}`.trim();
                    const teamStr = team ? ` (${team})` : '';
                    googleName = `${tutor} - ${fullPlayer}${teamStr}`;
                } else {
                    googleName = tutor;
                }

                if (phoneNorm) {
                    contactos.push({
                        whatsappName,
                        googleName,
                        tutor,
                        player,
                        surname,
                        team,
                        rawPhone,
                        phone: phoneNorm,
                        jid: `${phoneNorm}@c.us`
                    });
                } else {
                    console.warn(`[ADVERTENCIA] Fila omitida por teléfono no válido:`, row);
                }
            })
            .on('end', () => resolve(contactos))
            .on('error', (err) => reject(err));
    });
}

/**
 * Ejecuta el procesamiento de contactos con la sesión activa de WPPConnect
 */
async function iniciarProceso(client) {
    console.log('\nCliente de WhatsApp Web listo y conectado (WPPConnect).');
    if (IS_DRY_RUN) {
        console.log('*** MODO SIMULACIÓN (--dry-run) ACTIVADO: No se modificarán datos reales ***\n');
    }

    let stats = {
        totalCSV: 0,
        omitidosTotales: 0,
        yaEnGrupoWhatsApp: 0,
        añadidosWhatsApp: 0,
        fallidosWhatsApp: 0,
        creadosGoogle: 0,
        actualizadosGoogle: 0,
        omitidosGoogle: 0,
        fallidosGoogle: 0
    };

    try {
        let googleAuthClient = null;
        let googleContext = null;
        if (SYNC_GOOGLE_CONTACTS) {
            console.log('Inicializando autenticación con Google Contacts API...');
            googleAuthClient = await getAuthenticatedClient(GOOGLE_CREDENTIALS_PATH, GOOGLE_TOKEN_PATH);
            console.log('Autenticación con Google Contacts realizada con éxito.');
            googleContext = await cargarMapaContactosGoogle(googleAuthClient);
            console.log('');
        } else {
            console.log('Sincronización con Google Contacts DESACTIVADA (Usa SYNC_GOOGLE_CONTACTS=true o --sync-google-contacts para activarla).\n');
        }

        console.log(`Cargando contactos desde CSV (${CSV_PATH})...`);
        const contactos = await cargarContactosDesdeCSV(CSV_PATH);
        stats.totalCSV = contactos.length;
        console.log(`Se encontraron ${contactos.length} contactos válidos en el CSV.\n`);

        console.log(`Buscando grupo: "${GROUP_NAME}"...`);
        const chats = await client.listChats();
        console.log(`    ↳ Total chats devueltos por listChats(): ${chats.length}`);
        
        const targetNameLower = GROUP_NAME.trim().toLowerCase();
        let targetGroup = null;

        for (const c of chats) {
            if (!c.isGroup) continue;
            const name = (c.name || c.formattedTitle || '').trim();
            const subject = (c.subject || '').trim();
            
            console.log(`        ↳ [GRUPO ENCONTRADO EN WHATSAPP] name="${name}", subject="${subject}" (ID: ${c.id ? c.id._serialized : c.id})`);

            const matchName = name && (name.toLowerCase().includes(targetNameLower) || targetNameLower.includes(name.toLowerCase()));
            const matchSubject = subject && (subject.toLowerCase().includes(targetNameLower) || targetNameLower.includes(subject.toLowerCase()));

            if (matchName || matchSubject) {
                targetGroup = c;
            }
        }

        if (!targetGroup) {
            console.error(`\n[ERROR CRÍTICO] No se encontró el grupo "${GROUP_NAME}". Verifique el nombre en .env`);
            await client.close();
            process.exit(1);
        }

        const groupId = targetGroup.id ? (targetGroup.id._serialized || targetGroup.id) : '';
        console.log(`Grupo encontrado: "${targetGroup.name || targetGroup.formattedTitle || targetGroup.subject}" (ID: ${groupId})`);

        console.log('Obteniendo participantes actuales del grupo...');
        const metadata = await client.getGroupMetadata(groupId);
        const participantesActuales = new Set(
            metadata.participants.map(p => p.id._serialized || p.id)
        );

        console.log(`Participantes detectados en el grupo: ${participantesActuales.size}.\n`);

        const syncStateCache = cargarEstadoSync();

        console.log('--- INICIANDO PROCESAMIENTO DE CONTACTOS ---\n');

        for (let i = 0; i < contactos.length; i++) {
            const contacto = contactos[i];
            const prefixLog = `[${i + 1}/${contactos.length}]`;

            console.log(`${prefixLog} Procesando tutor: ${contacto.whatsappName} (${contacto.phone})`);

            // Comprobar si el contacto ya figura en la base de datos local de persistencia como 100% completado
            const cachedContact = syncStateCache[contacto.phone];
            if (cachedContact && cachedContact.googleSynced && cachedContact.whatsappAdded) {
                console.log(`    ↳ [OMITIDO CACHÉ LOCAL] ${contacto.whatsappName} (${contacto.phone}) ya completó la sincronización previamente.\n`);
                stats.omitidosTotales++;
                stats.yaEnGrupoWhatsApp++;
                stats.omitidosGoogle++;
                continue;
            }

            let resGoogle = null;
            if (SYNC_GOOGLE_CONTACTS && googleAuthClient) {
                resGoogle = await sincronizarContactoGoogle({
                    authClient: googleAuthClient,
                    googleContext: googleContext,
                    phone: contacto.phone,
                    formattedName: contacto.googleName,
                    isDryRun: IS_DRY_RUN
                });

                if (['created', 'simulated_create'].includes(resGoogle.action)) {
                    stats.creadosGoogle++;
                } else if (['updated', 'simulated_update'].includes(resGoogle.action)) {
                    stats.actualizadosGoogle++;
                } else if (resGoogle.action === 'updated_skipped') {
                    stats.omitidosGoogle++;
                } else if (resGoogle.action === 'error') {
                    stats.fallidosGoogle++;
                }
            }

            const phoneLast9 = contacto.phone.length >= 9 ? contacto.phone.slice(-9) : contacto.phone;
            const isAlreadyInGroup = participantesActuales.has(contacto.jid) ||
                participantesActuales.has(`${contacto.phone}@c.us`) ||
                participantesActuales.has(phoneLast9);

            const isGoogleReady = !SYNC_GOOGLE_CONTACTS || (resGoogle && (resGoogle.action === 'updated_skipped' || resGoogle.action === 'skipped' || resGoogle.action === 'created'));

            if (isAlreadyInGroup && isGoogleReady) {
                console.log(`    ↳ [OMITIDO TOTAL] ${contacto.whatsappName} (${contacto.phone}) ya está al día en Google Contacts y ya es miembro del grupo de WhatsApp.\n`);
                stats.omitidosTotales++;
                stats.yaEnGrupoWhatsApp++;
                guardarEstadoSync(contacto.phone, { googleSynced: true, whatsappAdded: true });
                continue;
            }

            if (isAlreadyInGroup) {
                console.log(`    ↳ [OMITIDO WHATSAPP] ${contacto.whatsappName} (${contacto.phone}) ya es miembro del grupo.`);
                stats.yaEnGrupoWhatsApp++;
            } else {
                console.log(`    ↳ [AÑADIENDO WHATSAPP] Añadiendo a ${contacto.whatsappName} (${contacto.phone}) al grupo...`);

                if (IS_DRY_RUN) {
                    console.log(`        ↳ [SIMULACIÓN WHATSAPP] Se añadiría ${contacto.jid} al grupo.`);
                    stats.añadidosWhatsApp++;
                } else {
                    try {
                        // Utilizar API nativa interna de WPPConnect para añadir al participante de forma directa y limpia
                        const result = await client.addParticipant(groupId, contacto.jid);
                        
                        console.log(`        ↳ [ÉXITO WHATSAPP] Añadido correctamente. Respuesta:`, JSON.stringify(result));
                        stats.añadidosWhatsApp++;
                        guardarEstadoSync(contacto.phone, { googleSynced: isGoogleReady, whatsappAdded: true });
                    } catch (err) {
                        console.error(`        ↳ [ERROR WHATSAPP] No se pudo añadir a ${contacto.phone}:`, err.message || err);
                        stats.fallidosWhatsApp++;
                    }
                }
            }

            if (i < contactos.length - 1) {
                const delaySec = Math.round((MIN_DELAY_MS + MAX_DELAY_MS) / 2000);
                console.log(`    ... esperando ~${delaySec}s entre contactos ...\n`);
                await randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
            }
        }

        console.log('\n======================================================');
        console.log(' RESUMEN FINAL DEL PROCESO');
        console.log('======================================================');
        console.log(` Total contactos en CSV:            ${stats.totalCSV}`);
        console.log(` Totalmente Omitidos (Google + WA):  ${stats.omitidosTotales}`);
        console.log(' ----------------------------------------------------');
        console.log(` WhatsApp - Omitidos (Ya en grupo): ${stats.yaEnGrupoWhatsApp}`);
        console.log(` WhatsApp - Añadidos con éxito:     ${stats.añadidosWhatsApp}`);
        console.log(` WhatsApp - Fallidos / Error:        ${stats.fallidosWhatsApp}`);
        if (SYNC_GOOGLE_CONTACTS) {
            console.log(' ----------------------------------------------------');
            console.log(` Google - Creados con éxito:        ${stats.creadosGoogle}`);
            console.log(` Google - Actualizados con éxito:   ${stats.actualizadosGoogle}`);
            console.log(` Google - Omitidos (Ya al día):     ${stats.omitidosGoogle}`);
            console.log(` Google - Fallidos / Error:         ${stats.fallidosGoogle}`);
        }
        console.log('======================================================\n');

    } catch (error) {
        console.error('Error durante la ejecución:', error);
    } finally {
        console.log('Cerrando sesión de WhatsApp...');
        try {
            await client.close();
        } catch (e) {}
        process.exit(0);
    }
}

// Inicializar cliente WPPConnect con configuración limpia y optimizada
wppconnect.create({
    session: 'wassapi',
    headless: true,
    updatesLog: false,
    disableWelcome: true,
    autoClose: 0, // Desactivar el cierre automático de 60s por inactividad al escanear QR
    ...(USER_PHONE ? { phoneNumber: USER_PHONE } : {}),
    logQR: !USER_PHONE,
    catchQR: (base64Qrimg, asciiQR, attempts, feedback) => {
        if (USER_PHONE) return;
        try {
            const matches = base64Qrimg.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const buffer = Buffer.from(matches[2], 'base64');
                fs.writeFileSync(path.resolve('./qr.png'), buffer);
                console.log('\n[CÓDIGO QR] Guardado en qr.png en la raíz del proyecto. ¡Abre este archivo para escanearlo!\n');
            }
        } catch (e) {
            console.error('Error al guardar el código QR en archivo:', e);
        }
    },
    catchLinkCode: (code) => {
        console.log('\n======================================================');
        console.log(` CÓDIGO DE VINCULACIÓN: ${code}`);
        console.log('======================================================');
        console.log(' Abre WhatsApp en tu móvil:');
        console.log(' Ajustes -> Dispositivos vinculados -> Vincular dispositivo');
        console.log(' -> Vincular con el número de teléfono en su lugar');
        console.log(` Escribe el código: ${code}`);
        console.log('======================================================\n');
    },
    browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
    ]
})
.then((client) => iniciarProceso(client))
.catch((err) => {
    console.error('Error crítico al inicializar WPPConnect:', err);
    process.exit(1);
});
