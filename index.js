require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { getAuthenticatedClient, sincronizarContactoGoogle } = require('./googleContacts');

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

// Opciones de Google Contacts
const SYNC_GOOGLE_CONTACTS = process.env.SYNC_GOOGLE_CONTACTS === 'true' || process.argv.includes('--sync-google-contacts');
const GOOGLE_CREDENTIALS_PATH = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json');
const GOOGLE_TOKEN_PATH = path.resolve(process.env.GOOGLE_TOKEN_PATH || './token.json');

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

    // Eliminar todo lo que no sea dígito
    let clean = rawPhone.toString().replace(/\D/g, '');

    if (!clean) return null;

    // Si el número empieza por 0034, eliminar los ceros iniciales
    if (clean.startsWith('0034')) {
        clean = clean.substring(2);
    }

    // Si el número tiene 9 dígitos (formato local en España), anteponer prefijo por defecto
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
                const rawPhone = row[PHONE_COLUMN];
                const phoneNorm = normalizarTelefono(rawPhone);

                const tutor = (row[TUTOR_NAME_COLUMN] || row[NAME_COLUMN] || 'Tutor').trim();
                const player = (row[PLAYER_NAME_COLUMN] || '').trim();
                const surname = (row[PLAYER_SURNAME_COLUMN] || '').trim();
                const team = (row[PLAYER_TEAM_COLUMN] || '').trim();

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
 * Obtiene la lista de chats con reintentos para evitar errores de sincronización con la versión de WhatsApp Web
 */
async function obtenerChatsConReintentos(client, retries = 3, delayMs = 3000) {
    for (let i = 1; i <= retries; i++) {
        try {
            await new Promise(r => setTimeout(r, delayMs));
            const chats = await client.getChats();
            if (chats && chats.length >= 0) return chats;
        } catch (err) {
            console.warn(`[ADVERTENCIA] Error al obtener la lista de chats (intento ${i}/${retries}): ${err.message}`);
            if (i === retries) throw err;
        }
    }
    return [];
}

// Inicializar cliente de WhatsApp Web con caché de versión estable
const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018940474-alpha.html',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n======================================================');
    console.log(' ESCANEA EL CÓDIGO QR CON TU APLICACIÓN DE WHATSAPP');
    console.log(' (Ajustes -> Dispositivos vinculados -> Vincular dispositivo)');
    console.log('======================================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Autenticación correcta en WhatsApp.');
});

client.on('auth_failure', (msg) => {
    console.error('Error de autenticación:', msg);
});

