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
 * Inyecta y expone la API interna de Store de WhatsApp mediante el chunk de Webpack
 */
async function inyectarStoreWhatsApp(page) {
    try {
        await page.evaluate(() => {
            if (window.Store && window.Store.GroupParticipants && window.Store.GroupParticipants.addParticipants) return;
            try {
                if (window.webpackChunkwhatsapp_web_client) {
                    window.webpackChunkwhatsapp_web_client.push([
                        ['antigravity_store_loader'],
                        {},
                        (require) => {
                            const modules = require.m;
                            window.Store = window.Store || {};
                            for (const id in modules) {
                                try {
                                    const mod = require(id);
                                    if (!mod) continue;
                                    if (mod.default && typeof mod.default.addParticipants === 'function') {
                                        window.Store.GroupParticipants = mod.default;
                                    }
                                    if (mod.Chat && mod.UserConstructor) {
                                        Object.assign(window.Store, mod);
                                    }
                                } catch (e) {}
                            }
                        }
                    ]);
                }
            } catch (e) {}
        });
    } catch (e) {}
}

/**
 * Realiza un clic de ratón físico nativo utilizando Chrome DevTools Protocol (CDP)
 */
async function hacerClicFisicoCDP(page, evaluatorFn, ...args) {
    try {
        const box = await page.evaluate(evaluatorFn, ...args);
        if (box && box.width > 0 && box.height > 0) {
            const x = Math.round(box.x + box.width / 2);
            const y = Math.round(box.y + box.height / 2);
            await page.mouse.move(x, y);
            await new Promise(r => setTimeout(r, 100));
            await page.mouse.click(x, y);
            return true;
        }
    } catch (e) {
        console.error('        ↳ [ERROR CDP]', e);
    }
    return false;
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
 * Añade un contacto al grupo abierto mediante la interfaz gráfica de WhatsApp Web y clics de ratón nativos CDP
 */
async function añadirParticipantePorUI(page, phone, contactoOrName = '') {
    const tutorName = typeof contactoOrName === 'object' ? (contactoOrName.tutor || contactoOrName.whatsappName || '') : contactoOrName;
    const googleName = typeof contactoOrName === 'object' ? (contactoOrName.googleName || '') : '';
    const player = typeof contactoOrName === 'object' ? (contactoOrName.player || '') : '';
    const surname = typeof contactoOrName === 'object' ? (contactoOrName.surname || '') : '';

    console.log(`        ↳ [UI WHATSAPP] Verificando panel de información del grupo activo...`);

    // 1. Verificar si el panel de info ya está abierto; si no, desplegarlo haciendo clic en el título de la cabecera
    const panelAlreadyOpen = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('div[role="region"], div[tabindex="-1"], div'));
        return elements.some(el => {
            const rect = el.getBoundingClientRect();
            const txt = (el.innerText || '').toLowerCase();
            return rect.left > 500 && (txt.includes('member') || txt.includes('participante') || txt.includes('group info') || txt.includes('info del grupo'));
        });
    });

    if (!panelAlreadyOpen) {
        console.log(`        ↳ Abriendo panel de información con clic de ratón nativo en la cabecera...`);
        const headerClicked = await hacerClicFisicoCDP(page, () => {
            const headers = Array.from(document.querySelectorAll('header'));
            const activeHeader = headers.find(h => h.getBoundingClientRect().left > 250);
            if (!activeHeader) return null;
            const titleEl = activeHeader.querySelector('span[title], div[role="button"]') || activeHeader;
            const r = titleEl.getBoundingClientRect();
            return { x: r.left, y: r.top, width: 40, height: r.height };
        });

        if (!headerClicked) {
            await page.evaluate(() => {
                const headers = Array.from(document.querySelectorAll('header'));
                const activeHeader = headers.find(h => h.getBoundingClientRect().left > 250);
                if (activeHeader) {
                    const titleEl = activeHeader.querySelector('span[title]') || activeHeader;
                    titleEl.click();
                }
            });
        }
        await new Promise(r => setTimeout(r, 2500));
    } else {
        console.log(`        ↳ El panel de información del grupo ya se encuentra desplegado.`);
    }

    // 2. Localizar, desplazar a la vista y hacer clic en el botón 'Add members' / 'Add member'
    let addBtnOpened = false;
    for (let attempt = 0; attempt < 5; attempt++) {
        const clickCoords = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"], div[role="group"] div, div[tabindex]'));
            const target = buttons.find(b => {
                const rect = b.getBoundingClientRect();
                if (rect.left < 450) return false;

                const txt = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase().trim();
                const iconEl = b.querySelector('span[data-icon]');
                const icon = iconEl ? iconEl.getAttribute('data-icon') : (b.getAttribute('data-icon') || '');

                const isAddText = txt === 'add members' || txt === 'add member' || txt.includes('add member') || txt.includes('add members') || txt.includes('añadir participante') || txt.includes('añadir miembros') || txt.includes('agregar');
                const isAddIcon = icon === 'person-add' || icon === 'add-user' || icon === 'user-add' || icon === 'plus';

                return isAddText || isAddIcon;
            });

            if (target) {
                try {
                    target.scrollIntoView({ block: 'center', behavior: 'instant' });
                    target.click();
                    const r = target.getBoundingClientRect();
                    return { x: r.left, y: r.top, width: r.width, height: r.height };
                } catch(e) {}
            }
            return null;
        });

        if (clickCoords) {
            await page.mouse.move(clickCoords.x + clickCoords.width / 2, clickCoords.y + clickCoords.height / 2);
            await new Promise(r => setTimeout(r, 100));
            await page.mouse.click(clickCoords.x + clickCoords.width / 2, clickCoords.y + clickCoords.height / 2);

            const modalOpened = await page.waitForSelector('div[role="dialog"]', { timeout: 3000 }).then(() => true).catch(() => false);
            if (modalOpened) {
                addBtnOpened = true;
                break;
            }
        }

        await new Promise(r => setTimeout(r, 1000));
    }

    if (!addBtnOpened) {
        console.warn(`        ↳ [UI WHATSAPP] No se localizó o no se pudo abrir el modal 'Add members' desde el panel desplegado.`);
        return { status: 'add_button_not_found' };
    }

    await new Promise(r => setTimeout(r, 1500));

    // 3. Escribir términos de búsqueda estrictamente dentro del cuadro modal emergente (div[role="dialog"])
    const modalInputHandle = await page.$('div[role="dialog"] div[contenteditable="true"], div[role="dialog"] input');
    if (!modalInputHandle) {
        console.warn(`        ↳ [UI WHATSAPP] No se localizó el campo de entrada dentro del cuadro modal emergente.`);
        return { status: 'modal_not_opened' };
    }

    const searchTerms = [
        phone,
        phone.length >= 9 ? phone.slice(-9) : phone,
        `+${phone}`,
        tutorName,
        googleName,
        player,
        surname
    ].filter(Boolean);

    let contactSelected = false;

    for (const term of searchTerms) {
        // Clic físico en la caja de búsqueda del modal para situar el foco del cursor
        await hacerClicFisicoCDP(page, () => {
            const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
            if (dialogs.length === 0) return null;
            const dialog = dialogs[dialogs.length - 1];
            const input = dialog.querySelector('div[contenteditable="true"], input');
            if (!input) return null;
            const r = input.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        });
        await new Promise(r => setTimeout(r, 200));

        // Limpiar el texto con execCommand nativo de edición de navegador
        await page.evaluate(() => {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
        });
        await new Promise(r => setTimeout(r, 150));

        // Escribir el término de búsqueda carácter por carácter con retraso simulado
        await page.keyboard.type(term, { delay: 60 });
        await new Promise(r => setTimeout(r, 2500));

        // Diagnóstico detallado del modal tras buscar el término
        const searchDiag = await page.evaluate((t) => {
            const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
            if (dialogs.length === 0) return { error: 'no_dialog' };
            const dialog = dialogs[dialogs.length - 1];
            const elems = Array.from(dialog.querySelectorAll('div, span, li, p'));
            const matches = elems.map(e => ({
                txt: (e.innerText || '').trim().slice(0, 80).replace(/\n/g, ' '),
                role: e.getAttribute('role') || '',
                aria: e.getAttribute('aria-label') || '',
                h: Math.round(e.getBoundingClientRect().height),
                w: Math.round(e.getBoundingClientRect().width)
            })).filter(e => e.txt && e.h >= 25 && e.h <= 100);
            return { term: t, textSnippet: (dialog.innerText || '').slice(0, 300).replace(/\n/g, ' | '), candidates: matches.slice(0, 10) };
        }, term);

        console.log(`        [DIAGNÓSTICO BUSCADOR "${term}"]`, JSON.stringify(searchDiag));

        // 4. Seleccionar el checkbox/item del usuario devuelto mediante clic de ratón nativo con coincidencia estricta en el checkbox izquierdo
        contactSelected = await hacerClicFisicoCDP(page, (p, t, pl) => {
            const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
            if (dialogs.length === 0) return null;
            const dialog = dialogs[dialogs.length - 1];

            const candidates = Array.from(dialog.querySelectorAll('div[role="checkbox"], div[role="listitem"], div[role="option"], div[role="button"], div[tabindex="-1"], div, label'));
            const phoneFull = p;
            const phone9 = p.length >= 9 ? p.slice(-9) : p;
            const tutorClean = t.trim().toLowerCase();
            const tutorFirstWord = tutorClean.split(' ')[0];
            const playerClean = pl.trim().toLowerCase();

            const match = candidates.find(el => {
                const rect = el.getBoundingClientRect();
                // Una fila de contacto individual en el modal de WhatsApp mide entre 30px y 100px de altura
                if (rect.height < 30 || rect.height > 100 || rect.width < 100) return false;

                const txt = (el.innerText || '').trim().toLowerCase();
                if (!txt) return false;

                // Usar igualdad exacta para no descartar contactos reales que incluyan esas palabras en su descripción
                const isExcluded = txt === 'contacts' || txt === 'contactos' || txt === 'search' || txt === 'buscar' || txt === 'add member' || txt === 'add members' || txt === 'cancel';
                if (isExcluded) return false;

                const hasPhone = txt.includes(phoneFull) || txt.includes(phone9);
                const hasTutor = (tutorClean.length >= 3 && txt.includes(tutorClean)) || (tutorFirstWord.length >= 4 && txt.includes(tutorFirstWord));
                const hasPlayer = playerClean.length >= 3 && txt.includes(playerClean);

                return hasPhone || hasTutor || hasPlayer;
            });

            if (!match) return null;

            // Intentar marcar la casilla de verificación mediante el evento de clic del DOM primero
            try {
                const cb = match.querySelector('input[type="checkbox"], div[role="checkbox"]') || match;
                cb.click();
            } catch(e) {}

            const r = match.getBoundingClientRect();
            // Retornar coordenadas concentradas en la casilla de verificación (checkbox) a la izquierda de la fila (x = left + 30)
            return { x: r.left + 20, y: r.top, width: 20, height: r.height };
        }, phone, tutorName, player);

        if (contactSelected) break;
    }

    if (!contactSelected) {
        console.warn(`        ↳ [UI WHATSAPP] El contacto (${phone}) no apareció en los resultados del cuadro modal.`);
        try {
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Escape');
        } catch(e) {}
        return { status: 'contact_not_found_in_modal' };
    }

    await new Promise(r => setTimeout(r, 1500));

    // 5. Hacer clic de ratón nativo en el botón flotante verde de confirmación (checkmark)
    const confirmedCheck = await hacerClicFisicoCDP(page, () => {
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
        if (dialogs.length === 0) return null;
        const dialog = dialogs[dialogs.length - 1];

        const confirmBtn = Array.from(dialog.querySelectorAll('div[role="button"], button, span[data-icon]')).find(el => {
            const icon = el.getAttribute('data-icon') || (el.querySelector('span[data-icon]') ? el.querySelector('span[data-icon]').getAttribute('data-icon') : '');
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            
            const isCheckIcon = icon === 'checkmark-medium' || icon === 'checkmark' || icon === 'send' || icon === 'arrow-right' || icon === 'wds-ic-send-filled';
            const isCheckAria = aria.includes('confirm') || aria.includes('add') || aria.includes('next');

            return isCheckIcon || isCheckAria;
        });

        if (!confirmBtn) return null;
        const r = confirmBtn.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    });

    await new Promise(r => setTimeout(r, 2500));

    // 6. Hacer clic de ratón nativo en la ventana emergente superpuesta final ("Add member?")
    const finalAdded = await hacerClicFisicoCDP(page, () => {
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[role="alertdialog"]'));
        if (dialogs.length === 0) return null;

        const activeDialog = dialogs[dialogs.length - 1];
        const buttons = Array.from(activeDialog.querySelectorAll('button, div[role="button"]'));

        const addBtn = buttons.find(b => {
            const txt = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase().trim();
            const isCancel = txt.includes('cancel') || txt.includes('cancelar') || txt.includes('close') || txt.includes('cerrar');
            return !isCancel && (txt.includes('add') || txt.includes('añadir') || txt.includes('agregar'));
        }) || (buttons.length >= 2 ? buttons[buttons.length - 1] : null);

        if (!addBtn) return null;
        const r = addBtn.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    });

    await new Promise(r => setTimeout(r, 3500));

    // 7. Verificación Post-Adición Estricta
    const phoneLast9 = phone.length >= 9 ? phone.slice(-9) : phone;
    const isNowPresentInDOM = await page.evaluate(async (tutor, phone9) => {
        const rightPane = Array.from(document.querySelectorAll('div')).find(d => {
            const rect = d.getBoundingClientRect();
            return rect.left > 450 && rect.width > 250 && rect.height > 400;
        });

        if (rightPane) {
            for (let s = 0; s < 6; s++) {
                rightPane.scrollTop += 300;
                await new Promise(r => setTimeout(r, 100));
            }
        }

        const text = (document.body.innerText || '').toLowerCase();
        return text.includes(tutor.toLowerCase()) || text.includes(phone9);
    }, tutorName, phoneLast9);

    // Limpieza final de modales tras el intento
    try {
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 300));
    } catch (e) {}

    if (finalAdded || isNowPresentInDOM) {
        console.log(`        ↳ [VERIFICADO] Participante verificado en la lista del grupo.`);
        return { status: 'success_ui' };
    } else {
        console.warn(`        ↳ [VERIFICACIÓN FALLIDA] La adición no se reflejó en la lista del grupo.`);
        return { status: 'verification_failed' };
    }
}

