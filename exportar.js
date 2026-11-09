/* ------------------------------------------------------------------ */
/* Exportar a Excel (admin y consulta)                                 */
/* Se carga después de tablero.js; usa sus cálculos para que el Excel  */
/* coincida con lo que se ve en el tablero.                            */
/* ------------------------------------------------------------------ */
function cargarXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js?v=' + CFG.APP_VERSION;
    s.onload = res;
    s.onerror = () => rej(new Error('No se pudo cargar el generador de Excel. Revisa la señal e intenta de nuevo.'));
    document.head.appendChild(s);
  });
}

const aFecha = (iso) => (iso ? new Date(iso + 'T12:00:00') : '');
const aFechaHora = (ts) => (ts ? new Date(ts) : '');
// El día de piloto por servicio solo aplica en drones que no son del aliado (igual que en el tablero)
const cobraServicio = (jd) => jd.piloto_servicio && S.drones.find((d) => d.id === jd.dron_id)?.propietario !== 'ALIADO';
const SERVICIO = { aspersion: 'Aspersión', paquete: 'Paquete Multiseres', mapeo: 'Mapeo' };
const PROPIETARIO = { COLFOG: 'COLFOG', ALIADO: 'Aliado', COMPARTIDO: 'Sociedad' };

// Hoja con encabezado, formatos por columna, filtros y anchos
function hojaTabla(XL, filas, { dinero = [], decimal = [], fecha = [], fechaHora = [], porcentaje = [], anchos = [] } = {}) {
  const ws = XL.utils.aoa_to_sheet(filas, { cellDates: true });
  const fin = XL.utils.decode_range(ws['!ref']).e.r;
  const poner = (cols, z) => {
    for (const c of cols) for (let r = 1; r <= fin; r++) {
      const cel = ws[XL.utils.encode_cell({ r, c })];
      if (cel && (cel.t === 'n' || cel.t === 'd')) cel.z = z;
    }
  };
  poner(dinero, '#,##0'); poner(decimal, '#,##0.0'); poner(fecha, 'yyyy-mm-dd');
  poner(fechaHora, 'yyyy-mm-dd hh:mm'); poner(porcentaje, '0%');
  ws['!cols'] = anchos.map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  return ws;
}

async function datosParaExcel(desde, hasta) {
  const [jor, gas, chk] = await Promise.all([
    sb.from('jornadas').select('*, jornada_drones(*, trabajos(*), lecturas(*))').gte('fecha', desde).lte('fecha', hasta).order('fecha'),
    sb.from('gastos').select('*').gte('fecha', desde).lte('fecha', hasta).order('fecha'),
    sb.from('checklists').select('*').gte('fecha', desde).lte('fecha', hasta).order('fecha')
  ]);
  if (jor.error) throw jor.error;
  if (gas.error) throw gas.error;
  const r = { jornadas: jor.data || [], gastos: gas.data || [], checklists: chk.error ? [] : (chk.data || []) };
  // El servidor entrega máximo 1.000 filas por consulta: si se llega al tope, el archivo podría quedar incompleto
  if (r.jornadas.length >= 1000 || r.gastos.length >= 1000 || r.checklists.length >= 1000) {
    throw new Error('Hay más de 1.000 registros en ese rango. Descarga por periodos más cortos (por ejemplo, un trimestre).');
  }
  return r;
}