client.on('ready', async () => {
    console.log('\nCliente de WhatsApp Web listo y conectado.');
    if (IS_DRY_RUN) {
        console.log('*** MODO SIMULACIÓN (--dry-run) ACTIVADO: No se modificarán datos reales ***\n');
    }

    let stats = {
        totalCSV: 0,
        yaEnGrupo: 0,
        añadidosWhatsApp: 0,
        fallidosWhatsApp: 0,
        sincronizadosGoogle: 0
    };

    try {
        // Inicializar cliente de Google Contacts si está activado
        let googleAuthClient = null;
        if (SYNC_GOOGLE_CONTACTS) {
            console.log('Inicializando autenticación con Google Contacts API...');
            googleAuthClient = await getAuthenticatedClient(GOOGLE_CREDENTIALS_PATH, GOOGLE_TOKEN_PATH);
            console.log('Autenticación con Google Contacts realizada con éxito.\n');
        } else {
            console.log('Sincronización con Google Contacts DESACTIVADA (Usa SYNC_GOOGLE_CONTACTS=true o --sync-google-contacts para activarla).\n');
        }

        // 1. Cargar contactos desde CSV
        console.log(`Cargando contactos desde CSV (${CSV_PATH})...`);
        const contactos = await cargarContactosDesdeCSV(CSV_PATH);
        stats.totalCSV = contactos.length;
        console.log(`Se encontraron ${contactos.length} contactos válidos en el CSV.\n`);

        // 2. Buscar el grupo de WhatsApp por su nombre
        console.log(`Buscando grupo: "${GROUP_NAME}"...`);
        const chats = await obtenerChatsConReintentos(client);
        const grupo = chats.find(c => c.isGroup && c.name.trim().toLowerCase() === GROUP_NAME.trim().toLowerCase());

        if (!grupo) {
            console.error(`\n[ERROR CRÍTICO] No se encontró el grupo "${GROUP_NAME}". Verifique el nombre en .env`);
            await client.destroy();
            process.exit(1);
        }

        console.log(`Grupo encontrado: "${grupo.name}" (ID: ${grupo.id._serialized})`);

        // 3. Obtener Set de participantes actuales en el grupo
        const participantesActuales = new Set(
            grupo.participants.map(p => p.id._serialized)
        );
        console.log(`Participantes actuales en el grupo: ${participantesActuales.size}\n`);

        // 4. Procesar contactos uno a uno
        console.log('--- INICIANDO PROCESAMIENTO DE CONTACTOS ---\n');

        for (let i = 0; i < contactos.length; i++) {
            const contacto = contactos[i];
            const prefixLog = `[${i + 1}/${contactos.length}]`;

            console.log(`${prefixLog} Procesando tutor: ${contacto.whatsappName} (${contacto.phone})`);

            // 4a. Sincronizar opcionalmente en Google Contacts
            if (SYNC_GOOGLE_CONTACTS && googleAuthClient) {
                const resGoogle = await sincronizarContactoGoogle({
                    authClient: googleAuthClient,
                    phone: contacto.phone,
                    formattedName: contacto.googleName,
                    isDryRun: IS_DRY_RUN
                });

                if (['created', 'updated', 'simulated_create', 'simulated_update'].includes(resGoogle.action)) {
                    stats.sincronizadosGoogle++;
                }
            }

            // 4b. Comprobar si el contacto ya pertenece al grupo de WhatsApp
            if (participantesActuales.has(contacto.jid)) {
                console.log(`    ↳ [OMITIDO WHATSAPP] ${contacto.whatsappName} ya es miembro del grupo.`);
                stats.yaEnGrupo++;
            } else {
                console.log(`    ↳ [AÑADIENDO WHATSAPP] Añadiendo a ${contacto.whatsappName} (${contacto.phone}) al grupo...`);

                if (IS_DRY_RUN) {
                    console.log(`        ↳ [SIMULACIÓN] Se añadiría ${contacto.jid} al grupo.`);
                    stats.añadidosWhatsApp++;
                } else {
                    try {
                        const result = await grupo.addParticipants([contacto.jid]);
                        console.log(`        ↳ [ÉXITO WHATSAPP] Añadido correctamente. Respuesta:`, JSON.stringify(result));
                        stats.añadidosWhatsApp++;
                    } catch (err) {
                        console.error(`        ↳ [ERROR WHATSAPP] No se pudo añadir a ${contacto.phone}:`, err.message);
                        stats.fallidosWhatsApp++;
                    }
                }
            }

            // Aplicar retardo aleatorio entre adiciones (salvo en la última vuelta)
            if (i < contactos.length - 1) {
                const delaySec = Math.round((MIN_DELAY_MS + MAX_DELAY_MS) / 2000);
                console.log(`    ... esperando ~${delaySec}s entre contactos ...\n`);
                await randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
            }
        }

        console.log('\n======================================================');
        console.log(' RESUMEN FINAL DEL PROCESO');
        console.log('======================================================');
        console.log(` Total contactos en CSV:        ${stats.totalCSV}`);
        console.log(` Sincronizados Google Contacts: ${stats.sincronizadosGoogle}`);
        console.log(` Omitidos (Ya en WhatsApp):    ${stats.yaEnGrupo}`);
        console.log(` Añadidos con éxito WhatsApp:  ${stats.añadidosWhatsApp}`);
        console.log(` Fallidos / Error WhatsApp:    ${stats.fallidosWhatsApp}`);
        console.log('======================================================\n');

    } catch (error) {
        console.error('Error durante la ejecución:', error);
    } finally {
        console.log('Cerrando sesión de WhatsApp...');
        await client.destroy();
        process.exit(0);
    }
});

client.initialize();
