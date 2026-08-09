const fs = require('fs');
const http = require('http');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/contacts'];

/**
 * Carga las credenciales de OAuth2 y obtiene el cliente de Google People API
 */
async function getAuthenticatedClient(credentialsPath, tokenPath) {
    if (!fs.existsSync(credentialsPath)) {
        throw new Error(
            `No se encontró el archivo de credenciales de Google en "${credentialsPath}". ` +
            `Por favor, descarga credentials.json desde Google Cloud Console.`
        );
    }

    const content = fs.readFileSync(credentialsPath, 'utf8');
    const credentials = JSON.parse(content);
    const keys = credentials.installed || credentials.web;

    if (!keys) {
        throw new Error('El archivo credentials.json no contiene una clave válida de "installed" o "web".');
    }

    let redirectUri = 'http://localhost:3000/oauth2callback';
    if (keys.redirect_uris && keys.redirect_uris.length > 0) {
        const validUri = keys.redirect_uris.find(u => !u.includes('urn:ietf:wg:oauth:2.0:oob'));
        if (validUri) {
            redirectUri = validUri;
        } else {
            redirectUri = keys.redirect_uris[0];
        }
    }

    const oAuth2Client = new google.auth.OAuth2(
        keys.client_id,
        keys.client_secret,
        redirectUri
    );

    if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf8');
        oAuth2Client.setCredentials(JSON.parse(token));
        return oAuth2Client;
    }

    return await getNewToken(oAuth2Client, tokenPath, redirectUri);
}

/**
 * Obtiene un nuevo token de acceso iniciando un servidor HTTP local
 */
function getNewToken(oAuth2Client, tokenPath, redirectUri) {
    return new Promise((resolve, reject) => {
        let server;
        let port = 3000;

        try {
            const parsed = new URL(redirectUri);
            if (parsed.port) port = parseInt(parsed.port, 10);
        } catch (e) {}

        server = http.createServer((req, res) => {
            try {
                const reqUrl = new URL(req.url, `http://localhost:${port}`);
                const code = reqUrl.searchParams.get('code');
                const error = reqUrl.searchParams.get('error');

                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h1>Error de autenticación</h1><p>' + error + '</p>');
                    server.close();
                    return reject(new Error(`Autorización denegada por Google: ${error}`));
                }

                if (code) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h1>Autenticación completada con éxito</h1><p>Ya puedes cerrar esta pestaña del navegador y volver a la consola.</p>');
                    server.close();

                    oAuth2Client.getToken(code, (err, token) => {
                        if (err) {
                            console.error('Error al recuperar el token de acceso de Google:', err);
                            return reject(err);
                        }
                        oAuth2Client.setCredentials(token);
                        fs.writeFileSync(tokenPath, JSON.stringify(token));
                        console.log(`Token guardado con éxito en "${tokenPath}".\n`);
                        resolve(oAuth2Client);
                    });
                }
            } catch (e) {
                if (server) server.close();
                reject(e);
            }
        });

        server.listen(port, () => {
            const authUrl = oAuth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: SCOPES,
                prompt: 'consent'
            });

            console.log('\n======================================================');
            console.log(' AUTORIZACIÓN DE GOOGLE CONTACTS REQUERIDA');
            console.log('======================================================');
            console.log('Abre la siguiente URL en tu navegador para autorizar la aplicación:\n');
            console.log(authUrl);
            console.log('\n------------------------------------------------------');
            console.log(`Servidor de autenticación local escuchando en ${redirectUri}`);
            console.log('------------------------------------------------------\n');
        });

        server.on('error', (err) => {
            console.warn(`[ADVERTENCIA AUTH] No se pudo iniciar el servidor local en el puerto ${port}:`, err.message);
            console.log('Cambiando a modo de entrada manual por consola...');

            const authUrl = oAuth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: SCOPES,
                prompt: 'consent'
            });

            console.log(authUrl);
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            rl.question('Introduce el código de autorización obtenido: ', (code) => {
                rl.close();
                oAuth2Client.getToken(code.trim(), (err, token) => {
                    if (err) return reject(err);
                    oAuth2Client.setCredentials(token);
                    fs.writeFileSync(tokenPath, JSON.stringify(token));
                    resolve(oAuth2Client);
                });
            });
        });
    });
}

/**
 * Normaliza un número de teléfono dejando únicamente dígitos
 */
function soloDigitos(phone) {
    return phone ? phone.toString().replace(/\D/g, '') : '';
}

/**
 * Obtiene los últimos 9 dígitos de un número de teléfono para coincidencias flexibles
 */
function ultimos9Digitos(phone) {
    const digits = soloDigitos(phone);
    return digits.length >= 9 ? digits.slice(-9) : digits;
}

/**
 * Carga todos los contactos de la cuenta de Google en memoria e indexa por dígitos completos y últimos 9 dígitos
 */