async function generarExcel(desde, hasta) {
  await cargarXLSX();
  const XL = window.XLSX;
  const raw = await datosParaExcel(desde, hasta);
  const jornadas = raw.jornadas.map(sinAnulados);
  const gastos = raw.gastos.filter((g) => !g.anulado);
  const R = calcularTablero({ jornadas, gastos });
  const { D, L, C } = R;
  const nom = (id) => nombreDe(id) || '';
  const redondo = (n) => Math.round(Number(n) || 0);
  const wb = XL.utils.book_new();

  /* 1. Resumen por dron + liquidaciones */
  const cab = ['Dron', 'Propietario', 'Días de vuelo', 'Hectáreas', 'Ingresos estimados', 'Camioneta', 'Diésel', 'Auxiliar de vuelo', 'Piloto por servicio', 'Gastos aprobados',
    'Fijo COLFOG', 'Variable COLFOG', 'Utilidad de caja', 'Desgaste baterías', 'Desgaste generador', 'Utilidad económica'];
  const filasDron = S.drones.map((d) => {
    const x = D[d.id] || {};
    return [d.id, PROPIETARIO[d.propietario] || d.propietario, x.dias || 0, x.ha || 0, redondo(x.ingreso), redondo(x.camioneta), redondo(x.diesel), redondo(x.auxiliar), redondo(x.pilotoServicio),
      redondo(x.gastos), redondo(x.fijo), redondo(x.variable), redondo(x.utilidadCaja), redondo(x.depBaterias), redondo(x.depGenerador), redondo(x.utilidadEconomica)];
  });
  const total = ['Total', '', ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((i) => filasDron.reduce((s, f) => s + f[i], 0))];
  const resumen = [
    ['COLFOG MIP S.A.S. · Línea de drones'],
    ['Periodo', `${desde} a ${hasta}`],
    ['Generado', new Date().toLocaleString('es-CO')],
    [],
    cab, ...filasDron, total
  ];
  const filaTablaFin = resumen.length;       // última fila de la tabla (1-indexada = resumen.length)
  const liqIni = resumen.length;             // índice (0) de la siguiente fila vacía
  if (R.idsAliado.length) {
    resumen.push([], [`Liquidación del aliado · ${R.idsAliado.join(', ')} (por trabajo)`], ['Ingresos facturables', redondo(L.ingreso)], ['Fijo COLFOG', redondo(L.fijo)],
      ['Variable COLFOG', redondo(L.variable)], ['Parte del aliado', redondo(L.parte)], ['Retención', redondo(L.retencion)], ['Neto a pagar al aliado', redondo(L.neto)]);
  }
  if (R.idsComp.length) {
    resumen.push([], [`Liquidación sociedad · ${R.idsComp.join(', ')} (mensual)`], ['Ingresos', redondo(C.ingreso)], ['Utilidad de caja del periodo', redondo(C.utilidadCaja)],
      [`Parte del aliado (${Math.round(C.pctAli * 100)}%)`, redondo(C.parteAliado)], ['Reembolso de gastos que pagó el aliado', redondo(C.gastosPagadosAliado)],
      ['Factura del aliado a COLFOG', redondo(C.factura)], ['Retención', redondo(C.retencion)], [C.factura >= 0 ? 'Neto a pagar al aliado' : 'El aliado debe aportar', redondo(Math.abs(C.neto))],
      [`Parte de COLFOG (${Math.round((1 - C.pctAli) * 100)}%)`, redondo(C.parteColfog)]);
  }
  if (R.piloto.dias) {
    resumen.push([], ['Servicio de piloto · Martin Ruiz a COLFOG'],
      ...R.piloto.detalle.map((t) => [`${t.fecha} · ${t.dron}`, redondo(t.valor)]),
      [`Total (${R.piloto.dias} ${R.piloto.dias === 1 ? 'día' : 'días'})`, redondo(R.piloto.total)], ['Retención', redondo(R.piloto.retencion)], ['Neto a pagar', redondo(R.piloto.neto)]);
  }
  resumen.push([], ['Valores estimados con la lista de precios y los parámetros vigentes. La liquidación definitiva se hace sobre lo facturado.']);
  const wsRes = XL.utils.aoa_to_sheet(resumen);
  for (const k of Object.keys(wsRes)) {
    if (k[0] === '!') continue;
    if (wsRes[k].t === 'n') wsRes[k].z = '#,##0';
  }
  for (let r = 5; r < filaTablaFin; r++) { // columna D = hectáreas
    const cel = wsRes[XL.utils.encode_cell({ r, c: 3 })];
    if (cel && cel.t === 'n') cel.z = '#,##0.0';
  }
  wsRes['!cols'] = [{ wch: 38 }, { wch: 16 }, ...Array(14).fill({ wch: 16 })];
  XL.utils.book_append_sheet(wb, wsRes, 'Resumen');

  /* 2. Trabajos */
  const trabajos = [...R.trabajos].sort((a, b) => (a.fecha + a.dron).localeCompare(b.fecha + b.dron));
  XL.utils.book_append_sheet(wb, hojaTabla(XL, [
    ['Fecha', 'Dron', 'Cliente', 'Finca', 'Municipio', 'Cultivo', 'Servicio', 'Hectáreas', 'Litros/Ha', 'Ingreso estimado', 'Costo operación asignado', 'Gastos asignados', 'Notas', 'Registrado por', 'Creado'],
    ...trabajos.map((t) => [aFecha(t.fecha), t.dron, t.cliente, t.finca || '', t.municipio || '', t.cultivo || '', SERVICIO[t.tipo_servicio] || t.tipo_servicio,
      Number(t.ha), t.litros_ha == null ? '' : Number(t.litros_ha), redondo(t.ingreso), redondo(t.costoDia), redondo(t.gastos), t.notas || '', nom(t.creado_por), aFechaHora(t.created_at)])
  ], { fecha: [0], decimal: [7], dinero: [9, 10, 11], fechaHora: [14], anchos: [12, 8, 26, 22, 16, 14, 20, 11, 10, 16, 18, 16, 30, 22, 17] }), 'Trabajos');

  /* 3. Gastos (todos los estados; los anulados van en su propia hoja) */
  XL.utils.book_append_sheet(wb, hojaTabla(XL, [
    ['Fecha', 'Dron', 'Categoría', 'Descripción', 'Valor', 'Estado', 'Registrado por', 'Revisado por', 'Con soporte (foto)', 'Creado', 'ID'],
    ...gastos.map((g) => [aFecha(g.fecha), g.dron_id || 'General', nombreCat(g.categoria), g.descripcion || '', Number(g.valor), g.estado, nom(g.creado_por), nom(g.revisado_por), g.soporte ? 'Sí' : 'No', aFechaHora(g.created_at), g.id])
  ], { fecha: [0], dinero: [4], fechaHora: [9], anchos: [12, 10, 30, 36, 14, 12, 22, 22, 16, 17, 38] }), 'Gastos');

  /* 4. Jornadas */
  XL.utils.book_append_sheet(wb, hojaTabla(XL, [
    ['Fecha', 'Drones', 'Pilotos', 'Servicio de piloto (dron)', 'Pago por servicio ($)', 'Camioneta', 'Odómetro inicial', 'Odómetro final', 'Km', 'Diésel ($)', 'Auxiliar de vuelo', 'Notas', 'Registrado por'],
    ...jornadas.map((j) => {
      const jds = j.jornada_drones || [];
      const km = j.odometro_fin != null && j.odometro_ini != null ? Number(j.odometro_fin) - Number(j.odometro_ini) : '';
      return [aFecha(j.fecha), jds.map((x) => x.dron_id).join(' + '), [...new Set(jds.map((x) => nom(x.piloto_id)).filter(Boolean))].join(', '),
        jds.filter(cobraServicio).map((x) => x.dron_id).join(' + '), redondo(jds.filter(cobraServicio).reduce((s, x) => s + (Number(x.pago_piloto) || 0), 0)), j.usa_camioneta ? 'Sí' : 'No',
        j.odometro_ini == null ? '' : Number(j.odometro_ini), j.odometro_fin == null ? '' : Number(j.odometro_fin), km, redondo(j.diesel_valor), j.auxiliar ? 'Sí' : 'No', j.notas || '', nom(j.creado_por)];
    })
  ], { fecha: [0], dinero: [4, 6, 7, 8, 9], anchos: [12, 16, 26, 20, 18, 11, 16, 15, 9, 14, 16, 30, 22] }), 'Jornadas');

  /* 5. Lecturas de baterías y generador */
  const activoPorId = Object.fromEntries(S.activos.map((a) => [a.id, a]));
  const lecturas = [];
  for (const j of jornadas) for (const jd of j.jornada_drones || []) for (const l of jd.lecturas || []) {
    const a = activoPorId[l.activo_id];
    const uso = l.fin == null ? '' : Math.max(0, Number(l.fin) - Number(l.inicio));
    const dep = a && uso !== '' && Number(a.vida_util) > 0 ? redondo(uso * Number(a.precio) / Number(a.vida_util)) : '';
    lecturas.push([aFecha(j.fecha), jd.dron_id, a ? nombreActivo(a) : '(equipo retirado)', Number(l.inicio), l.fin == null ? '' : Number(l.fin), uso, dep]);
  }
  XL.utils.book_append_sheet(wb, hojaTabla(XL, [['Fecha', 'Dron', 'Equipo', 'Lectura inicial', 'Lectura final', 'Uso', 'Desgaste ($)'], ...lecturas],
    { fecha: [0], decimal: [3, 4, 5], dinero: [6], anchos: [12, 8, 36, 15, 14, 10, 14] }), 'Lecturas');

  /* 6. Checklists de salida */
  XL.utils.book_append_sheet(wb, hojaTabla(XL, [
    ['Fecha', 'Dron', 'Completo', 'Faltó', 'Notas', 'Registrado por'],
    ...raw.checklists.map((c) => [aFecha(c.fecha), c.dron_id, c.completo ? 'Sí' : 'No', faltantes(c).join(', '), c.notas || '', nom(c.creado_por)])
  ], { fecha: [0], anchos: [12, 8, 10, 40, 36, 22] }), 'Checklists');

  /* 7. Equipos (estado actual de baterías y generadores) */
  XL.utils.book_append_sheet(wb, hojaTabla(XL, [
    ['Dron', 'Tipo', 'Equipo', 'Modelo', 'Precio', 'Vida útil', 'Lectura actual', '% de vida útil'],
    ...S.activos.map((a) => {
      const u = S.ultimas[a.id];
      return [a.dron_id, a.tipo === 'generador' ? 'Generador (horas)' : 'Batería (ciclos)', a.etiqueta, a.modelo || '', Number(a.precio), Number(a.vida_util),
        u == null ? '' : Number(u), u == null || !(Number(a.vida_util) > 0) ? '' : Number(u) / Number(a.vida_util)];
    })
  ], { dinero: [4, 5], decimal: [6], porcentaje: [7], anchos: [8, 18, 10, 12, 14, 11, 15, 14] }), 'Equipos');

  /* 8. Anulados (duplicados), para que quede el rastro */
  const anulados = [
    ...trabajosPlanos(raw.jornadas).filter((t) => t.anulado).map((t) => ['Trabajo', aFecha(t.fecha), t.dron, `${t.cliente}${t.finca ? ' · ' + t.finca : ''}`, `${Number(t.ha)} Ha`, t.anulado_motivo || '', nom(t.anulado_por), aFechaHora(t.anulado_at)]),
    ...raw.gastos.filter((g) => g.anulado).map((g) => ['Gasto', aFecha(g.fecha), g.dron_id || 'General', `${nombreCat(g.categoria)}${g.descripcion ? ' · ' + g.descripcion : ''}`, redondo(g.valor), g.anulado_motivo || '', nom(g.anulado_por), aFechaHora(g.anulado_at)])
  ];
  XL.utils.book_append_sheet(wb, hojaTabla(XL, [['Tipo', 'Fecha', 'Dron', 'Detalle', 'Ha / Valor', 'Motivo', 'Anulado por', 'Fecha de anulación'], ...anulados],
    { fecha: [1], fechaHora: [7], anchos: [9, 12, 10, 44, 14, 18, 22, 17] }), 'Anulados');

  XL.writeFile(wb, `COLFOG_drones_${desde}_a_${hasta}.xlsx`);
  return { trabajos: trabajos.length, gastos: gastos.length, jornadas: jornadas.length };
}

