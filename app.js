/* COLFOG Agro · fase 1 (registro de jornadas, trabajos y gastos con modo sin señal) */
function mostrarFalla(msg) {
  const v = document.getElementById('view');
  if (v) v.innerHTML = '<div class="card"><h2>No se pudo abrir la app</h2><p class="note">' +
    String(msg).replace(/[<>&]/g, '') + '</p><p class="muted">Ábrela desde su enlace web (https), no como archivo del computador.</p></div>';
}
window.addEventListener('error', (e) => mostrarFalla(e.message || 'Error desconocido'));
window.addEventListener('unhandledrejection', (e) => mostrarFalla(e.reason?.message || e.reason || 'Error desconocido'));
if (!window.supabase || !window.COLFOG_CONFIG) mostrarFalla('No cargaron los archivos vendor/supabase.js o config.js.');
const CFG = window.COLFOG_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const money = (n) => COP.format(Math.round(Number(n) || 0));
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fechaLarga = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
const soloDigitos = (s) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;
const num = (s) => {
  if (s === '' || s == null) return null;
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// UUID determinístico: el mismo texto da el mismo ID en cualquier celular (evita duplicados sin señal)
async function detUUID(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('colfog:' + text));
  const b = new Uint8Array(buf).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const idJornada = (fecha) => detUUID(`jornada:${fecha}`);
const idJD = (fecha, dron) => detUUID(`jd:${fecha}:${dron}`);
const idLectura = (jdId, activoId) => detUUID(`lec:${jdId}:${activoId}`);

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const esErrorDeRed = (e) => /fetch|network|load failed|timeout|offline/i.test(String(e?.message || e));

/* ------------------------------------------------------------------ */
/* IndexedDB: cola de envíos y caché local                             */
/* ------------------------------------------------------------------ */
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('colfog-agro', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      db.createObjectStore('cache');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then((v) => (out = v));
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    });
  };
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    get: (k) => tx('cache', 'readonly', (s) => req(s.get(k))),
    set: (k, v) => tx('cache', 'readwrite', (s) => req(s.put(v, k))),
    del: (k) => tx('cache', 'readwrite', (s) => req(s.delete(k))),
    push: (item) => tx('queue', 'readwrite', (s) => req(s.add({ ...item, creado: Date.now(), error: null }))),
    all: () => tx('queue', 'readonly', (s) => req(s.getAll())),
    put: (item) => tx('queue', 'readwrite', (s) => req(s.put(item))),
    remove: (seq) => tx('queue', 'readwrite', (s) => req(s.delete(seq))),
    clear: async () => { await tx('queue', 'readwrite', (s) => req(s.clear())); await tx('cache', 'readwrite', (s) => req(s.clear())); }
  };
})();

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */
const S = {
  user: null,      // { id, email }
  perfil: null,    // { id, nombre, rol }
  drones: [], activos: [], precios: [], parametros: {}, perfiles: [],
  ultimas: {},     // activo_id -> última lectura conocida
  lecIni: {},      // lectura_id -> inicio registrado en el servidor
  jornadas: [],    // jornadas recientes del servidor (con drones y trabajos)
  gastos: [],
  syncing: false
};
const esAdmin = () => S.perfil?.rol === 'admin';
const esAliado = () => S.perfil?.rol === 'aliado';
const veDinero = () => esAdmin() || esAliado();
function misDrones() {
  if (esAdmin()) return S.drones;
  if (esAliado()) return S.drones.filter((d) => d.aliado_id === S.user?.id);
  return S.drones; // piloto: puede registrar cualquiera
}
const dronPorDefecto = () => (esAliado() ? misDrones()[0]?.id : 'T55');

/* ------------------------------------------------------------------ */
/* Cola: encolar y sincronizar                                         */
/* ------------------------------------------------------------------ */
async function encolar(item, etiqueta) {
  await idb.push({ ...item, etiqueta });
  actualizarLecturasLocales(item);
  await pintarSync();
  sincronizar();
}
// Mantiene "última lectura" aunque no haya señal
function actualizarLecturasLocales(item) {
  if (item.table !== 'lecturas') return;
  const r = item.row;
  const v = Math.max(num(r.inicio) ?? -Infinity, num(r.fin) ?? -Infinity);
  if (Number.isFinite(v) && (S.ultimas[r.activo_id] ?? -Infinity) < v) {
    S.ultimas[r.activo_id] = v;
    idb.set('ultimas', S.ultimas);
  }
}

async function ejecutar(item) {
  if (item.op === 'upload') {
    const { error } = await sb.storage.from('soportes').upload(item.path, item.blob, { upsert: true, contentType: item.blob.type || 'image/jpeg' });
    return error;
  }
  if (item.op === 'upsert') {
    const { error } = await sb.from(item.table).upsert(item.row, { onConflict: item.onConflict || 'id', ignoreDuplicates: !!item.ignore });
    return error;
  }
  if (item.op === 'update') {
    const { error } = await sb.from(item.table).update(item.row).eq('id', item.id);
    return error;
  }
  return new Error('Operación desconocida');
}

