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
// Texto comparable: sin tildes, mayúsculas ni espacios de más ("Finca  La Esperanza" = "finca la esperanza")
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
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
  checklists: [],
  dupRev: [],      // grupos que el admin marcó como "no son duplicados"
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
const dronPorDefecto = () => (esAliado() ? (misDrones().find((d) => d.propietario === 'ALIADO') || misDrones()[0])?.id : 'T55');

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
  for (const k of ['perfil', 'drones', 'activos', 'precios', 'parametros', 'perfiles', 'ultimas', 'lecIni', 'jornadas', 'gastos', 'checklists', 'dupRev']) {
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
    const [jor, lec, gas, chk] = await Promise.all([
      sb.from('jornadas').select('*, jornada_drones(*, trabajos(*))').gte('fecha', desde).order('fecha', { ascending: false }),
      sb.from('lecturas').select('id,activo_id,inicio,fin').limit(5000),
      sb.from('gastos').select('*').gte('fecha', desde).order('fecha', { ascending: false }).limit(300),
      sb.from('checklists').select('*').gte('fecha', desde).order('created_at', { ascending: false }).limit(300)
    ]);
    if (!chk.error) S.checklists = chk.data || [];
    S.jornadas = (jor.data || []).map(sinAnulados);   // lo anulado no se muestra ni cuenta
    S.gastos = (gas.data || []).filter((g) => !g.anulado);
    if (esAdmin()) {
      const rev = await sb.from('duplicados_revisados').select('clave');
      if (!rev.error) S.dupRev = (rev.data || []).map((x) => x.clave);
    }
    const ult = { ...S.ultimas };
    S.lecIni = {};
    for (const l of lec.data || []) {
      S.lecIni[l.id] = Number(l.inicio);
      const v = Math.max(Number(l.inicio), l.fin == null ? -Infinity : Number(l.fin));
      if ((ult[l.activo_id] ?? -Infinity) < v) ult[l.activo_id] = v;
    }
    for (const a of S.activos) if (a.lectura_inicial != null && ult[a.id] == null) ult[a.id] = Number(a.lectura_inicial);
    S.ultimas = ult;

    for (const k of ['perfil', 'drones', 'activos', 'precios', 'parametros', 'perfiles', 'ultimas', 'lecIni', 'jornadas', 'gastos', 'checklists', 'dupRev']) await idb.set(k, S[k]);
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
    const chkLocal = (await idb.get('chk:' + f)) || {};
    const lineas = mis.map((d) => {
      const e = drones[d.id];
      const estado = !e ? '<span class="badge warn">Sin iniciar</span>' : e.cerrada ? '<span class="badge">Cerrada</span>' : '<span class="badge">En curso</span>';
      const ck = checklistDe(f, d.id, chkLocal);
      const ckTxt = !ck ? '<span class="muted">Checklist pendiente</span>' : ck.completo ? '<span class="muted">✓ Checklist completo</span>' : `<span class="muted">⚠ Checklist: faltó ${esc(faltantes(ck).join(', '))}</span>`;
      return `<li><div><div class="t">${esc(d.nombre)}</div>${ckTxt}</div>${estado}</li>`;
    }).join('');
    const pendientes = S.gastos.filter((g) => g.estado === 'pendiente').length;
    const dupG = esAdmin() ? agruparDuplicados(trabajosPlanos(S.jornadas), S.gastos, S.dupRev) : { trabajos: [], gastos: [] };
    const nDup = dupG.trabajos.length + dupG.gastos.length;
    return `
      <div class="hello"><span class="muted">${esc(fechaLarga(f))}</span><strong>Hola, ${esc((S.perfil?.nombre || S.user?.email || '').split(' ')[0])}</strong></div>
      <button class="action checklist-btn" data-go="checklist"><b>✓ Checklist de salida</b><span>Verifica equipos e insumos antes de salir al trabajo</span></button>
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
        <li><div><div class="t">Posibles duplicados</div><div class="muted">Trabajos o gastos registrados dos veces</div></div><button class="btn small ${nDup ? '' : 'secondary'}" data-go="duplicados">${nDup}</button></li>
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
  const piloto = esAdmin() && d?.propietario === 'ALIADO' && d.aliado_id ? d.aliado_id : S.user.id;
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
        ${esAdmin() ? '<p class="muted">Marca todos los drones que salen: la camioneta y el auxiliar se reparten entre ellos.</p>' : ''}
        <div id="aviso-chk"></div>
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
    const pintar = async () => {
      const sel = $$('input[name=dron]:checked').map((i) => i.value);
      const loc = (await idb.get('chk:' + $('#fecha').value)) || {};
      const sinChk = sel.filter((d) => !checklistDe($('#fecha').value, d, loc));
      $('#aviso-chk').innerHTML = sinChk.length ? `<p class="note">Falta el checklist de salida de ${esc(sinChk.join(', '))}. <button type="button" class="linklike" data-go-chk>Hacerlo ahora</button></p>` : '';
      $('[data-go-chk]')?.addEventListener('click', () => ir('checklist'));
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
/* Duplicados: detección antes de guardar y utilidades                 */
/* ------------------------------------------------------------------ */
const nombreDe = (id) => S.perfiles.find((p) => p.id === id)?.nombre || '';
const conTimeout = (p, ms = 4000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const cuando = (ts) => (ts ? new Date(ts).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const msgError = (e) => (/anulado|duplicados_revisados|buscar_|duplicado_de/.test(e?.message || '')
  ? 'Falta ejecutar la migración 04 en Supabase (migracion_04_duplicados.sql).' : (e?.message || String(e)));

const sinAnulados = (j) => ({ ...j, jornada_drones: (j.jornada_drones || []).map((jd) => ({ ...jd, trabajos: (jd.trabajos || []).filter((t) => !t.anulado) })) });
const trabajosPlanos = (jornadas) => jornadas.flatMap((j) => (j.jornada_drones || []).flatMap((jd) => (jd.trabajos || []).map((t) => ({ ...t, fecha: j.fecha, dron: jd.dron_id }))));
const claveGrupo = (g) => g.map((x) => x.id).sort().join(',');
// Grupos de 2 o más registros iguales (trabajos: día+dron+cliente+finca; gastos: día+dron+categoría+valor)
function agruparDuplicados(trabajos, gastos, revisados = []) {
  const rev = new Set(revisados);
  const agrupar = (lista, clave) => {
    const m = new Map();
    for (const x of lista) {
      if (x.anulado) continue;
      const k = clave(x);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return [...m.values()].filter((g) => g.length > 1 && !rev.has(claveGrupo(g)))
      .map((g) => g.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));
  };
  return {
    trabajos: agrupar(trabajos, (t) => [t.fecha, t.dron, norm(t.cliente), norm(t.finca)].join('|')),
    gastos: agrupar(gastos.filter((g) => g.estado !== 'rechazado'), (g) => [g.fecha, g.dron_id || '', g.categoria, Number(g.valor)].join('|'))
  };
}

// Busca trabajos iguales: lo del servidor ya cargado, lo pendiente en este celular y, con señal, lo de todos los usuarios
async function trabajosSimilares({ fecha, dron, cliente, finca }) {
  const out = new Map();
  for (const j of S.jornadas) {
    if (j.fecha !== fecha) continue;
    for (const jd of j.jornada_drones || []) {
      if (jd.dron_id !== dron) continue;
      for (const t of jd.trabajos || []) {
        if (t.anulado || norm(t.cliente) !== norm(cliente) || norm(t.finca) !== norm(finca)) continue;
        out.set(t.id, { id: t.id, ha: Number(t.ha), quien: nombreDe(t.creado_por), cuando: t.created_at, pendiente: false });
      }
    }
  }
  const jdId = await idJD(fecha, dron);
  for (const it of await idb.all()) {
    const r = it.row;
    if (it.table !== 'trabajos' || r.jornada_dron_id !== jdId || norm(r.cliente) !== norm(cliente) || norm(r.finca) !== norm(finca)) continue;
    out.set(r.id, { id: r.id, ha: Number(r.ha), quien: 'este celular', cuando: it.creado, pendiente: true });
  }
  if (navigator.onLine) {
    try {
      const { data, error } = await conTimeout(sb.rpc('buscar_trabajo_duplicado', { p_fecha: fecha, p_dron: dron, p_cliente: cliente, p_finca: finca || '' }));
      if (!error) for (const t of data || []) if (!out.has(t.id)) out.set(t.id, { id: t.id, ha: Number(t.ha), quien: t.registrado_por || '', cuando: t.created_at, pendiente: false });
    } catch { /* sin señal o sin migración: vale lo que hay en el celular */ }
  }
  return [...out.values()];
}

async function gastosSimilares({ fecha, dron_id, categoria, valor }) {
  const out = new Map();
  const igual = (g) => !g.anulado && g.estado !== 'rechazado' && g.fecha === fecha && (g.dron_id || '') === (dron_id || '') && g.categoria === categoria && Number(g.valor) === valor;
  for (const g of S.gastos) {
    if (igual(g)) out.set(g.id, { id: g.id, valor: Number(g.valor), descripcion: g.descripcion, quien: nombreDe(g.creado_por), cuando: g.created_at, pendiente: false });
  }
  for (const it of await idb.all()) {
    if (it.table === 'gastos' && igual(it.row)) out.set(it.row.id, { id: it.row.id, valor: Number(it.row.valor), descripcion: it.row.descripcion, quien: 'este celular', cuando: it.creado, pendiente: true });
  }
  if (navigator.onLine) {
    try {
      const { data, error } = await conTimeout(sb.rpc('buscar_gasto_duplicado', { p_fecha: fecha, p_dron: dron_id || '', p_categoria: categoria, p_valor: valor }));
      if (!error) for (const g of data || []) if (!out.has(g.id)) out.set(g.id, { id: g.id, valor: Number(g.valor), descripcion: g.descripcion, quien: g.registrado_por || '', cuando: g.created_at, pendiente: false });
    } catch { /* igual que arriba */ }
  }
  return [...out.values()];
}

// Ventana con varias opciones; devuelve el valor del botón elegido
function preguntar({ titulo, html, opciones }) {
  return new Promise((res) => {
    const ov = document.createElement('div');
    ov.className = 'modal-bg';
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(titulo)}"><h2>${esc(titulo)}</h2>${html}
      <div class="modal-btns">${opciones.map((o, i) => `<button type="button" class="btn ${o.clase || ''}" data-i="${i}">${esc(o.texto)}</button>`).join('')}</div></div>`;
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      ov.remove();
      res(opciones[Number(b.dataset.i)].valor);
    });
    document.body.appendChild(ov);
    ov.querySelector('button')?.focus();
  });
}
const OPCIONES_DUP = [
  { texto: 'Es el mismo, no guardar', valor: 'mismo' },
  { texto: 'Es otro, guardar igual', valor: 'nuevo', clase: 'secondary' },
  { texto: 'Volver a revisar', valor: 'volver', clase: 'secondary' }
];
const quienCuando = (s) => `Registrado por ${esc(s.quien || 'otro usuario')} · ${esc(cuando(s.cuando))}${s.pendiente ? ' · aún sin subir' : ''}`;

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
    let ocupado = false; // evita guardar dos veces si se toca el botón repetido
    $('#f-t').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (ocupado) return;
      const fecha = $('#fecha').value, dron = $('#dron').value, tipo = $('#tipo').value;
      const ha = num($('#ha').value);
      if (!ha || ha <= 0) return toast('Ingresa las hectáreas');
      ocupado = true;
      try {
      // ¿Ya hay un trabajo igual (mismo día, dron, cliente y finca)? Se pregunta antes de crear nada
      const similares = await trabajosSimilares({ fecha, dron, cliente: $('#cliente').value.trim(), finca: $('#finca').value.trim() });
      if (similares.length) {
        const r = await preguntar({
          titulo: 'Ya hay un trabajo parecido',
          html: `<p class="muted">Mismo día, dron, cliente y finca:</p>
            <ul class="list">${similares.map((s) => `<li><div><div class="t">${esc(s.ha.toLocaleString('es-CO'))} Ha</div><div class="muted">${quienCuando(s)}</div></div></li>`).join('')}</ul>
            <p class="muted">Tú vas a guardar <b>${esc(ha.toLocaleString('es-CO'))} Ha</b>. ¿Es el mismo trabajo?</p>`,
          opciones: OPCIONES_DUP
        });
        if (r === 'volver') return;
        if (r === 'mismo') { toast('No se guardó: ya estaba registrado'); ir('inicio', {}, true); return; }
      }
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
      } finally { ocupado = false; }
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
    let ocupado = false;
    $('#f-g').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (ocupado) return;
      const valor = soloDigitos($('#valor').value);
      if (!valor) return toast('Ingresa el valor');
      const foto = $('#foto').files?.[0];
      if (!foto && !esAdmin() && !confirm('No adjuntaste foto del soporte. Sin soporte el gasto puede ser rechazado. ¿Guardar igual?')) return;
      ocupado = true;
      try {
      // ¿Ya hay un gasto igual (mismo día, dron, categoría y valor)?
      const similares = await gastosSimilares({ fecha: $('#fecha').value, dron_id: $('#dron').value || null, categoria: $('#cat').value, valor });
      if (similares.length) {
        const r = await preguntar({
          titulo: 'Ya hay un gasto igual',
          html: `<p class="muted">Mismo día, dron, categoría y valor (<b>${money(valor)}</b>):</p>
            <ul class="list">${similares.map((s) => `<li><div><div class="t">${esc(s.descripcion || 'Sin descripción')}</div><div class="muted">${quienCuando(s)}</div></div></li>`).join('')}</ul>
            <p class="muted">Si son dos pagos distintos (por ejemplo, dos peajes iguales), guárdalo como otro.</p>`,
          opciones: OPCIONES_DUP
        });
        if (r === 'volver') return;
        if (r === 'mismo') { toast('No se guardó: ya estaba registrado'); ir('inicio', {}, true); return; }
      }
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
      } finally { ocupado = false; }
    });
  }
};