rutas.exportar = {
  titulo: 'Descargar Excel',
  html: () => {
    if (!(esAdmin() || esConsulta())) return '<div class="card"><p class="muted">Esta opción es para COLFOG.</p></div>';
    return `<div class="card"><h2>Archivo de Excel</h2>
      <p class="muted">Un solo archivo con 8 hojas: resumen por dron y liquidaciones, trabajos, gastos, jornadas, lecturas de baterías y generador, checklists, equipos y registros anulados.</p>
      <div class="filtros" role="group" aria-label="Periodo rápido">
        <button type="button" class="pill" data-rango="mes">Este mes</button>
        <button type="button" class="pill" data-rango="mes_ant">Mes anterior</button>
        <button type="button" class="pill" data-rango="90">90 días</button>
        <button type="button" class="pill on" data-rango="anio">Este año</button>
      </div>
      <div class="row">
        <div><label for="x-desde">Desde</label><input id="x-desde" type="date" value="${rangoPeriodo('anio')[0]}"></div>
        <div><label for="x-hasta">Hasta</label><input id="x-hasta" type="date" value="${hoy()}"></div>
      </div>
      ${navigator.onLine ? '' : '<p class="note">Necesitas señal para descargar el Excel.</p>'}
      <button class="btn" id="x-bajar" ${navigator.onLine ? '' : 'disabled'}>Descargar Excel</button>
    </div>
    <p class="muted">Los valores de ingresos son estimados con la lista de precios vigente, igual que en el tablero.</p>`;
  },
  init: () => {
    $$('[data-rango]').forEach((b) => b.addEventListener('click', () => {
      const [d, h] = rangoPeriodo(b.dataset.rango);
      $('#x-desde').value = d; $('#x-hasta').value = h;
      $$('[data-rango]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('#x-bajar').addEventListener('click', async (e) => {
      const desde = $('#x-desde').value, hasta = $('#x-hasta').value;
      if (!desde || !hasta || desde > hasta) return toast('Revisa las fechas');
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Preparando…';
      try {
        const n = await generarExcel(desde, hasta);
        toast(`Excel descargado: ${n.trabajos} trabajos, ${n.gastos} gastos, ${n.jornadas} jornadas`, 5000);
      } catch (err) {
        toast(msgError(err), 6000);
      } finally {
        btn.disabled = false; btn.textContent = 'Descargar Excel';
      }
    });
  }
};


/* ------------------------------------------------------------------ */
/* Importar gastos desde Excel (solo admin)                            */
/* - Fila SIN ID  -> gasto nuevo                                       */
/* - Fila CON ID  -> actualiza ese gasto (el ID sale del Excel que     */
/*   descarga la app, hoja "Gastos", última columna)                   */
/* ------------------------------------------------------------------ */
const normTxt = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const ESTADOS_IMP = { pendiente: 'pendiente', aprobado: 'aprobado', aprobada: 'aprobado', rechazado: 'rechazado', rechazada: 'rechazado' };

function categoriaDesde(txt) {
  const n = normTxt(txt);
  if (!n) return null;
  for (const [k, label] of CATEGORIAS) {
    if (n === normTxt(k) || n === normTxt(label) || n === normTxt(label.replace(/\s*\(.*\)/, ''))) return k;
  }
  if (n.includes('poliza') || n.includes('seguro')) return 'polizas';
  if (n.includes('administrativ')) return 'administrativo';
  return null;
}
function fechaDesde(v, XL) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  if (typeof v === 'number') { const d = XL.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null; }
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); // día/mes/año (formato Colombia)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function valorDesde(v) {
  if (typeof v === 'number') return Math.round(v);
  const t = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!t) return 0;
  return Math.round(Number(t.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.'))) || 0;
}

let IMP = null; // filas listas para importar
async function leerExcelGastos(file) {
  await cargarXLSX();
  const XL = window.XLSX;
  const wb = XL.read(await file.arrayBuffer(), { type: 'array' });
  const nombre = wb.SheetNames.find((n) => normTxt(n) === 'gastos') || wb.SheetNames[0];
  const filas = XL.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, defval: '', raw: true });
  const iCab = filas.findIndex((f) => f.some((c) => normTxt(c) === 'valor') && f.some((c) => normTxt(c) === 'fecha'));
  if (iCab < 0) throw new Error('No encontré las columnas "Fecha" y "Valor". Usa la plantilla o el Excel descargado de la app (hoja "Gastos").');
  const col = {};
  filas[iCab].forEach((c, i) => {
    const n = normTxt(c);
    if (n === 'fecha') col.fecha = i;
    else if (n === 'dron') col.dron = i;
    else if (n === 'categoria') col.cat = i;
    else if (n === 'descripcion') col.desc = i;
    else if (n === 'valor') col.valor = i;
    else if (n === 'estado') col.estado = i;
    else if (n === 'id') col.id = i;
  });
  const dronesOk = Object.fromEntries(S.drones.map((d) => [normTxt(d.id), d.id]));
  const out = [];
  filas.slice(iCab + 1).forEach((f, k) => {
    if (f.every((c) => c === '' || c == null)) return;
    const g = (i) => (i == null ? '' : f[i]);
    const errores = [], avisos = [];
    const fecha = fechaDesde(g(col.fecha), XL);
    if (!fecha) errores.push('Fecha no válida');
    const valor = valorDesde(g(col.valor));
    if (!valor || valor < 0) errores.push('Valor vacío o en cero');
    const dTxt = normTxt(g(col.dron));
    let dron_id = null;
    if (dTxt && !dTxt.startsWith('general')) {
      dron_id = dronesOk[dTxt] || null;
      if (!dron_id) errores.push(`Dron "${g(col.dron)}" no existe`);
    }
    let desc = String(g(col.desc) ?? '').trim();
    let categoria = categoriaDesde(g(col.cat));
    if (!categoria) {
      categoria = 'otro';
      if (String(g(col.cat)).trim()) { avisos.push(`Categoría "${g(col.cat)}" no existe: queda como "Otro"`); desc = desc ? `${g(col.cat)} · ${desc}` : String(g(col.cat)).trim(); }
      else avisos.push('Sin categoría: queda como "Otro"');
    }
    const estadoTxt = normTxt(g(col.estado));
    const estado = ESTADOS_IMP[estadoTxt] || null; // si va vacío se usa el estado elegido en pantalla
    const id = String(g(col.id) ?? '').trim() || null;
    out.push({ n: iCab + k + 2, fecha, dron_id, categoria, descripcion: desc || null, valor, estado, id, errores, avisos });
  });
  return out;
}