async function sincronizar() {
  if (!navigator.onLine || !S.user) return;
  if (S.syncing) { S.otraVez = true; return; } // llegó algo nuevo mientras subía
  S.syncing = true;
  try {
    const { data } = await sb.auth.getSession();
    if (!data.session) return;
    const vistos = new Set();
    do {
      S.otraVez = false;
      const items = (await idb.all()).filter((i) => !vistos.has(i.seq));
      for (const it of items) {
        vistos.add(it.seq);
        let err;
        try { err = await ejecutar(it); } catch (e) { err = e; }
        if (!err) { await idb.remove(it.seq); continue; }
        if (esErrorDeRed(err)) { S.otraVez = false; break; } // sin señal: se reintenta después
        it.error = err.message || String(err);
        it.intentos = (it.intentos || 0) + 1;
        await idb.put(it);
      }
    } while (S.otraVez);
    await cargarDatos();
  } finally {
    S.syncing = false;
    pintarSync();
  }
}

async function pintarSync() {
  const items = await idb.all();
  const el = $('#sync');
  const txt = $('#sync-text');
  const conError = items.filter((i) => i.error).length;
  el.className = 'sync ' + (!navigator.onLine ? 'offline' : items.length ? 'pending' : 'ok');
  txt.textContent = !navigator.onLine
    ? (items.length ? `Sin señal · ${items.length}` : 'Sin señal')
    : items.length ? `${items.length} por subir${conError ? ' ⚠' : ''}` : 'Al día';
}

/* ------------------------------------------------------------------ */
/* Carga de datos (servidor → caché)                                   */
/* ------------------------------------------------------------------ */
async function cargarCache() {
  for (const k of ['perfil', 'drones', 'activos', 'precios', 'parametros', 'perfiles', 'ultimas', 'lecIni', 'jornadas', 'gastos']) {
    const v = await idb.get(k);
    if (v !== undefined) S[k] = v;
  }
}

async function cargarDatos() {
  if (!navigator.onLine || !S.user) return;
  try {
    const [perfil, drones, activos, perfiles] = await Promise.all([
      sb.from('perfiles').select('*').eq('id', S.user.id).maybeSingle(),
      sb.from('drones').select('*').order('id', { ascending: false }),
      sb.from('activos').select('*').eq('activo', true).order('dron_id').order('tipo').order('etiqueta'),
      sb.from('perfiles').select('id,nombre,rol')
    ]);
    if (perfil.error) throw perfil.error;
    S.perfil = perfil.data; S.drones = drones.data || []; S.activos = activos.data || []; S.perfiles = perfiles.data || [];

    if (veDinero()) {
      const [precios, params] = await Promise.all([
        sb.from('precios').select('*').eq('activo', true).order('tipo').order('litros_min'),
        sb.from('parametros').select('*').lte('vigente_desde', hoy()).order('vigente_desde')
      ]);
      S.precios = precios.data || [];
      S.parametros = {};
      for (const p of params.data || []) S.parametros[p.clave] = Number(p.valor); // el más reciente queda al final
    }

    const desde = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const [jor, lec, gas] = await Promise.all([
      sb.from('jornadas').select('*, jornada_drones(*, trabajos(*))').gte('fecha', desde).order('fecha', { ascending: false }),
      sb.from('lecturas').select('id,activo_id,inicio,fin').limit(5000),
      sb.from('gastos').select('*').gte('fecha', desde).order('fecha', { ascending: false }).limit(300)
    ]);
    S.jornadas = jor.data || [];
    S.gastos = gas.data || [];
    const ult = { ...S.ultimas };
    S.lecIni = {};
    for (const l of lec.data || []) {
      S.lecIni[l.id] = Number(l.inicio);
      const v = Math.max(Number(l.inicio), l.fin == null ? -Infinity : Number(l.fin));
      if ((ult[l.activo_id] ?? -Infinity) < v) ult[l.activo_id] = v;
    }
    for (const a of S.activos) if (a.lectura_inicial != null && ult[a.id] == null) ult[a.id] = Number(a.lectura_inicial);
    S.ultimas = ult;

    for (const k of ['perfil', 'drones', 'activos', 'precios', 'parametros', 'perfiles', 'ultimas', 'lecIni', 'jornadas', 'gastos']) await idb.set(k, S[k]);
  } catch (e) {
    if (!esErrorDeRed(e)) console.warn('cargarDatos', e);
  }
}

/* ------------------------------------------------------------------ */
/* Fotos: comprimir antes de guardar                                   */
/* ------------------------------------------------------------------ */
async function comprimir(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', 0.72));
  } catch { return file; }
}
function campoFoto(id, etiqueta) {
  return `<label for="${id}">${etiqueta}</label>
    <input id="${id}" type="file" accept="image/*" capture="environment">
    <img id="${id}-prev" class="photo-prev" alt="" hidden>`;
}
function conectarFoto(id) {
  const inp = $('#' + id);
  inp?.addEventListener('change', () => {
    const f = inp.files?.[0];
    const img = $('#' + id + '-prev');
    if (f) { img.src = URL.createObjectURL(f); img.hidden = false; } else img.hidden = true;
  });
}

/* ------------------------------------------------------------------ */
/* Precios                                                             */
/* ------------------------------------------------------------------ */
function precioSugerido({ tipo, litros, precioId, ha, dron }) {
  if (!S.precios.length) return null;
  if (tipo === 'mapeo') {
    const h = Number(ha) || 0;
    return { total: 700000 + Math.max(0, h - 70) * 10000, detalle: 'Mapeo: $700.000 primeras 70 Ha + $10.000/Ha adicional' };
  }
  let p;
  if (tipo === 'paquete') p = S.precios.find((x) => x.id === precioId);
  else if (litros != null) p = S.precios.find((x) => x.tipo === 'aspersion' && litros >= Number(x.litros_min) && litros <= Number(x.litros_max));
  if (!p) return null;
  const h = Number(ha) || 0;
  return { total: Number(p.valor_ha) * h, porHa: Number(p.valor_ha), detalle: p.nombre, precio: p };
}

