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

    // Determinar la URI de redireccionamiento preferida
    let redirectUri = 'http://localhost:3000/oauth2callback';
    if (keys.redirect_uris && keys.redirect_uris.length > 0) {
        // Filtrar URIs válidas (evitando la obsoleta urn:ietf:wg:oauth:2.0:oob si es posible)
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

    // Comprobar si ya tenemos un token guardado
    if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf8');
        oAuth2Client.setCredentials(JSON.parse(token));
        return oAuth2Client;
    }

    // Si no hay token, solicitar autorización interactiva mediante servidor local
    return await getNewToken(oAuth2Client, tokenPath, redirectUri);
}

/**
 * Obtiene un nuevo token de acceso iniciando un servidor HTTP local para capturar la respuesta OAuth2
 */
function getNewToken(oAuth2Client, tokenPath, redirectUri) {
    return new Promise((resolve, reject) => {
        let server;
        let port = 3000;
        let pathname = '/oauth2callback';

        try {
            const parsed = new URL(redirectUri);
            if (parsed.port) port = parseInt(parsed.port, 10);
            if (parsed.pathname && parsed.pathname !== '/') pathname = parsed.pathname;
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
 * Sincroniza un contacto en Google Contacts:
 * 1. Busca si existe un contacto con el mismo número de teléfono.
 * 2. Si existe -> actualiza su nombre al formato `Nombre tutor - Nombre Apellidos (Equipos)`.
 * 3. Si no existe -> crea un nuevo contacto con dicho nombre y teléfono.
 */
async function sincronizarContactoGoogle({
    authClient,
    phone,
    formattedName,
    isDryRun = false
}) {
    const service = google.people({ version: 'v1', auth: authClient });
    const targetDigits = soloDigitos(phone);

    if (!targetDigits) {
        console.warn(`[GOOGLE CONTACTS] Teléfono no válido para sincronización:`, phone);
        return { action: 'skipped', reason: 'invalid_phone' };
    }

    try {
        // Buscar contactos mediante la API de búsqueda
        const searchRes = await service.people.searchContacts({
            query: phone,
            readMask: 'names,phoneNumbers',
        });

        const matches = searchRes.data.results || [];
        let existingContact = null;

        // Comprobar coincidencia exacta por dígitos de teléfono
        for (const match of matches) {
            const person = match.person;
            const phoneNumbers = person.phoneNumbers || [];
            const hasPhoneMatch = phoneNumbers.some(p => {
                const digits = soloDigitos(p.value);
                return digits.endsWith(targetDigits) || targetDigits.endsWith(digits);
            });

            if (hasPhoneMatch) {
                existingContact = person;
                break;
            }
        }

        if (existingContact) {
            const currentNameObj = existingContact.names && existingContact.names[0];
            const currentName = currentNameObj ? currentNameObj.displayName : '';

            if (currentName === formattedName) {
                console.log(`    ↳ [GOOGLE CONTACTS] El contacto (${phone}) ya tiene el nombre actualizado: "${formattedName}".`);
                return { action: 'updated_skipped', resourceName: existingContact.resourceName };
            }

            console.log(`    ↳ [GOOGLE CONTACTS] Contacto encontrado (${currentName}). Modificando nombre a: "${formattedName}"...`);

            if (isDryRun) {
                console.log(`        ↳ [SIMULACIÓN] Se actualizaría el contacto ${existingContact.resourceName}`);
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

            console.log(`        ↳ [ÉXITO GOOGLE] Nombre actualizado correctamente en Google Contacts.`);
            return { action: 'updated', resourceName: updateRes.data.resourceName };
        } else {
            console.log(`    ↳ [GOOGLE CONTACTS] Contacto (${phone}) no existe en Google Contacts. Creando nuevo contacto: "${formattedName}"...`);

            if (isDryRun) {
                console.log(`        ↳ [SIMULACIÓN] Se crearía un nuevo contacto con nombre "${formattedName}" y teléfono "+${phone}"`);
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
        console.error(`    ↳ [ERROR GOOGLE CONTACTS] Fallo al sincronizar ${phone}:`, error.message);
        return { action: 'error', error: error.message };
    }
}

module.exports = {
    getAuthenticatedClient,
    sincronizarContactoGoogle
};