rutas.importar = {
  titulo: 'Importar gastos',
  html: () => {
    if (!esAdmin()) return '<div class="card"><p class="muted">Esta opción es solo para el administrador.</p></div>';
    return `<div class="card"><h2>Cargar gastos desde Excel</h2>
      <p class="muted">Sirve para gastos que ya están completos (pólizas, gastos administrativos, etc.). El archivo necesita las columnas <b>Fecha, Dron, Categoría, Descripción, Valor</b> (y opcionalmente <b>Estado</b>). Si <b>Dron</b> va vacío o dice "General", queda como gasto general de COLFOG.</p>
      <p class="muted">Filas <b>sin ID</b> crean gastos nuevos. Filas <b>con ID</b> actualizan ese gasto: el ID viene en la última columna de la hoja "Gastos" del Excel que descargas en esta app.</p>
      <button class="btn secondary" id="i-plantilla" type="button">Descargar plantilla</button>
      <label for="i-archivo">Archivo de Excel (.xlsx)</label>
      <input id="i-archivo" type="file" accept=".xlsx,.xls,.csv">
      ${navigator.onLine ? '' : '<p class="note">Necesitas señal para importar.</p>'}
    </div>
    <div id="i-previa"></div>`;
  },
  init: () => {
    $('#i-plantilla').addEventListener('click', async () => {
      await cargarXLSX();
      const XL = window.XLSX;
      const wb = XL.utils.book_new();
      const hoja = XL.utils.aoa_to_sheet([
        ['Fecha', 'Dron', 'Categoría', 'Descripción', 'Valor', 'Estado', 'ID'],
        [new Date().toISOString().slice(0, 10), 'General', 'Pólizas y seguros', 'Ejemplo: póliza todo riesgo T55', 1500000, 'aprobado', '']
      ]);
      hoja['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 30 }, { wch: 40 }, { wch: 14 }, { wch: 12 }, { wch: 38 }];
      XL.utils.book_append_sheet(wb, hoja, 'Gastos');
      XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([['Categorías válidas'], ...CATEGORIAS.map(([, t]) => [t]), [], ['Drones válidos (o General)'], ...S.drones.map((d) => [d.id])]), 'Listas');
      XL.writeFile(wb, 'plantilla_importar_gastos.xlsx');
    });
    $('#i-archivo').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const box = $('#i-previa');
      box.innerHTML = '<div class="card"><p class="muted">Leyendo archivo…</p></div>';
      try {
        const filas = await leerExcelGastos(file);
        if (!filas.length) { box.innerHTML = '<div class="card"><p class="note">El archivo no tiene filas con datos.</p></div>'; return; }
        // Revisa contra lo ya guardado: duplicados (nuevos) y existencia del ID (actualizaciones)
        const fechas = filas.map((f) => f.fecha).filter(Boolean).sort();
        const { data: ex, error } = await sb.from('gastos').select('*').gte('fecha', fechas[0] || '2000-01-01').lte('fecha', fechas[fechas.length - 1] || '2100-01-01');
        if (error) throw error;
        if ((ex || []).length >= 1000) throw new Error('Hay más de 1.000 gastos en ese rango de fechas. Divide el archivo por periodos.');
        const porId = Object.fromEntries((ex || []).map((g) => [g.id, g]));
        const llave = (g) => [g.fecha, g.dron_id || '', g.categoria, Math.round(Number(g.valor)), normTxt(g.descripcion)].join('|');
        const existentes = new Set((ex || []).filter((g) => !g.anulado).map(llave));
        for (const f of filas) {
          if (f.id) {
            if (!porId[f.id]) f.errores.push('El ID no existe en la base (¿lo borraste o es de otro rango?)');
            else { f.antes = porId[f.id]; f.accion = 'actualiza'; }
          } else {
            f.accion = 'nuevo';
            if (!f.errores.length && existentes.has(llave(f))) { f.duplicado = true; f.avisos.push('Ya existe un gasto igual (misma fecha, dron, categoría, valor y descripción)'); }
          }
        }
        IMP = filas;
        pintarPrevia();
      } catch (err) {
        box.innerHTML = `<div class="card"><p class="note">${esc(err.message || String(err))}</p></div>`;
      }
    });
  }
};