/* ------------------------------------------------------------------ */
/* Navegación                                                          */
/* ------------------------------------------------------------------ */
const rutas = {};
let pila = [];
function ir(nombre, params = {}, reemplazar = false) {
  if (reemplazar) pila = [];
  pila.push({ nombre, params });
  render();
}
function volver() { pila.pop(); if (!pila.length) pila.push({ nombre: 'inicio', params: {} }); render(); }
$('#btn-back').addEventListener('click', volver);
async function render() {
  const cur = pila[pila.length - 1] || { nombre: 'inicio', params: {} };
  const r = rutas[cur.nombre];
  $('#btn-back').hidden = pila.length <= 1;
  $('#title').textContent = r.titulo || 'COLFOG Agro';
  const view = $('#view');
  view.innerHTML = await r.html(cur.params);
  r.init && (await r.init(cur.params));
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ */
/* Vista: ingreso                                                      */
/* ------------------------------------------------------------------ */
rutas.login = {
  titulo: 'COLFOG Agro',
  html: () => `
    <div class="card">
      <h2>Ingresar</h2>
      <p class="muted">Usa el correo y la clave que te asignó COLFOG.</p>
      <form id="f-login">
        <label for="email">Correo</label>
        <input id="email" type="email" autocomplete="username" required>
        <label for="pass">Clave</label>
        <input id="pass" type="password" autocomplete="current-password" required>
        <button class="btn" type="submit">Ingresar</button>
      </form>
      ${navigator.onLine ? '' : '<p class="note">Necesitas señal para ingresar la primera vez.</p>'}
    </div>`,
  init: () => {
    $('#f-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'Ingresando…';
      const { data, error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#pass').value });
      if (error) { toast(error.message === 'Invalid login credentials' ? 'Correo o clave incorrectos' : error.message); btn.disabled = false; btn.textContent = 'Ingresar'; return; }
      S.user = { id: data.user.id, email: data.user.email };
      await idb.set('user', S.user);
      await cargarDatos();
      if (!S.perfil) { toast('Tu usuario no tiene perfil. Pide a COLFOG que lo active.'); }
      ir('inicio', {}, true);
      sincronizar();
    });
  }
};

/* ------------------------------------------------------------------ */
/* Vista: inicio                                                       */
/* ------------------------------------------------------------------ */
function jornadaServidor(fecha) { return S.jornadas.find((j) => j.fecha === fecha); }
async function estadoDia(fecha) {
  const local = (await idb.get('dia:' + fecha)) || { drones: {} };
  const srv = jornadaServidor(fecha);
  const drones = { ...local.drones };
  for (const jd of srv?.jornada_drones || []) drones[jd.dron_id] = drones[jd.dron_id] || { iniciada: true };
  return { local, srv, drones };
}

rutas.inicio = {
  titulo: 'COLFOG Agro',
  html: async () => {
    const f = hoy();
    const { drones } = await estadoDia(f);
    const mis = misDrones();
    const lineas = mis.map((d) => {
      const e = drones[d.id];
      const estado = !e ? '<span class="badge warn">Sin iniciar</span>' : e.cerrada ? '<span class="badge">Cerrada</span>' : '<span class="badge">En curso</span>';
      return `<li><div><div class="t">${esc(d.nombre)}</div></div>${estado}</li>`;
    }).join('');
    const pendientes = S.gastos.filter((g) => g.estado === 'pendiente').length;
    return `
      <div class="hello"><span class="muted">${esc(fechaLarga(f))}</span><strong>Hola, ${esc((S.perfil?.nombre || S.user?.email || '').split(' ')[0])}</strong></div>
      <div class="grid-actions">
        <button class="action primary" data-go="jornada"><b>Iniciar jornada</b><span>Km, baterías, generador</span></button>
        <button class="action" data-go="trabajo"><b>Registrar trabajo</b><span>Cliente, Ha, litros</span></button>
        <button class="action" data-go="cierre"><b>Cerrar jornada</b><span>Lecturas finales, diésel</span></button>
        <button class="action" data-go="gasto"><b>Registrar gasto</b><span>Con foto del soporte</span></button>
      </div>
      ${veDinero() ? `<button class="action tablero-btn" data-go="tablero"><b>Tablero</b><span>Hectáreas, ingresos, costos, utilidad${esAdmin() ? ' y liquidación del aliado' : ''}</span></button>` : ''}
      <div class="card"><h2>Hoy</h2><ul class="list">${lineas || '<li class="muted">No tienes drones asignados.</li>'}</ul></div>
      ${esAdmin() ? `<div class="card"><h2>Administración</h2><ul class="list">
        <li><div><div class="t">Gastos por aprobar</div><div class="muted">Revisa soportes del aliado y pilotos</div></div><button class="btn small" data-go="aprobaciones">${pendientes}</button></li>
      </ul></div>` : ''}
      <div class="card"><h2>Registros</h2><ul class="list">
        <li><div><div class="t">Jornadas y trabajos</div><div class="muted">Últimos 45 días</div></div><button class="btn small secondary" data-go="registros">Ver</button></li>
        <li><div><div class="t">Mis gastos</div><div class="muted">Estado de aprobación</div></div><button class="btn small secondary" data-go="gastos">Ver</button></li>
        <li><div><div class="t">Pendientes por subir</div><div class="muted">Se suben solos al tener señal</div></div><button class="btn small secondary" data-go="cola">Ver</button></li>
      </ul></div>
      <div class="footer-links"><span class="muted">v${esc(CFG.APP_VERSION)} · ${esc(S.perfil?.rol || '')}</span><button class="linklike" id="salir">Cerrar sesión</button></div>`;
  },
  init: () => {
    $$('[data-go]').forEach((b) => b.addEventListener('click', () => ir(b.dataset.go)));
    $('#salir').addEventListener('click', async () => {
      const items = await idb.all();
      if (items.length && !confirm(`Tienes ${items.length} registros sin subir. Si cierras sesión se pierden. ¿Continuar?`)) return;
      await sb.auth.signOut();
      await idb.clear();
      S.user = null; S.perfil = null;
      ir('login', {}, true);
    });
  }
};

/* ------------------------------------------------------------------ */
/* Lecturas de baterías y generador                                    */
/* ------------------------------------------------------------------ */
function activosDe(dron) { return S.activos.filter((a) => a.dron_id === dron); }
function nombreActivo(a) { return a.tipo === 'generador' ? 'Generador (horas)' : `Batería ${a.etiqueta}${a.modelo ? ' · ' + a.modelo : ''} (ciclos)`; }
function bloqueLecturas(dron, campo, valores = {}) {
  const acts = activosDe(dron);
  if (!acts.length) return '<p class="muted">Este dron no tiene baterías ni generador registrados.</p>';
  return acts.map((a) => {
    const prev = S.ultimas[a.id];
    const val = valores[a.id] ?? '';
    return `<div class="reading">
      <div><div class="name">${esc(nombreActivo(a))}</div>
      <div class="prev">${prev != null ? `Última lectura: ${prev}` : 'Sin lectura previa'}</div></div>
      <input type="number" inputmode="decimal" step="any" min="0" data-activo="${a.id}" data-campo="${campo}" value="${esc(val)}" placeholder="${prev ?? ''}">
    </div>`;
  }).join('');
}
function leerLecturas(scope) {
  const out = [];
  for (const inp of $$('input[data-activo]', scope)) {
    const v = num(inp.value);
    if (v != null) out.push({ activo_id: inp.dataset.activo, valor: v });
  }
  return out;
}
function validarLecturas(lecturas) {
  const malas = lecturas.filter((l) => S.ultimas[l.activo_id] != null && l.valor < S.ultimas[l.activo_id]);
  if (!malas.length) return true;
  const txt = malas.map((l) => { const a = S.activos.find((x) => x.id === l.activo_id); return `${nombreActivo(a)}: ${l.valor} < ${S.ultimas[l.activo_id]}`; }).join('\n');
  return confirm(`Estas lecturas son menores que la anterior:\n${txt}\n\n¿Guardar de todos modos?`);
}

/* ------------------------------------------------------------------ */
/* Jornada y dron del día (IDs determinísticos)                        */
/* ------------------------------------------------------------------ */
async function asegurarJornada(fecha, dron, extra = {}) {
  const jid = await idJornada(fecha);
  const jdId = await idJD(fecha, dron);
  const row = { id: jid, fecha, ...extra };
  // El admin puede completar datos de camioneta de una jornada creada por otro
  await encolar({ op: 'upsert', table: 'jornadas', row, ignore: !esAdmin() || !Object.keys(extra).length }, `Jornada ${fecha}`);
  const d = S.drones.find((x) => x.id === dron);
  const piloto = esAdmin() && d?.aliado_id ? d.aliado_id : S.user.id;
  await encolar({ op: 'upsert', table: 'jornada_drones', row: { id: jdId, jornada_id: jid, dron_id: dron, piloto_id: piloto }, ignore: true }, `${dron} en jornada ${fecha}`);
  const dia = (await idb.get('dia:' + fecha)) || { drones: {} };
  dia.drones[dron] = { ...(dia.drones[dron] || {}), iniciada: true, jdId };
  if (Object.keys(extra).length) dia.creadaPorMi = true;
  await idb.set('dia:' + fecha, dia);
  return { jid, jdId };
}

rutas.jornada = {
  titulo: 'Iniciar jornada',
  html: () => {
    const mis = misDrones();
    const def = dronPorDefecto();
    return `<form id="f-j">
      <div class="card">
        <label for="fecha">Fecha</label>
        <input id="fecha" type="date" value="${hoy()}" required>
        <label>Drones que salen hoy</label>
        <div class="chips">${mis.map((d) => `<label class="chip"><input type="checkbox" name="dron" value="${d.id}" ${d.id === def ? 'checked' : ''}>${esc(d.id)}</label>`).join('')}</div>
        ${esAdmin() ? '<p class="muted">Si salen los dos drones, márcalos ambos: la camioneta y el auxiliar se reparten 50/50.</p>' : ''}
      </div>
      <div class="card">
        <h2>Camioneta y auxiliar</h2>
        <label class="check"><input type="checkbox" id="usa-cam" checked> Se usa la camioneta</label>
        <div id="cam-campos">
          <label for="odo">Odómetro inicial (km)</label>
          <input id="odo" type="number" inputmode="numeric" min="0" step="1" placeholder="Ej: 45210">
        </div>
        <label class="check"><input type="checkbox" id="aux" checked> Va el auxiliar de vuelo</label>
        ${esAdmin() ? '' : '<p class="muted">Si COLFOG ya registró la camioneta de este día, estos datos no se sobrescriben.</p>'}
      </div>
      <div id="lecturas"></div>
      <button class="btn" type="submit">Guardar inicio de jornada</button>
    </form>`;
  },
  init: () => {
    const pintar = () => {
      const sel = $$('input[name=dron]:checked').map((i) => i.value);
      $('#lecturas').innerHTML = sel.map((d) => `<div class="card" data-dron="${d}"><h2>${esc(d)} · lecturas de inicio</h2>${bloqueLecturas(d, 'inicio')}</div>`).join('');
    };
    $$('input[name=dron]').forEach((i) => i.addEventListener('change', pintar));
    $('#usa-cam').addEventListener('change', (e) => ($('#cam-campos').hidden = !e.target.checked));
    pintar();
    $('#f-j').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fecha = $('#fecha').value;
      const sel = $$('input[name=dron]:checked').map((i) => i.value);
      if (!sel.length) return toast('Marca al menos un dron');
      const todas = leerLecturas($('#lecturas'));
      if (!validarLecturas(todas)) return;
      const usaCam = $('#usa-cam').checked;
      const extra = { usa_camioneta: usaCam, auxiliar: $('#aux').checked };
      const odo = num($('#odo').value);
      if (usaCam && odo != null) extra.odometro_ini = odo;
      for (const dron of sel) {
        const { jdId } = await asegurarJornada(fecha, dron, extra);
        for (const card of $$(`[data-dron="${dron}"]`)) {
          for (const l of leerLecturas(card)) {
            await encolar({ op: 'upsert', table: 'lecturas', row: { id: await idLectura(jdId, l.activo_id), jornada_dron_id: jdId, activo_id: l.activo_id, inicio: l.valor } }, `Lectura inicio ${dron}`);
            const dia = (await idb.get('dia:' + fecha)) || { drones: {} };
            dia.lecturas = { ...(dia.lecturas || {}), [l.activo_id]: { ...(dia.lecturas?.[l.activo_id] || {}), inicio: l.valor } };
            await idb.set('dia:' + fecha, dia);
          }
        }
      }
      toast(navigator.onLine ? 'Jornada iniciada' : 'Guardado en el celular. Se sube al tener señal.');
      ir('inicio', {}, true);
    });
  }
};

