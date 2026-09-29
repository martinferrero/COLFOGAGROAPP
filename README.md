# COLFOG Agro · app de registro (fase 1)

App web instalable en el celular para registrar jornadas, trabajos y gastos de la línea de drones. Funciona sin señal y sube los datos sola cuando vuelve la conexión.

## 1. Base de datos (una sola vez)
1. Supabase → **SQL Editor → New query** → pega `supabase/schema.sql` → **Run**.
2. Supabase → **Authentication → Sign In / Providers** → desactiva **Allow new users to sign up** (solo COLFOG crea usuarios).
3. Supabase → **Authentication → Users → Add user → Create new user**. Crea uno por persona con correo y clave, marcando **Auto Confirm User**.
4. **SQL Editor**: asigna roles (cambia los correos):

```sql
update perfiles set rol = 'admin',  nombre = 'Martin Ferrero'
  where id = (select id from auth.users where email = 'martinferrero@colfog.com');
update perfiles set rol = 'aliado', nombre = 'Martin Ruiz Jaramillo'
  where id = (select id from auth.users where email = 'CORREO_MARTIN_RUIZ');
update perfiles set rol = 'piloto', nombre = 'Andrés Mauricio Campiño'
  where id = (select id from auth.users where email = 'CORREO_ANDRES');
update drones set aliado_id = (select id from auth.users where email = 'CORREO_MARTIN_RUIZ')
  where id = 'T50';
```

## 2. Publicar en GitHub Pages
1. GitHub → **New repository** → nombre `colfog-agro` → Public → Create.
2. **Add file → Upload files** → arrastra todo el contenido de esta carpeta (`index.html`, `app.js`, `style.css`, `config.js`, `sw.js`, `manifest.webmanifest`, carpetas `vendor` e `icons`) → **Commit**.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main` / `(root)` → Save.
4. En 1–2 minutos queda en `https://TU_USUARIO.github.io/colfog-agro/`.

## 3. Instalar en el celular
- **iPhone (Safari):** abrir el enlace → botón Compartir → **Agregar a inicio**.
- **Android (Chrome):** abrir el enlace → menú ⋮ → **Instalar app**.
- Ingresar una vez con señal. Después abre y registra aunque no haya señal.

## Roles
| Rol | Ve | Registra |
|---|---|---|
| admin | Todo, precios, aprueba gastos | Jornadas, trabajos, gastos de ambos drones, mapeos |
| aliado | Solo T50 y precios | Jornadas, lecturas, trabajos y gastos del T50 |
| piloto | Sin precios ni dinero de otros | Jornadas, trabajos y sus gastos |

## Actualizar la app
Sube los archivos cambiados al repositorio. Al cambiar de versión, sube también `sw.js` con la nueva `VERSION` para que los celulares descarguen la actualización.