/* ------------------------------------------------------------------ */
/* Vista: checklist de salida                                          */
/* ------------------------------------------------------------------ */
const CHECKLIST = [
  ['dron', 'Dron'], ['generador', 'Generador'], ['baterias', 'Baterías'], ['baterias_rtk', 'Baterías RTK'],
  ['rtk_tripode', 'RTK + trípode'], ['relay', 'Relay'], ['cargadores', 'Cargadores'], ['control', 'Control'],
  ['gasolina', 'Gasolina'], ['aditivo', 'Aditivo'], ['diesel', 'Diésel'], ['sillas', 'Sillas']
];
const faltantes = (c) => CHECKLIST.filter(([k]) => !c.items?.[k]).map(([, t]) => t);
function checklistDe(fecha, dron, local = {}) {
  return local[dron] || S.checklists.find((c) => c.fecha === fecha && c.dron_id === dron);
}
rutas.checklist = {
  titulo: 'Checklist de salida',
  html: () => {
    const mis = misDrones();
    const def = dronPorDefecto();
    return `<form id="f-ck">
      <div class="card">
        <label for="fecha">Fecha</label>
        <input id="fecha" type="date" value="${hoy()}" required>
        <label>Dron(es)</label>
        <div class="chips">${mis.map((d) => `<label class="chip"><input type="checkbox" name="dron" value="${d.id}" ${d.id === def ? 'checked' : ''}>${esc(d.id)}</label>`).join('')}</div>
      </div>
      <div class="card">
        <div class="ck-head"><h2>Verifica que lleves</h2><button type="button" class="linklike" id="ck-todo">Marcar todo</button></div>
        <div class="ck-list">${CHECKLIST.map(([k, t]) => `<label class="ck-item"><input type="checkbox" name="item" value="${k}"><span>${t}</span></label>`).join('')}</div>
        <p class="muted" id="ck-cuenta"></p>
        <label for="notas">Notas</label>
        <textarea id="notas" placeholder="Ej: falta un cargador, se lleva el de repuesto"></textarea>
      </div>
      <button class="btn" type="submit">Guardar checklist</button>
    </form>`;
  },
  init: () => {
    const cuenta = () => {
      const n = $$('input[name=item]:checked').length;
      $('#ck-cuenta').textContent = n === CHECKLIST.length ? 'Todo listo ✓' : `${n} de ${CHECKLIST.length} verificados`;
    };
    $$('input[name=item]').forEach((i) => i.addEventListener('change', cuenta));
    $('#ck-todo').addEventListener('click', () => { $$('input[name=item]').forEach((i) => (i.checked = true)); cuenta(); });
    cuenta();
    $('#f-ck').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fecha = $('#fecha').value;
      const drones = $$('input[name=dron]:checked').map((i) => i.value);
      if (!drones.length) return toast('Marca el dron');
      const items = Object.fromEntries(CHECKLIST.map(([k]) => [k, !!$(`input[name=item][value="${k}"]`).checked]));
      const completo = Object.values(items).every(Boolean);
      const notas = $('#notas').value.trim() || null;
      if (!completo) {
        const f = CHECKLIST.filter(([k]) => !items[k]).map(([, t]) => t).join(', ');
        if (!confirm(`Falta: ${f}.\n\n¿Guardar el checklist así?`)) return;
      }
      const local = (await idb.get('chk:' + fecha)) || {};
      for (const dron of drones) {
        const row = { id: uuid(), fecha, dron_id: dron, items, completo, notas };
        await encolar({ op: 'upsert', table: 'checklists', row, ignore: true }, `Checklist ${dron} ${fecha}`);
        local[dron] = row;
      }
      await idb.set('chk:' + fecha, local);
      toast(completo ? 'Checklist completo ✓' : 'Checklist guardado con faltantes');
      const dia = (await idb.get('dia:' + fecha)) || { drones: {} };
      const yaIniciada = drones.every((d) => dia.drones[d]?.iniciada);
      pila = [{ nombre: 'inicio', params: {} }];
      ir(yaIniciada ? 'inicio' : 'jornada', {}, yaIniciada);
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
        ${S.checklists.filter((c) => c.fecha === j.fecha && (esAdmin() || misDrones().some((d) => d.id === c.dron_id))).map((c) => `<p class="muted">Checklist ${esc(c.dron_id)}: ${c.completo ? '✓ completo' : '⚠ faltó ' + esc(faltantes(c).join(', '))}${c.notas ? ' · ' + esc(c.notas) : ''}</p>`).join('')}
        <ul class="list">${jds.flatMap((jd) => (jd.trabajos || []).map((t) => `<li><div><div class="t">${esc(t.cliente)}${t.finca ? ' · ' + esc(t.finca) : ''}</div>
          <div class="muted">${esc(jd.dron_id)} · ${esc(t.cultivo || '')} · ${t.litros_ha ? esc(t.litros_ha) + ' L/Ha' : esc(t.tipo_servicio)}</div></div>
          <div class="stack"><span class="badge">${esc(t.ha)} Ha</span>${esAdmin() ? `<button class="btn small danger" data-anular="trabajos:${esc(t.id)}:${esc(j.fecha)}:${esc(jd.dron_id)}">Anular</button>` : ''}</div></li>`)).join('') || '<li class="muted">Sin trabajos registrados</li>'}</ul></div>`;
    }).join('');
  },
  init: () => conectarAnular()
};

const badgeEstado = (e) => e === 'aprobado' ? '<span class="badge">Aprobado</span>' : e === 'rechazado' ? '<span class="badge danger">Rechazado</span>' : '<span class="badge warn">Pendiente</span>';
rutas.gastos = {
  titulo: 'Mis gastos',
  html: () => {
    const lista = esAdmin() ? S.gastos : S.gastos.filter((g) => g.creado_por === S.user.id || misDrones().some((d) => d.id === g.dron_id));
    if (!lista.length) return '<div class="card"><p class="muted">No hay gastos en los últimos 45 días.</p></div>';
    return `<div class="card"><ul class="list">${lista.map((g) => `<li><div><div class="t">${esc(nombreCat(g.categoria))} · <span class="money">${money(g.valor)}</span></div>
      <div class="muted">${esc(g.fecha)} · ${esc(g.dron_id || 'General')}${g.descripcion ? ' · ' + esc(g.descripcion) : ''}</div></div><div class="stack">${badgeEstado(g.estado)}${esAdmin() ? `<button class="btn small danger" data-anular="gastos:${esc(g.id)}:${esc(g.fecha)}:${esc(g.dron_id || '')}">Anular</button>` : ''}</div></li>`).join('')}</ul></div>`;
  },
  init: () => conectarAnular()
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
    const { data: bruto, error } = await sb.from('gastos').select('*').eq('estado', 'pendiente').order('fecha');
    const data = (bruto || []).filter((g) => !g.anulado);
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
/* Administración: anular, revisar y fusionar duplicados               */
/* ------------------------------------------------------------------ */
// La app no guarda "liquidaciones cerradas": avisa cuando el registro es de un mes que ya pasó
// o de un dron que entra en la liquidación con el aliado.
function avisoLiquidacion(fecha, dronId) {
  const msgs = [];
  const d = S.drones.find((x) => x.id === dronId);
  if (d && d.propietario !== 'COLFOG') msgs.push(`El dron ${dronId} entra en la liquidación con Martin Ruiz.`);
  if (fecha && fecha.slice(0, 7) < hoy().slice(0, 7)) msgs.push(`El registro es de ${fecha.slice(0, 7)}, un mes que ya terminó. Si ya liquidaste o facturaste ese mes, el valor cambia y habrá que ajustarlo.`);
  return msgs.length ? '⚠ ' + msgs.join('\n⚠ ') + '\n\n' : '';
}

async function anularRegistro(tabla, id, fecha, dron) {
  if (!navigator.onLine) return toast('Necesitas señal para anular');
  const motivo = prompt(`${avisoLiquidacion(fecha, dron)}Motivo de la anulación (el registro no se borra, se puede restaurar):`, 'Duplicado');
  if (motivo === null) return;
  const { data, error } = await sb.from(tabla).update({ anulado: true, anulado_motivo: motivo.trim() || 'Sin motivo', anulado_por: S.user.id, anulado_at: new Date().toISOString() }).eq('id', id).select('id');
  if (error || !data?.length) return toast(error ? msgError(error) : 'No se pudo anular');
  toast('Registro anulado');
  await cargarDatos();
  render();
}
function conectarAnular() {
  $$('[data-anular]').forEach((b) => b.addEventListener('click', () => {
    const [tabla, id, fecha, dron] = b.dataset.anular.split(':');
    anularRegistro(tabla, id, fecha, dron);
  }));
}

async function cargarParaDuplicados() {
  const desde = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const [jor, gas, rev] = await Promise.all([
    sb.from('jornadas').select('id, fecha, jornada_drones(id, dron_id, trabajos(*))').gte('fecha', desde).order('fecha', { ascending: false }),
    sb.from('gastos').select('*').gte('fecha', desde).order('fecha', { ascending: false }),
    sb.from('duplicados_revisados').select('clave')
  ]);
  if (jor.error) throw jor.error;
  if (gas.error) throw gas.error;
  if (rev.error) throw rev.error;
  S.dupRev = (rev.data || []).map((x) => x.clave);
  return { trabajos: trabajosPlanos(jor.data || []), gastos: gas.data || [], revisados: S.dupRev };
}

// Conserva un registro, completa sus campos vacíos con los del duplicado y anula los demás
async function fusionarDuplicados(tabla, grupo, keepId) {
  const keep = grupo.find((x) => x.id === keepId);
  const otros = grupo.filter((x) => x.id !== keepId);
  const campos = tabla === 'trabajos' ? ['finca', 'municipio', 'cultivo', 'litros_ha', 'precio_id', 'notas'] : ['descripcion', 'soporte'];
  const completar = {};
  for (const o of otros) {
    for (const c of campos) {
      if ((keep[c] == null || keep[c] === '') && o[c] != null && o[c] !== '' && completar[c] == null) completar[c] = o[c];
    }
  }
  const ahora = new Date().toISOString();
  for (const o of otros) {
    const { data, error } = await sb.from(tabla).update({ anulado: true, anulado_motivo: 'Duplicado', anulado_por: S.user.id, anulado_at: ahora, duplicado_de: keepId }).eq('id', o.id).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('No se pudo anular el duplicado');
  }
  if (Object.keys(completar).length) {
    const { error } = await sb.from(tabla).update(completar).eq('id', keepId);
    if (error) throw error;
  }
}

let DUP = null; // datos de la vista de duplicados (para los botones)
rutas.duplicados = {
  titulo: 'Posibles duplicados',
  html: async () => {
    if (!esAdmin()) return '<div class="card"><p class="muted">Solo para COLFOG.</p></div>';
    if (!navigator.onLine) return '<div class="card"><p class="note">Necesitas señal para revisar duplicados.</p></div>';
    let D;
    try { D = await cargarParaDuplicados(); } catch (e) { return `<div class="card"><p class="note">${esc(msgError(e))}</p></div>`; }
    const G = agruparDuplicados(D.trabajos, D.gastos, D.revisados);
    DUP = { grupos: G, todos: D };
    const tarjetaT = (g, i) => `<div class="card" data-grupo="trabajos:${i}"><h2>${esc(g[0].cliente)}${g[0].finca ? ' · ' + esc(g[0].finca) : ''}</h2>
      <p class="muted">${esc(fechaLarga(g[0].fecha))} · ${esc(g[0].dron)}</p>
      <ul class="list">${g.map((t) => `<li><div><div class="t">${esc(Number(t.ha).toLocaleString('es-CO'))} Ha${t.litros_ha ? ' · ' + esc(t.litros_ha) + ' L/Ha' : ''}</div>
        <div class="muted">${esc(nombreDe(t.creado_por) || '—')} · ${esc(cuando(t.created_at))}${t.notas ? ' · ' + esc(t.notas) : ''}</div></div>
        <button class="btn small" data-conservar="${esc(t.id)}">Conservar este</button></li>`).join('')}</ul>
      <button class="btn small secondary" data-no-dup="trabajos:${i}">No son duplicados</button></div>`;
    const tarjetaG = (g, i) => `<div class="card" data-grupo="gastos:${i}"><h2>${esc(nombreCat(g[0].categoria))} · <span class="money">${money(g[0].valor)}</span></h2>
      <p class="muted">${esc(fechaLarga(g[0].fecha))} · ${esc(g[0].dron_id || 'General')}</p>
      <ul class="list">${g.map((x) => `<li><div><div class="t">${esc(x.descripcion || 'Sin descripción')}</div>
        <div class="muted">${esc(nombreDe(x.creado_por) || '—')} · ${esc(cuando(x.created_at))} · ${x.soporte ? 'con foto' : 'sin foto'} · ${esc(x.estado)}</div></div>
        <button class="btn small" data-conservar="${esc(x.id)}">Conservar este</button></li>`).join('')}</ul>
      <button class="btn small secondary" data-no-dup="gastos:${i}">No son duplicados</button></div>`;
    const resumen = (tabla, x) => (tabla === 'trabajos'
      ? `${esc(x.cliente)}${x.finca ? ' · ' + esc(x.finca) : ''} · ${esc(Number(x.ha).toLocaleString('es-CO'))} Ha`
      : `${esc(nombreCat(x.categoria))} · ${money(x.valor)}`);
    const anulados = [...D.trabajos.filter((t) => t.anulado).map((x) => ['trabajos', x]), ...D.gastos.filter((g) => g.anulado).map((x) => ['gastos', x])]
      .sort((a, b) => String(b[1].anulado_at || '').localeCompare(String(a[1].anulado_at || '')));
    return `<p class="muted">Últimos 90 días. Trabajos: mismo día, dron, cliente y finca. Gastos: mismo día, dron, categoría y valor. Elige cuál conservar: los demás se anulan (no se borran) y dejan de contar en el tablero y la liquidación.</p>
      ${G.trabajos.length || G.gastos.length ? G.trabajos.map(tarjetaT).join('') + G.gastos.map(tarjetaG).join('') : '<div class="card"><p>No hay posibles duplicados.</p></div>'}
      ${anulados.length ? `<div class="card"><h2>Anulados</h2><ul class="list">${anulados.map(([tabla, x]) => `<li><div><div class="t">${resumen(tabla, x)}</div>
        <div class="muted">${esc(x.fecha)} · ${esc(x.anulado_motivo || '')}${x.anulado_por ? ' · ' + esc(nombreDe(x.anulado_por)) : ''}</div></div>
        <button class="btn small secondary" data-restaurar="${tabla}:${esc(x.id)}">Restaurar</button></li>`).join('')}</ul></div>` : ''}`;
  },
  init: () => {
    $$('[data-conservar]').forEach((b) => b.addEventListener('click', async () => {
      const [tabla, i] = b.closest('[data-grupo]').dataset.grupo.split(':');
      const grupo = DUP.grupos[tabla][Number(i)];
      const otros = grupo.filter((x) => x.id !== b.dataset.conservar);
      // en gastos solo importa si lo que se anula ya estaba aprobado (cuenta en la liquidación)
      const cuenta = tabla === 'trabajos' || otros.some((x) => x.estado === 'aprobado');
      const aviso = cuenta ? avisoLiquidacion(grupo[0].fecha, tabla === 'trabajos' ? grupo[0].dron : grupo[0].dron_id) : '';
      if (!confirm(`Se conserva este registro y se anula${otros.length > 1 ? 'n' : ''} ${otros.length} duplicado${otros.length > 1 ? 's' : ''}.\n\n${aviso}¿Continuar?`)) return;
      b.disabled = true;
      try {
        await fusionarDuplicados(tabla, grupo, b.dataset.conservar);
        toast('Duplicado anulado');
        await cargarDatos();
        render();
      } catch (e) { toast(msgError(e)); b.disabled = false; }
    }));
    $$('[data-no-dup]').forEach((b) => b.addEventListener('click', async () => {
      const [tabla, i] = b.dataset.noDup.split(':');
      const grupo = DUP.grupos[tabla][Number(i)];
      const { error } = await sb.from('duplicados_revisados').upsert({ clave: claveGrupo(grupo) });
      if (error) return toast(msgError(error));
      toast('Marcado: no son duplicados');
      await cargarDatos();
      render();
    }));
    $$('[data-restaurar]').forEach((b) => b.addEventListener('click', async () => {
      const [tabla, id] = b.dataset.restaurar.split(':');
      const x = (tabla === 'trabajos' ? DUP.todos.trabajos : DUP.todos.gastos).find((r) => r.id === id);
      const aviso = x ? avisoLiquidacion(x.fecha, tabla === 'trabajos' ? x.dron : x.dron_id) : '';
      if (!confirm(`Se restaura este registro y vuelve a contar en el tablero.\n\n${aviso}¿Continuar?`)) return;
      const { data, error } = await sb.from(tabla).update({ anulado: false, anulado_motivo: null, anulado_por: null, anulado_at: null, duplicado_de: null }).eq('id', id).select('id');
      if (error || !data?.length) return toast(error ? msgError(error) : 'No se pudo restaurar');
      toast('Registro restaurado');
      await cargarDatos();
      render();
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