/* ------------------------------------------------------------------ */
/* Vista: registrar trabajo                                            */
/* ------------------------------------------------------------------ */
const CULTIVOS = ['Café', 'Aguacate', 'Potrero', 'Caña de azúcar', 'Cítricos', 'Plátano', 'Maíz', 'Otro'];
rutas.trabajo = {
  titulo: 'Registrar trabajo',
  html: async () => {
    const mis = misDrones();
    const def = dronPorDefecto();
    const clientes = [...new Set(S.jornadas.flatMap((j) => (j.jornada_drones || []).flatMap((jd) => (jd.trabajos || []).map((t) => t.cliente))))].sort();
    const paquetes = S.precios.filter((p) => p.tipo === 'paquete');
    return `<form id="f-t">
      <div class="card">
        <div class="row">
          <div><label for="fecha">Fecha</label><input id="fecha" type="date" value="${hoy()}" required></div>
          <div><label for="dron">Dron</label><select id="dron">${mis.map((d) => `<option value="${d.id}" ${d.id === def ? 'selected' : ''}>${esc(d.id)}</option>`).join('')}</select></div>
        </div>
        <label for="cliente">Cliente</label>
        <input id="cliente" list="lista-clientes" required autocomplete="off">
        <datalist id="lista-clientes">${clientes.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="row">
          <div><label for="finca">Finca</label><input id="finca"></div>
          <div><label for="municipio">Municipio</label><input id="municipio"></div>
        </div>
        <label for="cultivo">Cultivo</label>
        <select id="cultivo">${CULTIVOS.map((c) => `<option>${c}</option>`).join('')}</select>
      </div>
      <div class="card">
        <label for="tipo">Servicio</label>
        <select id="tipo">
          <option value="aspersion">Aspersión</option>
          ${veDinero() && paquetes.length ? '<option value="paquete">Paquete Multiseres (incluye producto)</option>' : ''}
          ${esAdmin() ? '<option value="mapeo">Mapeo inicial (solo COLFOG)</option>' : ''}
        </select>
        <div id="campo-paquete" hidden>
          <label for="paquete">Paquete</label>
          <select id="paquete">${paquetes.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select>
        </div>
        <div class="row">
          <div><label for="ha">Hectáreas</label><input id="ha" type="number" inputmode="decimal" step="0.01" min="0.01" required></div>
          <div id="campo-litros"><label for="litros">Litros / Ha</label><input id="litros" type="number" inputmode="decimal" step="any" min="1"></div>
        </div>
        <div id="valor" class="note info" hidden></div>
        <label for="notas">Notas</label>
        <textarea id="notas" placeholder="Novedades, lote, producto aplicado…"></textarea>
      </div>
      <button class="btn" type="submit">Guardar trabajo</button>
    </form>`;
  },
  init: () => {
    const upd = () => {
      const tipo = $('#tipo').value;
      $('#campo-paquete').hidden = tipo !== 'paquete';
      $('#campo-litros').hidden = tipo === 'mapeo';
      if (tipo === 'mapeo' && $('#dron').value !== 'T55') $('#dron').value = 'T55';
      if (!veDinero()) return;
      const p = precioSugerido({ tipo, litros: num($('#litros').value), precioId: $('#paquete').value, ha: num($('#ha').value), dron: $('#dron').value });
      const v = $('#valor');
      if (p && p.total > 0) { v.hidden = false; v.innerHTML = `Valor estimado: <b class="money">${money(p.total)}</b><br><span class="muted">${esc(p.detalle)}${p.porHa ? ' · ' + money(p.porHa) + '/Ha' : ''}</span>`; }
      else v.hidden = true;
    };
    ['tipo', 'litros', 'ha', 'paquete', 'dron'].forEach((id) => $('#' + id)?.addEventListener('input', upd));
    $('#paquete')?.addEventListener('change', () => {
      const p = S.precios.find((x) => x.id === $('#paquete').value);
      if (p?.litros_min) $('#litros').value = p.litros_min;
      upd();
    });
    $('#tipo').addEventListener('change', () => { if ($('#tipo').value === 'paquete') $('#paquete').dispatchEvent(new Event('change')); upd(); });
    upd();
    $('#f-t').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fecha = $('#fecha').value, dron = $('#dron').value, tipo = $('#tipo').value;
      const ha = num($('#ha').value);
      if (!ha || ha <= 0) return toast('Ingresa las hectáreas');
      const { jdId } = await asegurarJornada(fecha, dron);
      const row = {
        id: uuid(), jornada_dron_id: jdId,
        cliente: $('#cliente').value.trim(), finca: $('#finca').value.trim() || null,
        municipio: $('#municipio').value.trim() || null, cultivo: $('#cultivo').value,
        tipo_servicio: tipo, ha, litros_ha: tipo === 'mapeo' ? null : num($('#litros').value),
        precio_id: tipo === 'paquete' ? $('#paquete').value : null,
        notas: $('#notas').value.trim() || null
      };
      await encolar({ op: 'upsert', table: 'trabajos', row, ignore: true }, `Trabajo ${row.cliente} · ${ha} Ha`);
      toast(tipo === 'paquete' ? 'Trabajo guardado. Registra el costo del producto como gasto.' : 'Trabajo guardado');
      ir('inicio', {}, true);
    });
  }
};

