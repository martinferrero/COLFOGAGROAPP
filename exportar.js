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
    ['Fecha', 'Dron', 'Categoría', 'Descripción', 'Valor', 'Estado', 'Registrado por', 'Revisado por', 'Con soporte (foto)', 'Creado'],
    ...gastos.map((g) => [aFecha(g.fecha), g.dron_id || 'General', nombreCat(g.categoria), g.descripcion || '', Number(g.valor), g.estado, nom(g.creado_por), nom(g.revisado_por), g.soporte ? 'Sí' : 'No', aFechaHora(g.created_at)])
  ], { fecha: [0], dinero: [4], fechaHora: [9], anchos: [12, 10, 30, 36, 14, 12, 22, 22, 16, 17] }), 'Gastos');

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