/**
 * Busca un grupo en WhatsApp Web e interactúa con él abriendo la conversación
 */
async function buscarGrupoPorNombreSeguro(client, targetGroupName) {
    const page = client.pupPage;

    await inyectarStoreWhatsApp(page);

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

    // Intentar recuperar el objeto GroupChat directamente de la API de whatsapp-web.js
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

    // Desplegar la información del grupo activo a la derecha (rect.left > 250)
    try {
        await page.evaluate(() => {
            const headers = Array.from(document.querySelectorAll('header'));
            const activeHeader = headers.find(h => h.getBoundingClientRect().left > 250);
            if (activeHeader) {
                const titleEl = activeHeader.querySelector('span[title]') || activeHeader;
                try { titleEl.click(); } catch(e) {}
            }
        });
        await new Promise(r => setTimeout(r, 2000));
    } catch (e) {}

    // Extraer tanto números como nombres de la lista de participantes en el DOM del panel derecho
    const { domParticipants, domNames } = await page.evaluate(async () => {
        const setPhone = new Set();
        const setName = new Set();
        
        const rightPane = Array.from(document.querySelectorAll('div')).find(d => {
            const rect = d.getBoundingClientRect();
            return rect.left > 450 && rect.width > 250 && rect.height > 400;
        });

        if (rightPane) {
            for (let s = 0; s < 12; s++) {
                rightPane.scrollTop += 400;
                await new Promise(r => setTimeout(r, 150));
            }
        }

        const nodes = Array.from(document.querySelectorAll('span, div, p'));
        nodes.forEach(n => {
            const txt = n.innerText ? n.innerText.trim() : '';
            if (txt) {
                if (txt.match(/^\+?\d[\d\s-]{8,}\d$/)) {
                    const clean = txt.replace(/\D/g, '');
                    if (clean.length >= 9) {
                        setPhone.add(`${clean}@c.us`);
                        setPhone.add(clean.slice(-9));
                    }
                } else if (txt.length >= 3 && txt.length < 80) {
                    setName.add(txt.toLowerCase());
                }
            }
        });
        return { domParticipants: Array.from(setPhone), domNames: Array.from(setName) };
    });

    console.log(`    ↳ Participantes detectados en panel derecho: ${domParticipants.length} teléfonos, ${domNames.length} nombres de contacto.`);

    // Combinar participantes nativos si están disponibles
    let allParticipants = domParticipants.map(jid => ({ id: { _serialized: jid.includes('@') ? jid : `${jid}@c.us` } }));
    if (nativeGroupChat && nativeGroupChat.participants) {
        const nativeP = nativeGroupChat.participants.map(p => ({ id: { _serialized: p.id._serialized || `${p.id.user}@c.us` } }));
        const combinedSet = new Set([
            ...domParticipants,
            ...nativeP.map(p => p.id._serialized)
        ]);
        allParticipants = Array.from(combinedSet).map(jid => ({ id: { _serialized: jid.includes('@') ? jid : `${jid}@c.us` } }));
    }

    const groupJid = nativeGroupChat ? nativeGroupChat.id._serialized : `${targetGroupName}@g.us`;
    const namesSet = new Set(domNames);

    return {
        name: targetGroupName,
        isGroup: true,
        id: { _serialized: groupJid },
        participants: allParticipants,
        names: namesSet,
        addParticipants: async (jids, contactoData = '') => {
            // 1. Probar la API interna de Store.GroupParticipants en el navegador
            try {
                const storeResult = await page.evaluate(async (gJid, participantJids) => {
                    try {
                        const store = window.Store;
                        if (!store) return null;

                        const chat = store.Chat ? store.Chat.get(gJid) : null;
                        if (!chat) return null;

                        const userJid = participantJids[0];
                        let user;
                        if (store.UserConstructor && store.UserConstructor.create) {
                            user = store.UserConstructor.create(userJid);
                        } else if (store.WidFactory && store.WidFactory.createWid) {
                            user = store.WidFactory.createWid(userJid);
                        } else {
                            user = userJid;
                        }

                        if (store.GroupParticipants && store.GroupParticipants.addParticipants) {
                            const res = await store.GroupParticipants.addParticipants(chat, [user]);
                            return { status: 'success_store', response: res };
                        }
                    } catch (e) {}
                    return null;
                }, groupJid, jids);

                if (storeResult && storeResult.status === 'success_store') {
                    return storeResult;
                }
            } catch (se) {}

            // 2. Probar método nativo de whatsapp-web.js
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

            // 3. Ejecutar automatización visual UI en Puppeteer mediante clics de ratón nativos CDP
            const phone = jids[0].replace(/\D/g, '');
            return await añadirParticipantePorUI(page, phone, contactoData);
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
        const nombresGrupoActuales = grupo.names || new Set();

        console.log(`Participantes detectados en el grupo: ${participantesActuales.size} por teléfono / JID y ${nombresGrupoActuales.size} nombres.\n`);

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
                participantesActuales.has(phoneLast9) ||
                Array.from(nombresGrupoActuales).some(n => {
                    const cleanN = n.trim().toLowerCase();
                    const tutorN = contacto.tutor.trim().toLowerCase();
                    const googleN = (contacto.googleName || '').trim().toLowerCase();
                    if (cleanN === tutorN) return true;
                    if (googleN && cleanN === googleN) return true;
                    if (contacto.player && cleanN.includes(tutorN) && cleanN.includes(contacto.player.toLowerCase())) return true;
                    return false;
                });

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
                        const result = await grupo.addParticipants([contacto.jid], contacto);
                        const isSuccess = result && (result.status === 'success_ui' || result.status === 'success_native' || result.status === 'success_store' || Array.isArray(result));

                        if (isSuccess) {
                            console.log(`        ↳ [ÉXITO WHATSAPP] Añadido correctamente. Respuesta:`, JSON.stringify(result));
                            stats.añadidosWhatsApp++;
                            guardarEstadoSync(contacto.phone, { googleSynced: isGoogleReady, whatsappAdded: true });
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