/* ------------------------------------------------------------------ */
/* Vista: cerrar jornada                                               */
/* ------------------------------------------------------------------ */
rutas.cierre = {
  titulo: 'Cerrar jornada',
  html: async () => {
    const f = hoy();
    const { local, srv, drones } = await estadoDia(f);
    const mis = misDrones().filter((d) => drones[d.id]);
    const puedeCam = esAdmin() || local.creadaPorMi || srv?.creado_por === S.user.id;
    const lec = local.lecturas || {};
    return `<form id="f-c">
      <div class="card"><label for="fecha">Fecha</label><input id="fecha" type="date" value="${f}" required>
      ${!mis.length ? '<p class="note">No hay jornada iniciada hoy para tus drones. Puedes cerrar igual: se crea la jornada.</p>' : ''}</div>
      ${(mis.length ? mis : misDrones().filter((d) => d.id === dronPorDefecto())).map((d) => `
        <div class="card" data-dron="${d.id}"><h2>${esc(d.id)} · lecturas de cierre</h2>
        ${bloqueLecturas(d.id, 'fin')}
        ${activosDe(d.id).some((a) => lec[a.id]?.inicio == null) ? '<p class="muted">Si no registraste el inicio, la lectura de cierre queda como inicio y fin.</p>' : ''}
        </div>`).join('')}
      ${puedeCam ? `<div class="card"><h2>Camioneta</h2>
        <label for="odo">Odómetro final (km)</label>
        <input id="odo" type="number" inputmode="numeric" min="0" step="1" placeholder="${esc(srv?.odometro_ini ?? '')}">
        <label for="diesel">Diésel tanqueado hoy ($)</label>
        <input id="diesel" inputmode="numeric" placeholder="0">
        ${campoFoto('foto-diesel', 'Foto del recibo de diésel')}
      </div>` : '<p class="muted">Los datos de camioneta y diésel de este día los registra quien abrió la jornada.</p>'}
      <button class="btn" type="submit">Guardar cierre</button>
    </form>`;
  },
  init: () => {
    conectarFoto('foto-diesel');
    $('#diesel')?.addEventListener('input', (e) => { const n = soloDigitos(e.target.value); e.target.value = n ? n.toLocaleString('es-CO') : ''; });
    $('#f-c').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fecha = $('#fecha').value;
      const todas = leerLecturas($('#f-c'));
      if (!validarLecturas(todas)) return;
      const dia = (await idb.get('dia:' + fecha)) || { drones: {} };
      for (const card of $$('[data-dron]')) {
        const dron = card.dataset.dron;
        const { jdId } = await asegurarJornada(fecha, dron);
        for (const l of leerLecturas(card)) {
          const lid = await idLectura(jdId, l.activo_id);
          // inicio: el registrado en este celular, o el que ya está en el servidor, o el mismo cierre
          const ini = dia.lecturas?.[l.activo_id]?.inicio ?? S.lecIni[lid] ?? l.valor;
          await encolar({ op: 'upsert', table: 'lecturas', row: { id: lid, jornada_dron_id: jdId, activo_id: l.activo_id, inicio: Math.min(ini, l.valor), fin: l.valor } }, `Lectura cierre ${dron}`);
        }
        const d2 = (await idb.get('dia:' + fecha)) || { drones: {} };
        d2.drones[dron] = { ...(d2.drones[dron] || {}), cerrada: true };
        await idb.set('dia:' + fecha, d2);
      }
      if ($('#odo')) {
        const jid = await idJornada(fecha);
        const upd = {};
        const odo = num($('#odo').value);
        if (odo != null) upd.odometro_fin = odo;
        const diesel = soloDigitos($('#diesel').value);
        if (diesel) upd.diesel_valor = diesel;
        const foto = $('#foto-diesel').files?.[0];
        if (foto) {
          const path = `${S.user.id}/diesel-${fecha}-${uuid().slice(0, 8)}.jpg`;
          await encolar({ op: 'upload', path, blob: await comprimir(foto) }, `Foto diésel ${fecha}`);
          upd.diesel_soporte = path;
        }
        if (Object.keys(upd).length) await encolar({ op: 'update', table: 'jornadas', id: jid, row: upd }, `Cierre camioneta ${fecha}`);
      }
      toast('Jornada cerrada');
      ir('inicio', {}, true);
    });
  }
};

