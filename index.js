require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Cargar variables de entorno con valores por defecto
const GROUP_NAME = process.env.GROUP_NAME || 'Nombre De Tu Grupo';
const CSV_PATH = path.resolve(process.env.CSV_PATH || './contactos.csv');
const PHONE_COLUMN = process.env.PHONE_COLUMN || 'telefono';
const NAME_COLUMN = process.env.NAME_COLUMN || 'nombre';
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '34';
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_MS || '5000', 10);
const MAX_DELAY_MS = parseInt(process.env.MAX_DELAY_MS || '10000', 10);
const IS_DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

/**
 * Genera una pausa aleatoria entre min y max milisegundos para simular comportamiento humano
 */
function randomDelay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normaliza un teléfono a formato internacional de WhatsApp (ej: "34612345678")
 */
function normalizarTelefono(rawPhone) {
    if (!rawPhone) return null;

    // Eliminar todo lo que no sea dígito
    let clean = rawPhone.toString().replace(/\D/g, '');

    if (!clean) return null;

    // Si el número tiene 9 dígitos (formato local en España u otros países), anteponer prefijo por defecto
    if (clean.length === 9 && DEFAULT_COUNTRY_CODE) {
        clean = `${DEFAULT_COUNTRY_CODE}${clean}`;
    }

    return clean;
}

/**
 * Lee el archivo CSV y retorna la lista de contactos normalizados
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
                const nombre = row[NAME_COLUMN] || 'Sin nombre';

                const phoneNorm = normalizarTelefono(rawPhone);
                if (phoneNorm) {
                    contactos.push({
                        nombre,
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

// Inicializar cliente de WhatsApp Web con persistencia de sesión local
const client = new Client({
    authStrategy: new LocalAuth(),
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
        console.log('*** MODO SIMULACIÓN (--dry-run) ACTIVADO: No se añadirán contactos reales ***\n');
    }

    let stats = {
        totalCSV: 0,
        yaEnGrupo: 0,
        añadidos: 0,
        fallidos: 0
    };

    try {
        // 1. Cargar contactos desde CSV
        console.log(`Cargando contactos desde CSV (${CSV_PATH})...`);
        const contactos = await cargarContactosDesdeCSV(CSV_PATH);
        stats.totalCSV = contactos.length;
        console.log(`Se encontraron ${contactos.length} contactos válidos en el CSV.\n`);

        // 2. Buscar el grupo de WhatsApp por su nombre
        console.log(`Buscando grupo: "${GROUP_NAME}"...`);
        const chats = await client.getChats();
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

            // Comprobar si el contacto ya pertenece al grupo
            if (participantesActuales.has(contacto.jid)) {
                console.log(`${prefixLog} [OMITIDO] ${contacto.nombre} (${contacto.phone}) ya es miembro del grupo.`);
                stats.yaEnGrupo++;
                continue;
            }

            console.log(`${prefixLog} [AÑADIENDO] ${contacto.nombre} (${contacto.phone}) no pertenece al grupo.`);

            if (IS_DRY_RUN) {
                console.log(`    ↳ [SIMULACIÓN] Se añadiría ${contacto.jid} al grupo.`);
                stats.añadidos++;
            } else {
                try {
                    const result = await grupo.addParticipants([contacto.jid]);
                    console.log(`    ↳ [ÉXITO] Añadido correctamente. Respuesta:`, JSON.stringify(result));
                    stats.añadidos++;
                } catch (err) {
                    console.error(`    ↳ [ERROR] No se pudo añadir a ${contacto.phone}:`, err.message);
                    stats.fallidos++;
                }
            }

            // Aplicar retardo aleatorio entre adiciones (salvo en la última vuelta)
            if (i < contactos.length - 1) {
                const delaySec = Math.round((MIN_DELAY_MS + MAX_DELAY_MS) / 2000);
                console.log(`    ... esperando ~${delaySec}s para prevenir bloqueo de cuenta ...\n`);
                await randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
            }
        }

        console.log('\n======================================================');
        console.log(' RESUMEN FINAL DEL PROCESO');
        console.log('======================================================');
        console.log(` Total contactos en CSV:        ${stats.totalCSV}`);
        console.log(` Omitidos (Ya en el grupo):    ${stats.yaEnGrupo}`);
        console.log(` Añadidos con éxito:           ${stats.añadidos}`);
        console.log(` Fallidos / Error:             ${stats.fallidos}`);
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
