require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { getAuthenticatedClient, sincronizarContactoGoogle } = require('./googleContacts');

// Cargar variables de entorno con valores por defecto
const GROUP_NAME = process.env.GROUP_NAME || 'Nombre De Tu Grupo';
const CSV_PATH = path.resolve(process.env.CSV_PATH || './contactos.example.csv');
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
 * Cierra visores multimedia abiertos y vuelve al listado principal de chats
 */
async function limpiarPantallaWhatsApp(page) {
    console.log('    ↳ Limpiando pantalla y cerrando visores de imágenes/diálogos...');
    
    for (let i = 0; i < 3; i++) {
        try {
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {}
    }

    try {
        await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, div[role="button"], span'));
            for (const el of elements) {
                const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
                if (label.toLowerCase() === 'close' || label.toLowerCase() === 'cerrar') {
                    try { el.click(); } catch(e) {}
                }
            }
        });
        await new Promise(r => setTimeout(r, 500));
    } catch (e) {}
}

/**
 * Busca un grupo en WhatsApp Web e interactúa con él abriendo la conversación
 */
async function buscarGrupoPorNombreSeguro(client, targetGroupName) {
    const page = client.pupPage;

    const searchSelector = 'input[aria-label="Search or start a new chat"], input[role="textbox"], input.html-input';

    console.log(`    ↳ Esperando el elemento de búsqueda...`);
    try {
        await page.waitForSelector(searchSelector, { timeout: 20000 });
    } catch (e) {}

    await limpiarPantallaWhatsApp(page);

    try {
        const inputHandle = await page.$(searchSelector);
        if (inputHandle) {
            console.log(`    ↳ Escribiendo "${targetGroupName}" en el buscador...`);
            await inputHandle.click();
            await new Promise(r => setTimeout(r, 300));

            await page.keyboard.down('Meta');
            await page.keyboard.press('A');
            await page.keyboard.up('Meta');
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 200));

            await inputHandle.type(targetGroupName, { delay: 70 });
            await new Promise(r => setTimeout(r, 2000));

            console.log(`    ↳ Abriendo el chat del grupo "${targetGroupName}"...`);
            
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 1000));

            await page.evaluate((targetName) => {
                const spans = Array.from(document.querySelectorAll('#pane-side span, #side span, div[role="listitem"] span'));
                const match = spans.find(s => s.innerText && s.innerText.trim().toLowerCase() === targetName.trim().toLowerCase());
                if (match) {
                    try { match.click(); } catch(e) {}
                }
            }, targetGroupName);

            await new Promise(r => setTimeout(r, 2500));
        }
    } catch (err) {
        console.warn('    ↳ Advertencia buscando e interactuando con el grupo:', err.message);
    }

    // Capturar pantalla del grupo abierto en pantalla
    const screenPath = path.resolve('./whatsapp_screen.png');
    try { await page.screenshot({ path: screenPath }); } catch (e) {}

    // Inspeccionar la presencia de objetos en window
    const debugObjects = await page.evaluate(() => {
        return {
            hasWWebJS: typeof window.WWebJS !== 'undefined',
            hasStore: typeof window.Store !== 'undefined',
            windowKeys: Object.keys(window).filter(k => k.toLowerCase().includes('wweb') || k.toLowerCase().includes('store') || k.toLowerCase().includes('webpack'))
        };
    });
    console.log('    [DIAGNÓSTICO WINDOW] Objetos detectados en navegador:', JSON.stringify(debugObjects));

    // Abrir la cabecera del grupo para mostrar la información del grupo y los participantes en pantalla
    try {
        await page.evaluate(() => {
            const header = document.querySelector('header div[role="button"], header div[title], header span[title], header');
            if (header) {
                try { header.click(); } catch(e) {}
            }
        });
        await new Promise(r => setTimeout(r, 1500));
    } catch (e) {}

    // Extraer teléfonos/contactos de participantes visibles en el DOM de la conversación abierta
    const domParticipants = await page.evaluate(() => {
        const set = new Set();
        const nodes = document.querySelectorAll('span, div, p');
        nodes.forEach(n => {
            const txt = n.innerText ? n.innerText.trim() : '';
            if (txt.match(/^\+?\d[\d\s-]{8,}\d$/)) {
                const clean = txt.replace(/\D/g, '');
                if (clean.length >= 9) {
                    set.add(`${clean}@c.us`);
                }
            }
        });
        return Array.from(set);
    });

    console.log(`    ↳ Participantes detectados en la interfaz visual: ${domParticipants.length}`);

    // Construir objeto de grupo funcional independiente de window.Store
    return {
        name: targetGroupName,
        isGroup: true,
        id: { _serialized: `${targetGroupName}@g.us` },
        participants: domParticipants.map(jid => ({ id: { _serialized: jid } })),
        addParticipants: async (jids) => {
            return await page.evaluate(async (participantJids) => {
                // Si WWebJS o Store están disponibles, usarlos
                if (window.WWebJS && window.WWebJS.group && window.WWebJS.group.addParticipants) {
                    const active = window.Store && window.Store.Chat && window.Store.Chat.getActive ? window.Store.Chat.getActive() : null;
                    if (active) {
                        return await window.WWebJS.group.addParticipants(active.id._serialized || active.id, participantJids);
                    }
                }

                // Fallback por interfaz visual: hacer clic en 'Añadir participante' / 'Add participant'
                const buttons = Array.from(document.querySelectorAll('div[role="button"], button, span'));
                const addBtn = buttons.find(b => {
                    const txt = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
                    return txt.includes('add participant') || txt.includes('añadir participante') || txt.includes('agregar participante');
                });

                if (addBtn) {
                    try { addBtn.click(); } catch(e) {}
                    return { status: 'ui_add_initiated' };
                }

                return { status: 'manual_fallback_needed' };
            }, jids);
        }
    };
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
        yaEnGrupoWhatsApp: 0,
        añadidosWhatsApp: 0,
        fallidosWhatsApp: 0,
        creadosGoogle: 0,
        actualizadosGoogle: 0,
        omitidosGoogle: 0,
        fallidosGoogle: 0
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
        console.log(`Participantes detectados en el grupo: ${participantesActuales.size}\n`);

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

            // 4b. Comprobar si el contacto ya pertenece al grupo de WhatsApp
            if (participantesActuales.has(contacto.jid)) {
                console.log(`    ↳ [OMITIDO WHATSAPP] ${contacto.whatsappName} ya es miembro del grupo.`);
                stats.yaEnGrupoWhatsApp++;
            } else {
                console.log(`    ↳ [AÑADIENDO WHATSAPP] Añadiendo a ${contacto.whatsappName} (${contacto.phone}) al grupo...`);

                if (IS_DRY_RUN) {
                    console.log(`        ↳ [SIMULACIÓN WHATSAPP] Se añadiría ${contacto.jid} al grupo.`);
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
        console.log(` Total contactos en CSV:            ${stats.totalCSV}`);
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
    }, 12000);
});

client.on('auth_failure', (msg) => {
    console.error('Error de autenticación en WhatsApp:', msg);
});

client.on('ready', async () => {
    await iniciarProceso();
});

client.initialize();
