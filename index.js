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
 * Cierra modales/popups flotantes de WhatsApp Web ("What's new on WhatsApp Web")
 */
async function cerrarModalesWhatsApp(page) {
    try {
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Escape');

        await page.evaluate(() => {
            // Buscar elementos de cierre de modales flotantes
            const elements = Array.from(document.querySelectorAll('div[role="button"], button, span[data-icon="x"]'));
            for (const el of elements) {
                const label = el.getAttribute('aria-label') || '';
                if (label.toLowerCase().includes('close') || label.toLowerCase().includes('cerrar') || el.innerHTML.includes('x')) {
                    try { el.click(); } catch(e) {}
                }
            }
        });
        await new Promise(r => setTimeout(r, 1000));
    } catch (e) {}
}

/**
 * Busca un grupo en WhatsApp Web mediante Store e interacción Puppeteer
 */
async function buscarGrupoPorNombreSeguro(client, targetGroupName) {
    const page = client.pupPage;

    console.log(`    ↳ Cerrando ventanas emergentes de bienvenida si las hubiera...`);
    await cerrarModalesWhatsApp(page);

    console.log(`    ↳ Buscando el grupo "${targetGroupName}" en WhatsApp Web...`);

    try {
        // Buscar el icono o barra de búsqueda visual de WhatsApp Web
        const searchInput = await page.$('#side div[contenteditable="true"], div[contenteditable="true"], p.selectable-text');
        if (searchInput) {
            await searchInput.click();
            await page.keyboard.down('Meta');
            await page.keyboard.press('A');
            await page.keyboard.up('Meta');
            await page.keyboard.press('Backspace');

            await page.keyboard.type(targetGroupName, { delay: 50 });
            await new Promise(r => setTimeout(r, 3000));
        }

        // Tomar captura de pantalla actualizada tras realizar la búsqueda
        const screenPath = path.resolve('./whatsapp_screen.png');
        try {
            await page.screenshot({ path: screenPath });
        } catch (e) {}

        // Inspeccionar chats en Store
        const result = await page.evaluate((targetName) => {
            const normTarget = targetName.trim().toLowerCase();
            const debugInfo = [];
            let foundGroup = null;

            let chats = [];
            if (window.Store && window.Store.Chat) {
                chats = window.Store.Chat.getModelsArray ? window.Store.Chat.getModelsArray() : (window.Store.Chat.models || []);
            }

            for (const chat of chats) {
                let name = '';
                try {
                    name = chat.name || chat.formattedTitle || chat.title || (chat.contact ? (chat.contact.name || chat.contact.pushname) : '') || '';
                } catch (e) {}

                const isGroup = chat.isGroup || (chat.id && chat.id.server === 'g.us') || (chat.id && typeof chat.id === 'string' && chat.id.includes('g.us'));

                if (isGroup) {
                    debugInfo.push({ name, id: chat.id ? (chat.id._serialized || chat.id) : 'unknown' });

                    if (name && name.trim().toLowerCase() === normTarget) {
                        let participants = [];
                        try {
                            if (chat.groupMetadata && chat.groupMetadata.participants) {
                                const rawParts = chat.groupMetadata.participants.getModelsArray ?
                                    chat.groupMetadata.participants.getModelsArray() : chat.groupMetadata.participants;

                                participants = (rawParts || []).map(p => {
                                    let idStr = '';
                                    if (p && p.id) {
                                        idStr = typeof p.id === 'string' ? p.id : (p.id._serialized || `${p.id.user}@c.us`);
                                    }
                                    return { id: { _serialized: idStr } };
                                });
                            }
                        } catch (pe) {}

                        const chatId = typeof chat.id === 'string' ? chat.id : (chat.id._serialized || `${chat.id.user}@g.us`);
                        foundGroup = {
                            id: chatId,
                            name: name,
                            participants: participants
                        };
                        break;
                    }
                }
            }

            return { foundGroup, debugInfo };
        }, targetGroupName);

        if (result && result.debugInfo && result.debugInfo.length > 0) {
            console.log('    [DIAGNÓSTICO] Grupos detectados tras búsqueda:');
            result.debugInfo.forEach(g => console.log(`      - "${g.name}" (ID: ${g.id})`));
        }

        if (result && result.foundGroup) {
            const groupData = result.foundGroup;
            return {
                name: groupData.name,
                isGroup: true,
                id: { _serialized: groupData.id },
                participants: groupData.participants,
                addParticipants: async (jids) => {
                    return await page.evaluate(async (chatId, participantJids) => {
                        if (window.WWebJS && window.WWebJS.group && window.WWebJS.group.addParticipants) {
                            return await window.WWebJS.group.addParticipants(chatId, participantJids);
                        } else {
                            const groupChat = window.Store.Chat.get(chatId);
                            return await groupChat.groupMetadata.participants.add(participantJids);
                        }
                    }, groupData.id, jids);
                }
            };
        }
    } catch (err) {
        console.error('    ↳ Error durante la búsqueda del grupo:', err.message);
    }

    return null;
}

// Inicializar cliente de WhatsApp Web
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
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

let processStarted = false;

async function iniciarProceso() {
    if (processStarted) return;
    processStarted = true;

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

        // 2. Buscar el grupo de WhatsApp de forma segura
        console.log(`Buscando grupo: "${GROUP_NAME}"...`);
        const grupo = await buscarGrupoPorNombreSeguro(client, GROUP_NAME);

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
}

client.on('qr', (qr) => {
    console.log('\n======================================================');
    console.log(' ESCANEA EL CÓDIGO QR CON TU APLICACIÓN DE WHATSAPP');
    console.log(' (Ajustes -> Dispositivos vinculados -> Vincular dispositivo)');
    console.log('======================================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
    console.log(`Cargando WhatsApp Web: ${percent}% - ${message}`);
});

client.on('authenticated', () => {
    console.log('Autenticación correcta en WhatsApp.');
    setTimeout(() => {
        if (!processStarted) {
            console.log('Iniciando procesamiento tras sincronizar la sesión...');
            iniciarProceso();
        }
    }, 6000);
});

client.on('auth_failure', (msg) => {
    console.error('Error de autenticación en WhatsApp:', msg);
});

client.on('ready', async () => {
    await iniciarProceso();
});

client.initialize();