function pintarPrevia() {
  const box = $('#i-previa');
  const marcable = (f) => !f.errores.length;
  const items = IMP.map((f, i) => {
    const badge = f.errores.length ? '<span class="badge danger">Error</span>' : f.duplicado ? '<span class="badge warn">Posible duplicado</span>' : f.accion === 'actualiza' ? '<span class="badge">Actualiza</span>' : '<span class="badge">Nuevo</span>';
    const marca = marcable(f) ? `<input type="checkbox" data-i="${i}" ${f.duplicado ? '' : 'checked'}>` : '';
    return `<li><div class="check" style="margin:0">${marca}<div><div class="t">${esc(f.fecha || '—')} · ${esc(f.dron_id || 'General')} · <span class="money">${money(f.valor)}</span></div>
      <div class="muted">${esc(nombreCat(f.categoria))}${f.descripcion ? ' · ' + esc(f.descripcion) : ''} <span class="muted">(fila ${f.n})</span></div>
      ${[...f.errores.map((x) => `<div class="note">${esc(x)}</div>`), ...f.avisos.map((x) => `<div class="muted">⚠ ${esc(x)}</div>`)].join('')}</div></div>${badge}</li>`;
  }).join('');
  box.innerHTML = `<div class="card"><h2>Revisa antes de importar</h2>
    <label for="i-estado">Estado para las filas que no traen Estado</label>
    <select id="i-estado"><option value="aprobado">Aprobado (cuenta en el tablero)</option><option value="pendiente">Pendiente de aprobación</option></select>
    <ul class="list">${items}</ul>
    <p class="muted" id="i-resumen"></p>
    <button class="btn" id="i-importar">Importar</button></div>`;
  const resumen = () => {
    const sel = $$('#i-previa [data-i]:checked').map((c) => IMP[Number(c.dataset.i)]);
    const total = sel.reduce((s, f) => s + f.valor, 0);
    $('#i-resumen').innerHTML = `${sel.length} fila(s) seleccionadas · ${sel.filter((f) => f.accion === 'nuevo').length} nuevas, ${sel.filter((f) => f.accion === 'actualiza').length} actualizaciones · Total <b>${money(total)}</b>${IMP.some((f) => f.errores.length) ? '<br>Las filas con error no se importan: corrígelas en el Excel y súbelo de nuevo.' : ''}`;
    $('#i-importar').disabled = !sel.length;
  };
  $$('#i-previa [data-i]').forEach((c) => c.addEventListener('change', resumen));
  resumen();
  $('#i-importar').addEventListener('click', async (e) => {
    if (!navigator.onLine) return toast('Necesitas señal para importar');
    const sel = $$('#i-previa [data-i]:checked').map((c) => IMP[Number(c.dataset.i)]);
    if (!sel.length) return;
    const porDefecto = $('#i-estado').value;
    if (!confirm(`Se van a guardar ${sel.length} gasto(s). ¿Continuar?`)) return;
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Importando…';
    let nuevos = 0, actualizados = 0;
    try {
      const filasNuevas = sel.filter((f) => f.accion === 'nuevo').map((f) => {
        const estado = f.estado || porDefecto;
        return { id: uuid(), fecha: f.fecha, dron_id: f.dron_id, categoria: f.categoria, descripcion: f.descripcion, valor: f.valor, estado, revisado_por: estado === 'pendiente' ? null : S.user.id };
      });
      if (filasNuevas.length) {
        const { error } = await sb.from('gastos').insert(filasNuevas);
        if (error) throw error;
        nuevos = filasNuevas.length;
      }
      for (const f of sel.filter((x) => x.accion === 'actualiza')) {
        const estado = f.estado || f.antes.estado; // al actualizar, sin Estado en el Excel se conserva el actual
        const cambios = { fecha: f.fecha, dron_id: f.dron_id, categoria: f.categoria, descripcion: f.descripcion, valor: f.valor, estado };
        if (estado !== f.antes.estado) cambios.revisado_por = estado === 'pendiente' ? null : S.user.id;
        const { data, error } = await sb.from('gastos').update(cambios).eq('id', f.id).select('id');
        if (error) throw error;
        if (!data?.length) throw new Error(`No se pudo actualizar la fila ${f.n}`);
        actualizados++;
      }
      toast(`Importado: ${nuevos} nuevo(s), ${actualizados} actualizado(s)`, 5000);
      IMP = null;
      await cargarDatos();
      ir('inicio', {}, true);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Importar';
      alert(`Se detuvo la importación: ${err.message || err}\n\nSe alcanzaron a guardar ${nuevos} nuevo(s) y ${actualizados} actualizado(s). Vuelve a subir el archivo: los ya guardados aparecerán como duplicados y quedan sin marcar.`);
    }
  });
}
