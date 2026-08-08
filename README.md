# WassAPI - Añadir Contactos a Grupo de WhatsApp desde CSV

Script en Node.js que permite añadir contactos procedentes de un archivo CSV a un grupo existente de WhatsApp. Antes de añadir un contacto, el script comprueba automáticamente si ya forma parte del grupo para **evitar duplicados** y aplica pausas aleatorias para **prevenir baneos por spam**.

---

## 📋 Requisitos Previos

1. **Node.js**: Versión 16 o superior (`node -v`).
2. **Cuenta de WhatsApp en un teléfono móvil**: La cuenta utilizada debe ser **Administradora** del grupo donde se van a incorporar los contactos.

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
CSV_PATH="./contactos.csv"

# Nombre de la columna en el CSV que tiene el teléfono
PHONE_COLUMN="telefono"

# Nombre de la columna opcional en el CSV que tiene el nombre
NAME_COLUMN="nombre"

# Prefijo de país por defecto si el número no lo incluye (34 = España)
DEFAULT_COUNTRY_CODE="34"

# Pausas en milisegundos entre contactos (Anti-spam / Anti-baneo)
MIN_DELAY_MS=5000
MAX_DELAY_MS=10000
```

---

## 📄 Formato del archivo CSV (`contactos.csv`)

El archivo CSV debe contener al menos la columna especificada en `PHONE_COLUMN` (por defecto `telefono`). Los números de teléfono se normalizan automáticamente (se eliminan espacios, guiones y el símbolo `+`).

Ejemplo de `contactos.csv`:
```csv
nombre,telefono
Juan Perez,+34612345678
Maria Gomez,34699887766
Carlos Lopez,600112233
```

---

## 💻 Modo de Uso

### Modo Prueba (Dry Run - Sin realizar cambios reales)
Puedes probar el comportamiento del script sin modificar el grupo ejecutando:
```bash
npm run dry-run
```

### Modo Producción (Añadir contactos reales)
Ejecuta el script principal:
```bash
npm start
```

1. Se mostrará un **código QR** en la terminal.
2. Abre WhatsApp en tu móvil -> **Ajustes / Menú** -> **Dispositivos vinculados** -> **Vincular un dispositivo**.
3. Escanea el código QR de la terminal. La sesión se guardará localmente en `.wwebjs_auth` para no requerir escaneo en futuras ejecuciones.
4. El script leerá el grupo, verificará qué números ya existen y añadirá solo los nuevos.

---

## ⚠️ Buenas Prácticas y Advertencias

- **Permisos**: Debes ser **Administrador** del grupo. Si no lo eres, la adición de miembros fallará.
- **Riesgo de Baneo / Anti-Spam**: No reduzcas demasiado las pausas (`MIN_DELAY_MS` y `MAX_DELAY_MS`). WhatsApp monitorea comportamientos automatizados rápidos.
- **Privacidad del destinatario**: Si la persona a la que estás añadiendo tiene en su privacidad configurado que solo sus contactos pueden añadirle a grupos, WhatsApp enviará una invitación privada por chat en lugar de incorporarla directamente.