/* ------------------------------------------------------------------ */
/* Vista: registrar gasto                                              */
/* ------------------------------------------------------------------ */
const CATEGORIAS = [
  ['gasolina_planta', 'Gasolina planta / generador'],
  ['viaticos', 'Viáticos (alimentación, hospedaje)'],
  ['peajes', 'Peajes'],
  ['producto', 'Producto paquete Multiseres'],
  ['repuestos', 'Repuestos dron'],
  ['mantenimiento', 'Mantenimiento'],
  ['otro', 'Otro']
];
const nombreCat = (c) => (CATEGORIAS.find((x) => x[0] === c) || [c, c])[1];
rutas.gasto = {
  titulo: 'Registrar gasto',
  html: () => {
    const mis = misDrones();
    const def = dronPorDefecto();
    return `<form id="f-g"><div class="card">
      <div class="row">
        <div><label for="fecha">Fecha</label><input id="fecha" type="date" value="${hoy()}" required></div>
        <div><label for="dron">Dron</label><select id="dron">
          ${mis.map((d) => `<option value="${d.id}" ${d.id === def ? 'selected' : ''}>${esc(d.id)}</option>`).join('')}
          ${esAdmin() ? '<option value="">General COLFOG</option>' : ''}
        </select></div>
      </div>
      <label for="cat">Categoría</label>
      <select id="cat">${CATEGORIAS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
      <label for="valor">Valor ($)</label>
      <input id="valor" inputmode="numeric" required placeholder="0">
      <label for="desc">Descripción</label>
      <input id="desc" placeholder="Ej: almuerzo 2 personas, Aguadas">
      ${campoFoto('foto', 'Foto del soporte (factura o recibo)')}
      ${esAdmin() ? '' : '<p class="muted">COLFOG revisa el soporte y aprueba el gasto antes de la liquidación.</p>'}
    </div><button class="btn" type="submit">Guardar gasto</button></form>`;
  },
  init: () => {
    conectarFoto('foto');
    $('#valor').addEventListener('input', (e) => { const n = soloDigitos(e.target.value); e.target.value = n ? n.toLocaleString('es-CO') : ''; });
    $('#f-g').addEventListener('submit', async (e) => {
      e.preventDefault();
      const valor = soloDigitos($('#valor').value);
      if (!valor) return toast('Ingresa el valor');
      const foto = $('#foto').files?.[0];
      if (!foto && !esAdmin() && !confirm('No adjuntaste foto del soporte. Sin soporte el gasto puede ser rechazado. ¿Guardar igual?')) return;
      const id = uuid();
      let soporte = null;
      if (foto) {
        soporte = `${S.user.id}/gasto-${id}.jpg`;
        await encolar({ op: 'upload', path: soporte, blob: await comprimir(foto) }, 'Foto de soporte');
      }
      const row = { id, fecha: $('#fecha').value, dron_id: $('#dron').value || null, categoria: $('#cat').value, descripcion: $('#desc').value.trim() || null, valor, soporte };
      await encolar({ op: 'upsert', table: 'gastos', row, ignore: true }, `Gasto ${nombreCat(row.categoria)} ${money(valor)}`);
      toast('Gasto guardado');
      ir('inicio', {}, true);
    });
  }
};

