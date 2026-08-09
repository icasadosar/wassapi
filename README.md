# WassAPI - Añadir Contactos a Grupo de WhatsApp desde CSV

Script en Node.js que permite añadir contactos procedentes de un archivo CSV a un grupo existente de WhatsApp. Antes de añadir un contacto, el script comprueba automáticamente si ya forma parte del grupo para **evitar duplicados** y aplica pausas aleatorias para **prevenir baneos por spam**.

Además, incluye la funcionalidad opcional de **sincronizar con Google Contacts**: busca el teléfono en tu agenda de Google, modifica el nombre si ya existe o lo crea si no existe con la estructura `Nombre tutor - Nombre Apellidos (Equipos)`.

---

## 📋 Requisitos Previos

1. **Node.js**: Versión 16 o superior (`node -v`).
2. **Cuenta de WhatsApp en un teléfono móvil**: La cuenta utilizada debe ser **Administradora** del grupo donde se van a incorporar los contactos.
3. *(Opcional)* **Google Cloud OAuth 2.0 Credentials**: Para habilitar la sincronización con Google Contacts.

---

## 🚀 Instalación y Configuración

### 1. Instalar dependencias
En la terminal, dentro de la carpeta del proyecto, ejecuta:
```bash
npm install
```

### 2. Configurar variables de entorno (`.env`)
Edita el archivo `.env` para especificar el nombre de tu grupo y la ruta de tu archivo CSV:

```env
# Nombre exacto del grupo en tu aplicación de WhatsApp
GROUP_NAME="Nombre De Tu Grupo"

# Ruta del fichero CSV
CSV_PATH="./contactos_temp.csv"

# Nombre de la columna en el CSV que tiene el teléfono del tutor
PHONE_COLUMN="Teléfono tutor"

# Columnas para la composición del nombre del contacto
TUTOR_NAME_COLUMN="Nombre tutor"
PLAYER_NAME_COLUMN="Nombre"
PLAYER_SURNAME_COLUMN="Apellidos"
PLAYER_TEAM_COLUMN="Equipos"

# Prefijo de país por defecto si el número no lo incluye (34 = España)
DEFAULT_COUNTRY_CODE="34"

# Pausas en milisegundos entre contactos (Anti-spam / Anti-baneo)
MIN_DELAY_MS=5000
MAX_DELAY_MS=10000

# Sincronización Opcional con Google Contacts (false por defecto)
SYNC_GOOGLE_CONTACTS=false
GOOGLE_CREDENTIALS_PATH="./credentials.json"
GOOGLE_TOKEN_PATH="./token.json"
```

---

## 📄 Formato del archivo CSV (`contactos.example.csv`)

Ejemplo de `contactos.example.csv`:
```csv
Nombre tutor,Teléfono tutor,Nombre,Apellidos,Equipos
Juan Perez,0034600000001,Lucas,Perez Gomez,Infantil (2013-2014)
Maria Garcia,0034600000002,Ana,Martin Garcia,Infantil (2013-2014)
```

Formato del nombre generado para Google Contacts:
`Juan Perez - Lucas Perez Gomez (Infantil (2013-2014))`

---

## 📇 Sincronización Opcional con Google Contacts

Para activar la sincronización con Google Contacts:

1. Ve a la consola de **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com)).
2. Crea un proyecto y habilita la **Google People API**.
3. En la sección de **Pantalla de consentimiento de OAuth**, añade tu dirección de correo electrónico en la sección **Usuarios de prueba** (*Test users*).
4. En la sección de **Credenciales**, crea un ID de cliente de **OAuth 2.0** (Aplicación Web o Escritorio).
5. En las **URIs de redireccionamiento autorizados** (*Authorized redirect URIs*), añade `http://localhost:3000/oauth2callback`.
6. Descarga el archivo JSON y guárdalo en la raíz del proyecto con el nombre `credentials.json`.
7. En tu archivo `.env`, establece:
   ```env
   SYNC_GOOGLE_CONTACTS=true
   ```
   *(O ejecuta directamente `npm run dry-run:google`)*.
8. En la primera ejecución, el script iniciará un servidor de autenticación local para capturar el acceso. El token de sesión se guardará automáticamente en `token.json`.

---

## 💻 Modo de Uso

### Modo Prueba (Dry Run - Sin realizar cambios reales)
Puedes probar el comportamiento del script sin modificar el grupo de WhatsApp ni cambiar contactos de Google:
```bash
npm run dry-run
```

Para probar la simulación con Google Contacts activado:
```bash
npm run dry-run:google
```

### Modo Producción (Añadir contactos reales)
Para ejecutar la sincronización real de WhatsApp:
```bash
npm start
```

Para ejecutar la sincronización real de WhatsApp **y Google Contacts**:
```bash
npm run start:google
```

---

## ⚠️ Buenas Prácticas y Advertencias

- **Permisos**: Debes ser **Administrador** del grupo en WhatsApp.
- **Riesgo de Baneo / Anti-Spam**: No reduzcas demasiado las pausas (`MIN_DELAY_MS` y `MAX_DELAY_MS`).
- **Seguridad**: `credentials.json`, `token.json`, `.env` y las sesiones locales están añadidos al `.gitignore` para no subirse a GitHub.