async function cargarMapaContactosGoogle(authClient) {
    const service = google.people({ version: 'v1', auth: authClient });
    const phoneMap = new Map();
    let pageToken = undefined;
    let totalContactos = 0;

    try {
        do {
            const res = await service.people.connections.list({
                resourceName: 'people/me',
                pageSize: 1000,
                personFields: 'names,phoneNumbers',
                pageToken: pageToken
            });

            const connections = res.data.connections || [];
            totalContactos += connections.length;

            for (const person of connections) {
                const phoneNumbers = person.phoneNumbers || [];
                phoneNumbers.forEach(p => {
                    const digits = soloDigitos(p.value);
                    const last9 = ultimos9Digitos(p.value);
                    if (digits) {
                        phoneMap.set(digits, person);
                    }
                    if (last9 && last9.length === 9) {
                        phoneMap.set(last9, person);
                    }
                });
            }
            pageToken = res.data.nextPageToken;
        } while (pageToken);

        console.log(`    ↳ [GOOGLE CONTACTS] ${totalContactos} contactos y ${phoneMap.size} índices de teléfono cargados en memoria.`);
    } catch (e) {
        console.warn(`    ↳ [ADVERTENCIA GOOGLE] No se pudo precargar la lista de conexiones:`, e.message);
    }

    return { service, phoneMap };
}

/**
 * Sincroniza un contacto en Google Contacts:
 * 1. Comprueba en el mapa en memoria por dígitos completos y por los últimos 9 dígitos.
 * 2. Si existe -> actualiza su nombre al formato `Nombre tutor - Nombre Apellidos (Equipos)`.
 * 3. Si no existe -> crea un nuevo contacto con dicho nombre y teléfono.
 */
async function sincronizarContactoGoogle({
    authClient,
    googleContext,
    phone,
    formattedName,
    isDryRun = false
}) {
    const targetDigits = soloDigitos(phone);
    const targetLast9 = ultimos9Digitos(phone);
    const service = (googleContext && googleContext.service) ? googleContext.service : google.people({ version: 'v1', auth: authClient });
    const phoneMap = (googleContext && googleContext.phoneMap) ? googleContext.phoneMap : null;

    if (!targetDigits) {
        console.warn(`    ↳ [OMITIDO GOOGLE] Teléfono no válido para sincronización:`, phone);
        return { action: 'skipped', reason: 'invalid_phone' };
    }

    try {
        let existingContact = null;

        // 1. Coincidencia por teléfono exacto o por los últimos 9 dígitos en el mapa en memoria
        if (phoneMap) {
            existingContact = phoneMap.get(targetDigits) || (targetLast9 ? phoneMap.get(targetLast9) : null);
        }

        // 2. Fallback a la API de búsqueda usando los últimos 9 dígitos
        if (!existingContact) {
            const querySearch = targetLast9.length === 9 ? targetLast9 : phone;
            const searchRes = await service.people.searchContacts({
                query: querySearch,
                readMask: 'names,phoneNumbers',
            });

            const matches = searchRes.data.results || [];
            for (const match of matches) {
                const person = match.person;
                const phoneNumbers = person.phoneNumbers || [];
                const hasPhoneMatch = phoneNumbers.some(p => {
                    const digits = soloDigitos(p.value);
                    const pLast9 = ultimos9Digitos(p.value);
                    return (digits && digits === targetDigits) || (pLast9 && pLast9 === targetLast9);
                });

                if (hasPhoneMatch) {
                    existingContact = person;
                    break;
                }
            }
        }

        if (existingContact) {
            const currentNameObj = existingContact.names && existingContact.names[0];
            const currentName = currentNameObj ? currentNameObj.displayName : '';

            if (currentName === formattedName) {
                console.log(`    ↳ [OMITIDO GOOGLE] Contacto (${phone}) ya tiene el nombre al día: "${formattedName}".`);
                return { action: 'updated_skipped', resourceName: existingContact.resourceName };
            }

            console.log(`    ↳ [MODIFICANDO GOOGLE] Contacto existente (${currentName || phone}). Cambiando nombre a: "${formattedName}"...`);

            if (isDryRun) {
                console.log(`        ↳ [SIMULACIÓN GOOGLE] Se actualizaría el contacto a "${formattedName}".`);
                return { action: 'simulated_update', resourceName: existingContact.resourceName };
            }

            const updateRes = await service.people.updateContact({
                resourceName: existingContact.resourceName,
                updatePersonFields: 'names',
                requestBody: {
                    etag: existingContact.etag,
                    names: [
                        {
                            givenName: formattedName
                        }
                    ]
                }
            });

            console.log(`        ↳ [ÉXITO GOOGLE] Nombre actualizado correctamente.`);
            return { action: 'updated', resourceName: updateRes.data.resourceName };
        } else {
            console.log(`    ↳ [CREANDO GOOGLE] Contacto (${phone}) no existe. Creando: "${formattedName}"...`);

            if (isDryRun) {
                console.log(`        ↳ [SIMULACIÓN GOOGLE] Se crearía el contacto "${formattedName}" (+${phone}).`);
                return { action: 'simulated_create' };
            }

            const createRes = await service.people.createContact({
                requestBody: {
                    names: [
                        {
                            givenName: formattedName
                        }
                    ],
                    phoneNumbers: [
                        {
                            value: `+${phone}`
                        }
                    ]
                }
            });

            console.log(`        ↳ [ÉXITO GOOGLE] Contacto creado correctamente en Google Contacts.`);
            return { action: 'created', resourceName: createRes.data.resourceName };
        }

    } catch (error) {
        console.error(`    ↳ [ERROR GOOGLE] Fallo al sincronizar ${phone}:`, error.message);
        return { action: 'error', error: error.message };
    }
}

module.exports = {
    getAuthenticatedClient,
    cargarMapaContactosGoogle,
    sincronizarContactoGoogle
};