/* ------------------------------------------------------------------ */
/* Vistas de consulta                                                  */
/* ------------------------------------------------------------------ */
rutas.registros = {
  titulo: 'Jornadas y trabajos',
  html: () => {
    if (!S.jornadas.length) return '<div class="card"><p class="muted">Aún no hay jornadas registradas (o no se han sincronizado).</p></div>';
    return S.jornadas.map((j) => {
      const jds = (j.jornada_drones || []).filter((jd) => esAdmin() || !esAliado() || misDrones().some((d) => d.id === jd.dron_id));
      const km = j.odometro_fin != null && j.odometro_ini != null ? j.odometro_fin - j.odometro_ini : null;
      return `<div class="card"><h2>${esc(fechaLarga(j.fecha))}</h2>
        <p class="muted">Drones: ${(j.jornada_drones || []).map((x) => x.dron_id).join(' + ') || '—'}${km != null ? ` · ${km} km` : ''}${veDinero() && j.diesel_valor ? ` · Diésel ${money(j.diesel_valor)}` : ''}${j.auxiliar ? ' · Con auxiliar' : ''}</p>
        <ul class="list">${jds.flatMap((jd) => (jd.trabajos || []).map((t) => `<li><div><div class="t">${esc(t.cliente)}${t.finca ? ' · ' + esc(t.finca) : ''}</div>
          <div class="muted">${esc(jd.dron_id)} · ${esc(t.cultivo || '')} · ${t.litros_ha ? esc(t.litros_ha) + ' L/Ha' : esc(t.tipo_servicio)}</div></div>
          <span class="badge">${esc(t.ha)} Ha</span></li>`)).join('') || '<li class="muted">Sin trabajos registrados</li>'}</ul></div>`;
    }).join('');
  }
};

