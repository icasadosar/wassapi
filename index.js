require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
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
 * Añade un contacto al grupo abierto mediante la interfaz gráfica de WhatsApp Web
 */
async function añadirParticipantePorUI(page, phone) {
    console.log(`        ↳ [UI WHATSAPP] Desplegando información del grupo (#main header)...`);
    
    // 1. Abrir panel de información del grupo haciendo clic específicamente en #main header (panel derecho del chat activo)
    await page.evaluate(() => {
        const groupHeader = document.querySelector('#main header div[role="button"], #main header span[title], #main header');
        if (groupHeader) {
            try { groupHeader.click(); } catch(e) {}
        }
    });
    await new Promise(r => setTimeout(r, 2000));

    // Diagnóstico de elementos en el panel de información del grupo
    const diagInfo = await page.evaluate(() => {
        const rightPane = document.querySelector('#main + div, div[role="region"]') || document.body;
        const elements = Array.from(rightPane.querySelectorAll('div[role="button"], button, span[data-icon], div[title]'));
        return elements.map(el => ({
            text: (el.innerText || '').trim(),
            aria: el.getAttribute('aria-label') || '',
            icon: el.getAttribute('data-icon') || (el.querySelector('span[data-icon]') ? el.querySelector('span[data-icon]').getAttribute('data-icon') : '')
        })).filter(i => (i.text && i.text.length < 50) || i.aria || i.icon);
    });

    console.log('        [DIAGNÓSTICO PANEL DERECHO GROUP INFO] Elementos localizados:', JSON.stringify(diagInfo.slice(0, 15)));

    // 2. Localizar y hacer clic en 'Add member' / 'Add participant' / 'Añadir participante'
    const addBtnClicked = await page.evaluate(() => {
        const rightPane = document.querySelector('#main + div, div[role="region"]') || document.body;
        const clickable = Array.from(rightPane.querySelectorAll('div[role="button"], button, span, div'));
        const target = clickable.find(el => {
            const txt = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
            const icon = el.getAttribute('data-icon') || (el.querySelector('span[data-icon]') ? el.querySelector('span[data-icon]').getAttribute('data-icon') : '');

            const isAddText = txt.includes('add member') || txt.includes('add participant') || txt.includes('add members') || txt.includes('añadir participante') || txt.includes('añadir miembro') || txt.includes('agregar participante');
            const isAddIcon = icon === 'person-add' || icon === 'add-user' || icon === 'user-add';

            return isAddText || isAddIcon;
        });

        if (target) {
            try { target.click(); return true; } catch(e) {}
        }
        return false;
    });

    if (!addBtnClicked) {
        console.warn(`        ↳ [UI WHATSAPP] No se localizó el botón 'Add member / Añadir participante' en el panel de información del grupo.`);
        return { status: 'add_button_not_found' };
    }

    await new Promise(r => setTimeout(r, 2000));

    // 3. Escribir el número de teléfono en el buscador del cuadro modal emergente
    const modalInputHandle = await page.$('div[role="dialog"] div[contenteditable="true"], div[role="dialog"] input, div[contenteditable="true"]');
    if (!modalInputHandle) {
        console.warn(`        ↳ [UI WHATSAPP] No se abrió el cuadro modal emergente para buscar contactos.`);
        return { status: 'modal_not_opened' };
    }

    await modalInputHandle.click();
    await page.keyboard.type(phone, { delay: 60 });
    await new Promise(r => setTimeout(r, 2000));

    // 4. Seleccionar el contacto devuelto en la lista del modal
    const contactSelected = await page.evaluate((targetPhone) => {
        const dialog = document.querySelector('div[role="dialog"]') || document.body;
        const items = Array.from(dialog.querySelectorAll('div[role="listitem"], div[role="option"], div[tabindex]'));
        
        for (const item of items) {
            const txt = item.innerText || '';
            const last9 = targetPhone.length >= 9 ? targetPhone.slice(-9) : targetPhone;
            if (txt.includes(last9) || txt.includes('Add') || txt.includes('Añadir')) {
                try { item.click(); return true; } catch(e) {}
            }
        }
        return false;
    }, phone);

    if (!contactSelected) {
        console.warn(`        ↳ [UI WHATSAPP] El número ${phone} no apareció en los resultados del cuadro modal.`);
        await page.keyboard.press('Escape');
        return { status: 'contact_not_found_in_modal' };
    }

    await new Promise(r => setTimeout(r, 1500));

    // 5. Confirmar haciendo clic en el check verde de enviar
    const confirmedCheck = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]') || document.body;
        const confirmBtn = dialog.querySelector('span[data-icon="checkmark-medium"], span[data-icon="send"], span[data-icon="check"], div[aria-label*="Confirm"], div[role="button"][title*="Add"], button');
        if (confirmBtn) {
            try { confirmBtn.click(); return true; } catch(e) {}
        }
        return false;
    });

    if (!confirmedCheck) {
        await page.keyboard.press('Enter');
    }

    await new Promise(r => setTimeout(r, 2000));

    // 6. Confirmar en el modal secundario de 'Add member?'
    await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
        for (const d of dialogs) {
            const buttons = Array.from(d.querySelectorAll('button, div[role="button"]'));
            const addBtn = buttons.find(b => {
                const txt = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
                return txt.includes('add member') || txt.includes('add participant') || txt.includes('add') || txt.includes('añadir');
            });
            if (addBtn) {
                try { addBtn.click(); } catch(e) {}
            }
        }
    });

    await new Promise(r => setTimeout(r, 2000));
    return { status: 'success_ui' };
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

    // Intentar recuperar el objeto GroupChat directamente de la API de whatsapp-web.js y actualizar sus participantes
    let nativeGroupChat = null;
    try {
        const chats = await client.getChats();
        console.log(`    [DIAGNÓSTICO NATIVO] Total chats cargados en client.getChats(): ${chats.length}`);
        nativeGroupChat = chats.find(c => c.isGroup && (c.name.trim().toLowerCase().includes(targetGroupName.trim().toLowerCase()) || targetGroupName.trim().toLowerCase().includes(c.name.trim().toLowerCase())));
        if (nativeGroupChat) {
            console.log(`    ↳ [ÉXITO NATIVO] Objeto GroupChat obtenido mediante whatsapp-web.js API (ID: ${nativeGroupChat.id._serialized})`);
            try {
                if (typeof nativeGroupChat.fetchGroupMetadata === 'function') {
                    console.log(`    ↳ [NATIVO] Actualizando metadatos del grupo desde WhatsApp API...`);
                    await nativeGroupChat.fetchGroupMetadata();
                }
            } catch (fe) {}
        }
    } catch (e) {
        console.warn('    ↳ Advertencia obteniendo chats nativos:', e.message);
    }

    // Abrir específicamente la cabecera del chat activo (#main header) para desplegar el panel derecho de Group Info
    try {
        await page.evaluate(() => {
            const groupHeader = document.querySelector('#main header div[role="button"], #main header span[title], #main header');
            if (groupHeader) {
                try { groupHeader.click(); } catch(e) {}
            }
        });
        await new Promise(r => setTimeout(r, 2000));
    } catch (e) {}

    // Extraer participantes visibles en el DOM del panel derecho
    const domParticipants = await page.evaluate(() => {
        const set = new Set();
        const rightPane = document.querySelector('#main + div, div[role="region"]') || document.body;
        const nodes = rightPane.querySelectorAll('span, div, p');
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

    console.log(`    ↳ Participantes detectados en la interfaz visual del panel derecho: ${domParticipants.length}`);

    // Combinar participantes nativos si están disponibles
    let allParticipants = domParticipants.map(jid => ({ id: { _serialized: jid } }));
    if (nativeGroupChat && nativeGroupChat.participants) {
        const nativeP = nativeGroupChat.participants.map(p => ({ id: { _serialized: p.id._serialized || `${p.id.user}@c.us` } }));
        const combinedSet = new Set([
            ...domParticipants,
            ...nativeP.map(p => p.id._serialized)
        ]);
        allParticipants = Array.from(combinedSet).map(jid => ({ id: { _serialized: jid } }));
    }

    return {
        name: targetGroupName,
        isGroup: true,
        id: { _serialized: nativeGroupChat ? nativeGroupChat.id._serialized : `${targetGroupName}@g.us` },
        participants: allParticipants,
        addParticipants: async (jids) => {
            // 1. Probar método nativo de whatsapp-web.js
            if (nativeGroupChat && typeof nativeGroupChat.addParticipants === 'function') {
                try {
                    console.log(`        ↳ Intentando adición mediante API nativa whatsapp-web.js...`);
                    const res = await nativeGroupChat.addParticipants(jids);
                    if (res && (Array.isArray(res) || res.status === '200' || res.status === 200)) {
                        return { status: 'success_native', response: res };
                    }
                } catch (ne) {
                    console.warn(`        ↳ Fallo en API nativa, ejecutando automatización visual UI:`, ne.message);
                }
            }

            // 2. Ejecutar automatización visual UI en Puppeteer
            const phone = jids[0].replace(/\D/g, '');
            return await añadirParticipantePorUI(page, phone);
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
        const grupo = await buscarGrupoPorNombreSeguro(client, GROUP_NAME);

        if (!grupo) {
            console.error(`\n[ERROR CRÍTICO] No se encontró el grupo "${GROUP_NAME}". Verifique el nombre en .env`);
            await client.destroy();
            process.exit(1);
        }

        console.log(`Grupo encontrado: "${grupo.name}" (ID: ${grupo.id._serialized})`);

        const participantesActuales = new Set(
            grupo.participants.map(p => p.id._serialized)
        );
        console.log(`Participantes detectados en el grupo: ${participantesActuales.size}\n`);

        console.log('--- INICIANDO PROCESAMIENTO DE CONTACTOS ---\n');

        for (let i = 0; i < contactos.length; i++) {
            const contacto = contactos[i];
            const prefixLog = `[${i + 1}/${contactos.length}]`;

            console.log(`${prefixLog} Procesando tutor: ${contacto.whatsappName} (${contacto.phone})`);

            if (SYNC_GOOGLE_CONTACTS && googleAuthClient) {
                const resGoogle = await sincronizarContactoGoogle({
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
                        const isSuccess = result && (result.status === 'success_ui' || result.status === 'success_native' || Array.isArray(result));

                        if (isSuccess) {
                            console.log(`        ↳ [ÉXITO WHATSAPP] Añadido correctamente. Respuesta:`, JSON.stringify(result));
                            stats.añadidosWhatsApp++;
                        } else {
                            console.warn(`        ↳ [FALLO WHATSAPP] No se pudo añadir el contacto a WhatsApp. Resultado:`, JSON.stringify(result));
                            stats.fallidosWhatsApp++;
                        }
                    } catch (err) {
                        console.error(`        ↳ [ERROR WHATSAPP] No se pudo añadir a ${contacto.phone}:`, err.message);
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