const badgeEstado = (e) => e === 'aprobado' ? '<span class="badge">Aprobado</span>' : e === 'rechazado' ? '<span class="badge danger">Rechazado</span>' : '<span class="badge warn">Pendiente</span>';
rutas.gastos = {
  titulo: 'Mis gastos',
  html: () => {
    const lista = esAdmin() ? S.gastos : S.gastos.filter((g) => g.creado_por === S.user.id || misDrones().some((d) => d.id === g.dron_id));
    if (!lista.length) return '<div class="card"><p class="muted">No hay gastos en los últimos 45 días.</p></div>';
    return `<div class="card"><ul class="list">${lista.map((g) => `<li><div><div class="t">${esc(nombreCat(g.categoria))} · <span class="money">${money(g.valor)}</span></div>
      <div class="muted">${esc(g.fecha)} · ${esc(g.dron_id || 'General')}${g.descripcion ? ' · ' + esc(g.descripcion) : ''}</div></div>${badgeEstado(g.estado)}</li>`).join('')}</ul></div>`;
  }
};

rutas.cola = {
  titulo: 'Pendientes por subir',
  html: async () => {
    const items = await idb.all();
    if (!items.length) return '<div class="card"><p>Todo está subido.</p></div>';
    return `<div class="card"><ul class="list">${items.map((i) => `<li><div><div class="t">${esc(i.etiqueta || i.table || i.op)}</div>
      <div class="muted">${new Date(i.creado).toLocaleString('es-CO')}</div>
      ${i.error ? `<div class="note">${esc(i.error)}</div>` : ''}</div>
      ${i.error ? `<button class="btn small danger" data-borrar="${i.seq}">Descartar</button>` : '<span class="badge warn">En espera</span>'}</li>`).join('')}</ul>
      <button class="btn" id="reintentar" ${navigator.onLine ? '' : 'disabled'}>Subir ahora</button></div>`;
  },
  init: () => {
    $('#reintentar')?.addEventListener('click', async () => { await sincronizar(); render(); });
    $$('[data-borrar]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('¿Descartar este registro? No se podrá recuperar.')) return;
      await idb.remove(Number(b.dataset.borrar)); await pintarSync(); render();
    }));
  }
};

rutas.aprobaciones = {
  titulo: 'Aprobar gastos',
  html: async () => {
    if (!navigator.onLine) return '<div class="card"><p class="note">Necesitas señal para aprobar gastos.</p></div>';
    const { data, error } = await sb.from('gastos').select('*').eq('estado', 'pendiente').order('fecha');
    if (error) return `<div class="card"><p class="note">${esc(error.message)}</p></div>`;
    if (!data.length) return '<div class="card"><p>No hay gastos pendientes.</p></div>';
    const nombres = Object.fromEntries(S.perfiles.map((p) => [p.id, p.nombre]));
    const urls = {};
    const conFoto = data.filter((g) => g.soporte).map((g) => g.soporte);
    if (conFoto.length) {
      const { data: s } = await sb.storage.from('soportes').createSignedUrls(conFoto, 3600);
      for (const x of s || []) urls[x.path] = x.signedUrl;
    }
    return data.map((g) => `<div class="card" data-id="${g.id}">
      <div class="t"><b>${esc(nombreCat(g.categoria))}</b> · <span class="money">${money(g.valor)}</span></div>
      <p class="muted">${esc(g.fecha)} · ${esc(g.dron_id || 'General')} · ${esc(nombres[g.creado_por] || '')}${g.descripcion ? '<br>' + esc(g.descripcion) : ''}</p>
      ${urls[g.soporte] ? `<a href="${urls[g.soporte]}" target="_blank" rel="noopener"><img class="photo-prev" src="${urls[g.soporte]}" alt="Soporte"></a>` : '<p class="note">Sin foto de soporte</p>'}
      <div class="row"><button class="btn secondary" data-accion="rechazado">Rechazar</button><button class="btn" data-accion="aprobado">Aprobar</button></div>
    </div>`).join('');
  },
  init: () => {
    $$('[data-accion]').forEach((b) => b.addEventListener('click', async () => {
      const card = b.closest('[data-id]');
      const { error } = await sb.from('gastos').update({ estado: b.dataset.accion, revisado_por: S.user.id }).eq('id', card.dataset.id);
      if (error) return toast(error.message);
      card.remove();
      toast(b.dataset.accion === 'aprobado' ? 'Gasto aprobado' : 'Gasto rechazado');
      cargarDatos();
    }));
  }
};

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */
window.addEventListener('online', () => { pintarSync(); sincronizar(); });
window.addEventListener('offline', pintarSync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizar(); });
setInterval(sincronizar, 60000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

(async function arrancar() {
  if (location.protocol === 'file:') {
    mostrarFalla('Estás abriendo index.html como archivo. Para probarla, publícala en GitHub Pages (o en el dominio de COLFOG) y ábrela desde ese enlace.');
    return;
  }
  if (!window.indexedDB || !window.crypto?.subtle) {
    mostrarFalla('Este navegador no permite guardar datos sin señal. Usa Safari o Chrome actualizados.');
    return;
  }
  await cargarCache();
  const { data } = await sb.auth.getSession();
  const cached = await idb.get('user');
  if (data.session) S.user = { id: data.session.user.id, email: data.session.user.email };
  else if (cached && !navigator.onLine) S.user = cached; // sin señal: trabaja con la última sesión
  if (!S.user) { ir('login', {}, true); pintarSync(); return; }
  await idb.set('user', S.user);
  ir('inicio', {}, true);
  pintarSync();
  await cargarDatos();
  render();
  sincronizar();
})();
