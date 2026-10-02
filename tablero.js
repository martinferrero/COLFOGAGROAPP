/* ------------------------------------------------------------------ */
/* Tablero: indicadores, resultado por dron y liquidación del aliado   */
/* (se carga después de app.js y usa sus utilidades)                   */
/* ------------------------------------------------------------------ */
const PERIODOS = [
  ['mes', 'Este mes'], ['mes_ant', 'Mes anterior'], ['90', 'Últimos 90 días'], ['anio', 'Este año']
];
function rangoPeriodo(p) {
  const d = new Date(); const y = d.getFullYear(); const m = d.getMonth();
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if (p === 'mes_ant') return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
  if (p === '90') return [iso(new Date(Date.now() - 89 * 864e5)), hoy()];
  if (p === 'anio') return [`${y}-01-01`, hoy()];
  return [iso(new Date(y, m, 1)), hoy()];
}
const compacto = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' M';
  if (a >= 1e3) return Math.round(n / 1e3).toLocaleString('es-CO') + ' mil';
  return Math.round(n).toLocaleString('es-CO');
};
const ha1 = (n) => (Math.round(n * 10) / 10).toLocaleString('es-CO');

async function cargarTablero(desde, hasta) {
  const [jor, gas] = await Promise.all([
    sb.from('jornadas').select('*, jornada_drones(*, trabajos(*), lecturas(*))').gte('fecha', desde).lte('fecha', hasta).order('fecha'),
    sb.from('gastos').select('*').gte('fecha', desde).lte('fecha', hasta)
  ]);
  if (jor.error) throw jor.error;
  if (gas.error) throw gas.error;
  return { jornadas: jor.data || [], gastos: gas.data || [] };
}

function calcularTablero({ jornadas, gastos }) {
  const P = S.parametros;
  const diasBase = P.dias_base_mes || 24;
  const camDia = (P.camioneta_fijo_mes ?? 4350800) / diasBase;
  const camKm = P.camioneta_km ?? 377.65;
  const auxDia = (P.auxiliar_mes ?? 4968000) / diasBase;
  const fijoHa = P.fijo_colfog_ha ?? 5000;
  const pctVar = P.variable_colfog ?? 0.075;
  const retAli = P.retencion_aliado ?? 0.04;
  const activoPorId = Object.fromEntries(S.activos.map((a) => [a.id, a]));

  const vacio = () => ({ ha: 0, ingreso: 0, costoDia: 0, camioneta: 0, diesel: 0, auxiliar: 0, gastos: 0, gastosSinAsignar: 0, depBaterias: 0, depGenerador: 0, ciclos: 0, horasGen: 0, dias: 0, km: 0, trabajos: [] });
  const D = Object.fromEntries(S.drones.map((d) => [d.id, vacio()]));
  const prop = (id) => S.drones.find((d) => d.id === id)?.propietario;
  const trabajos = [];
  const porFechaDron = {}; // "fecha|dron" -> trabajos

  for (const j of jornadas) {
    const jds = j.jornada_drones || [];
    const n = Math.max(1, jds.length);
    const km = j.odometro_fin != null && j.odometro_ini != null ? Math.max(0, j.odometro_fin - j.odometro_ini) : 0;
    const cam = j.usa_camioneta ? camDia + km * camKm : 0;
    const diesel = Number(j.diesel_valor) || 0;
    const aux = j.auxiliar ? auxDia : 0;
    for (const jd of jds) {
      const d = D[jd.dron_id]; if (!d) continue;
      const shareCam = cam / n, shareDiesel = diesel / n, shareAux = aux / n;
      d.dias += 1; d.km += km / n;
      d.camioneta += shareCam; d.diesel += shareDiesel; d.auxiliar += shareAux;
      const share = shareCam + shareDiesel + shareAux;
      d.costoDia += share;
      for (const l of jd.lecturas || []) {
        const a = activoPorId[l.activo_id]; if (!a || l.fin == null || !(Number(a.vida_util) > 0)) continue;
        const uso = Math.max(0, Number(l.fin) - Number(l.inicio));
        const dep = uso * Number(a.precio) / Number(a.vida_util);
        if (a.tipo === 'bateria') { d.depBaterias += dep; d.ciclos += uso; } else { d.depGenerador += dep; d.horasGen += uso; }
      }
      const ts = jd.trabajos || [];
      const haTot = ts.reduce((s, t) => s + Number(t.ha), 0);
      for (const t of ts) {
        const p = precioSugerido({ tipo: t.tipo_servicio, litros: t.litros_ha == null ? null : Number(t.litros_ha), precioId: t.precio_id, ha: t.ha });
        const r = {
          ...t, fecha: j.fecha, dron: jd.dron_id, ha: Number(t.ha),
          ingreso: p?.total || 0, sinPrecio: !p,
          costoDia: haTot ? share * Number(t.ha) / haTot : 0, gastos: 0
        };
        trabajos.push(r); d.trabajos.push(r);
        d.ha += r.ha; d.ingreso += r.ingreso;
        (porFechaDron[`${j.fecha}|${jd.dron_id}`] ||= []).push(r);
      }
      if (!ts.length) d.costoSinTrabajos = (d.costoSinTrabajos || 0) + share;
    }
  }

  // Gastos aprobados: se asignan a los trabajos del mismo día y dron según sus Ha
  const pendientes = { n: 0, valor: 0 };
  const porCategoria = {};
  for (const g of gastos) {
    if (g.estado === 'pendiente') { pendientes.n++; pendientes.valor += Number(g.valor); continue; }
    if (g.estado !== 'aprobado') continue;
    porCategoria[g.categoria] = (porCategoria[g.categoria] || 0) + Number(g.valor);
    const d = D[g.dron_id]; if (!d) continue;
    d.gastos += Number(g.valor);
    const dr = S.drones.find((x) => x.id === g.dron_id);
    if (dr?.aliado_id && g.creado_por === dr.aliado_id) d.gastosPagadosAliado = (d.gastosPagadosAliado || 0) + Number(g.valor);
    const ts = porFechaDron[`${g.fecha}|${g.dron_id}`];
    const haTot = ts?.reduce((s, t) => s + t.ha, 0);
    if (ts && haTot) for (const t of ts) t.gastos += Number(g.valor) * t.ha / haTot;
    else d.gastosSinAsignar += Number(g.valor);
  }

  // Liquidación de los drones del aliado (T50) por trabajo
  const L = { fijo: 0, variable: 0, ingreso: 0, parte: 0, trabajosPerdida: 0 };
  const idsAliado = S.drones.filter((d) => d.propietario === 'ALIADO').map((d) => d.id);
  const idsColfog = S.drones.filter((d) => d.propietario === 'COLFOG').map((d) => d.id);
  const idsComp = S.drones.filter((d) => d.propietario === 'COMPARTIDO').map((d) => d.id);
  for (const t of idsAliado.flatMap((id) => D[id].trabajos)) {
    t.fijo = t.ha * fijoHa;
    t.utilidad = t.ingreso - t.costoDia - t.gastos - t.fijo;
    t.variable = Math.max(0, t.utilidad) * pctVar;
    if (t.utilidad < 0) L.trabajosPerdida++;
    L.fijo += t.fijo; L.variable += t.variable; L.ingreso += t.ingreso;
  }
  L.parte = L.ingreso - L.fijo - L.variable;
  L.retencion = L.parte * retAli;
  L.neto = L.parte - L.retencion;
  for (const id of Object.keys(D)) {
    const x = D[id];
    x.fijo = 0; x.variable = 0;
    if (prop(id) === 'ALIADO') for (const t of x.trabajos) { x.fijo += t.fijo; x.variable += t.variable; }
    x.utilidadCaja = x.ingreso - x.costoDia - x.gastos - x.fijo - x.variable;
    x.utilidadEconomica = x.utilidadCaja - x.depBaterias - x.depGenerador;
  }
  // Dron compartido 50/50: liquidación mensual, ganancias y pérdidas se compensan
  const pctAli = P.participacion_aliado_compartido ?? 0.5;
  const C = { ids: idsComp, ingreso: 0, utilidadCaja: 0, utilidadEconomica: 0, gastosPagadosAliado: 0 };
  for (const id of idsComp) {
    C.ingreso += D[id].ingreso; C.utilidadCaja += D[id].utilidadCaja; C.utilidadEconomica += D[id].utilidadEconomica;
    C.gastosPagadosAliado += D[id].gastosPagadosAliado || 0;
  }
  C.parteAliado = C.utilidadCaja * pctAli;
  C.parteColfog = C.utilidadCaja - C.parteAliado;
  C.economicaAliado = C.utilidadEconomica * pctAli;
  C.economicaColfog = C.utilidadEconomica - C.economicaAliado;
  // A transferir al aliado: su 50% + reembolso de los gastos del compartido que él pagó
  C.factura = C.parteAliado + C.gastosPagadosAliado;
  C.retencion = Math.max(0, C.factura) * retAli;
  C.neto = C.factura - C.retencion;
  C.pctAli = pctAli;

  const suma = (ids, k) => ids.reduce((s, id) => s + (D[id]?.[k] || 0), 0);
  const colfog = suma(idsColfog, 'utilidadEconomica') + L.fijo + L.variable + C.economicaColfog;
  const aliado = suma(idsAliado, 'utilidadEconomica') + C.economicaAliado;

  // Clientes
  const clientes = {};
  for (const t of trabajos) {
    const c = (clientes[t.cliente] ||= { cliente: t.cliente, ha: 0, ingreso: 0, n: 0 });
    c.ha += t.ha; c.ingreso += t.ingreso; c.n++;
  }
  return {
    D, L, C, colfog, aliado, idsColfog, idsAliado, idsComp, trabajos, pendientes, porCategoria,
    clientes: Object.values(clientes).sort((a, b) => b.ingreso - a.ingreso),
    sinPrecio: trabajos.filter((t) => t.sinPrecio).length,
    lecturasAbiertas: jornadas.flatMap((j) => (j.jornada_drones || []).flatMap((jd) => jd.lecturas || [])).filter((l) => l.fin == null).length
  };
}

/* Barras agrupadas T55 / T50 por semana (o por día en rangos cortos) */
function graficoHa(trabajos, desde, hasta, drones) {
  const dias = Math.round((new Date(hasta) - new Date(desde)) / 864e5) + 1;
  const porDia = dias <= 35;
  const clave = (f) => {
    if (porDia) return f;
    const d = new Date(f + 'T12:00:00'); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow);
    return d.toISOString().slice(0, 10);
  };
  const buckets = [];
  const ini = new Date(desde + 'T12:00:00'), fin = new Date(hasta + 'T12:00:00');
  for (let d = new Date(ini); d <= fin; d.setDate(d.getDate() + (porDia ? 1 : 7))) {
    const k = clave(d.toISOString().slice(0, 10));
    if (!buckets.includes(k)) buckets.push(k);
  }
  const val = Object.fromEntries(buckets.map((b) => [b, Object.fromEntries(drones.map((x) => [x, 0]))]));
  for (const t of trabajos) { const k = clave(t.fecha); if (val[k] && val[k][t.dron] != null) val[k][t.dron] += t.ha; }
  const max = Math.max(1, ...buckets.flatMap((b) => drones.map((x) => val[b][x])));
  const nice = (() => { const e = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / e / (max / e > 5 ? 2 : 1)) * e * (max / e > 5 ? 2 : 1); })();
  const W = Math.round(Math.max(340, Math.min(900, (document.getElementById('view')?.clientWidth || 640) - 34))), H = 220, ml = 34, mb = 22, mt = 8, w = W - ml - 6, h = H - mb - mt;
  const bw = w / buckets.length;
  const gap = 2, barW = Math.max(3, Math.min(22, (bw - 6) / drones.length - gap));
  const y = (v) => mt + h - (v / nice) * h;
  const ticks = [0, nice / 2, nice];
  const etiqueta = (k) => { const d = new Date(k + 'T12:00:00'); return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }).replace('.', '').replace(' de ', ' '); };
  const cada = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(w / 64))));
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hectáreas por ${porDia ? 'día' : 'semana'} y dron">`;
  for (const t of ticks) svg += `<line x1="${ml}" x2="${W - 6}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${ml - 6}" y="${y(t) + 4}" class="tick" text-anchor="end">${ha1(t)}</text>`;
  buckets.forEach((b, i) => {
    const x0 = ml + i * bw + (bw - drones.length * (barW + gap)) / 2;
    drones.forEach((dr, k) => {
      const v = val[b][dr]; if (!v) return;
      const x = x0 + k * (barW + gap), yy = y(v), hh = mt + h - yy;
      const r = Math.min(4, barW / 2, hh);
      svg += `<path class="bar s-${dr}" d="M${x},${mt + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${mt + h} Z"
        data-tip="${esc(dr)} · ${porDia ? etiqueta(b) : 'semana del ' + etiqueta(b)}: ${ha1(v)} Ha"/>`;
    });
    if (i % cada === 0) svg += `<text x="${ml + i * bw + bw / 2}" y="${H - 6}" class="tick" text-anchor="middle">${etiqueta(b)}</text>`;
  });
  svg += `<line x1="${ml}" x2="${W - 6}" y1="${mt + h}" y2="${mt + h}" class="axis"/></svg>`;
  const leyenda = drones.length > 1 ? `<div class="legend">${drones.map((d) => `<span><i class="sw s-${d}"></i>${d}</span>`).join('')}</div>` : '';
  const tabla = `<details class="tabla-datos"><summary>Ver como tabla</summary><table><thead><tr><th>${porDia ? 'Día' : 'Semana'}</th>${drones.map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody>
    ${buckets.filter((b) => drones.some((d) => val[b][d])).map((b) => `<tr><td>${etiqueta(b)}</td>${drones.map((d) => `<td>${ha1(val[b][d])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${drones.length + 1}">Sin datos</td></tr>`}
  </tbody></table></details>`;
  return `${leyenda}<div class="chart-wrap">${svg}<div class="chart-tip" hidden></div></div>${tabla}`;
}

function filaR(label, valor, clase = '') { return `<tr class="${clase}"><td>${label}</td><td class="num">${valor}</td></tr>`; }
function medidor(a) {
  const u = S.ultimas[a.id];
  if (u == null || !(Number(a.vida_util) > 0)) return `<li><div><div class="t">${esc(a.dron_id)} · ${esc(nombreActivo(a))}</div><div class="muted">Sin lecturas todavía</div></div></li>`;
  const pct = Math.min(100, (u / Number(a.vida_util)) * 100);
  const nivel = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
  const unidad = a.tipo === 'generador' ? 'h' : 'ciclos';
  return `<li class="meter-row"><div style="flex:1"><div class="t">${esc(a.dron_id)} · ${esc(nombreActivo(a).replace(/ \(.*\)/, ''))}</div>
    <div class="meter ${nivel}" role="meter" aria-valuemin="0" aria-valuemax="${a.vida_util}" aria-valuenow="${u}"><span style="width:${pct}%"></span></div>
    <div class="muted">${u.toLocaleString('es-CO')} de ${Number(a.vida_util).toLocaleString('es-CO')} ${unidad} · ${Math.round(pct)}% de vida útil${nivel === 'danger' ? ' · <b>Planear reemplazo</b>' : nivel === 'warn' ? ' · Revisar' : ''}</div></div></li>`;
}

rutas.tablero = {
  titulo: 'Tablero',
  html: async (params) => {
    if (!veDinero()) return '<div class="card"><p class="muted">El tablero es para COLFOG y el aliado.</p></div>';
    const per = params.periodo || 'mes';
    const [desde, hasta] = rangoPeriodo(per);
    const filtros = `<div class="filtros" role="group" aria-label="Periodo">${PERIODOS.map(([k, t]) => `<button class="pill ${k === per ? 'on' : ''}" data-periodo="${k}">${t}</button>`).join('')}</div>`;
    if (!navigator.onLine) return filtros + '<div class="card"><p class="note">Necesitas señal para ver el tablero.</p></div>';
    let R;
    try { R = calcularTablero(await cargarTablero(desde, hasta)); }
    catch (e) { return filtros + `<div class="card"><p class="note">${esc(e.message)}</p></div>`; }
    const { D, L, C } = R;
    const admin = esAdmin();
    const drones = admin ? S.drones.map((d) => d.id) : misDrones().map((d) => d.id);
    const ordenProp = { COLFOG: 0, ALIADO: 1, COMPARTIDO: 2 };
    drones.sort((x, y) => (ordenProp[S.drones.find((d) => d.id === x)?.propietario] ?? 9) - (ordenProp[S.drones.find((d) => d.id === y)?.propietario] ?? 9));
    const nombreDron = (id) => {
      const d = S.drones.find((x) => x.id === id);
      const p = d?.propietario;
      return `${id} · ${p === 'COLFOG' ? 'COLFOG' : p === 'ALIADO' ? 'Martin Ruiz' : `Sociedad ${Math.round((1 - C.pctAli) * 100)}/${Math.round(C.pctAli * 100)}`}`;
    };
    const haTot = drones.reduce((s, d) => s + D[d].ha, 0);
    const ingTot = drones.reduce((s, d) => s + D[d].ingreso, 0);
    const diasTot = new Set(R.trabajos.filter((t) => drones.includes(t.dron)).map((t) => t.fecha)).size;
    const hayComp = C.ids.some((id) => drones.includes(id));

    const hero = admin
      ? `<div class="hero"><span class="muted">Utilidad COLFOG línea drones</span><strong class="${R.colfog < 0 ? 'neg' : ''}">${money(R.colfog)}</strong>
         <span class="muted">${R.idsColfog.map((id) => `${id} ${money(D[id].utilidadEconomica)}`).join(' + ')} + aliado ${money(L.fijo + L.variable)}${hayComp ? ` + 50% sociedad ${money(C.economicaColfog)}` : ''}</span></div>`
      : `<div class="hero"><span class="muted">Tu utilidad económica</span><strong class="${R.aliado < 0 ? 'neg' : ''}">${money(R.aliado)}</strong>
         <span class="muted">${R.idsAliado.map((id) => `${id} ${money(D[id].utilidadEconomica)}`).join(' + ')}${hayComp ? ` + tu 50% de la sociedad ${money(C.economicaAliado)}` : ''}. Incluye desgaste de equipos.</span></div>`;

    const tiles = `<div class="tiles">
      <div class="tile"><span>Hectáreas</span><b>${ha1(haTot)}</b><small>${diasTot} días de vuelo${diasTot ? ` · ${ha1(haTot / diasTot)} Ha/día` : ''}</small></div>
      <div class="tile"><span>Ingresos</span><b>${compacto(ingTot)}</b><small>${haTot ? money(ingTot / haTot) + '/Ha' : '—'}</small></div>
      <div class="tile"><span>Trabajos</span><b>${R.trabajos.filter((t) => drones.includes(t.dron)).length}</b><small>${R.clientes.length} clientes</small></div>
      <div class="tile"><span>Gastos por aprobar</span><b>${R.pendientes.n}</b><small>${R.pendientes.n ? money(R.pendientes.valor) : 'Al día'}</small></div>
    </div>`;

    const resultado = (d) => {
      const x = D[d];
      const p = S.drones.find((z) => z.id === d)?.propietario;
      const rows = [
        filaR('Hectáreas', ha1(x.ha)),
        filaR('Ingresos', money(x.ingreso)),
        filaR('Camioneta (fijo + km)', '− ' + money(x.camioneta)),
        filaR('Diésel', '− ' + money(x.diesel)),
        filaR('Auxiliar de vuelo', '− ' + money(x.auxiliar)),
        filaR('Gastos aprobados', '− ' + money(x.gastos)),
        ...(p === 'ALIADO' ? [filaR('Fijo COLFOG ($5.000/Ha)', '− ' + money(x.fijo)), filaR('Variable COLFOG (7,5%)', '− ' + money(x.variable))] : []),
        filaR('Utilidad de caja', money(x.utilidadCaja), 'sub'),
        filaR(`Desgaste baterías (${ha1(x.ciclos)} ciclos)`, '− ' + money(x.depBaterias)),
        filaR(`Desgaste generador (${ha1(x.horasGen)} h)`, '− ' + money(x.depGenerador)),
        filaR('Utilidad económica', money(x.utilidadEconomica), 'total'),
        ...(p === 'COMPARTIDO' ? [filaR(`COLFOG ${Math.round((1 - C.pctAli) * 100)}%`, money(x.utilidadEconomica * (1 - C.pctAli))), filaR(`Martin Ruiz ${Math.round(C.pctAli * 100)}%`, money(x.utilidadEconomica * C.pctAli))] : []),
        filaR('Costo por Ha', x.ha ? money((x.ingreso - x.utilidadEconomica - x.fijo - x.variable) / x.ha) : '—')
      ].join('');
      return `<div class="card"><h2><i class="sw s-${d}"></i>${esc(nombreDron(d))}</h2><table class="pyg">${rows}</table></div>`;
    };

    const liquidacion = R.idsAliado.some((id) => drones.includes(id)) ? `<div class="card"><h2>Liquidación ${R.idsAliado.join(', ')} (por trabajo)</h2>
      <table class="pyg">
        ${filaR('Ingresos facturables', money(L.ingreso))}
        ${filaR('Fijo COLFOG', '− ' + money(L.fijo))}
        ${filaR('Variable COLFOG', '− ' + money(L.variable))}
        ${filaR('Parte del aliado', money(L.parte), 'sub')}
        ${filaR('Retención 4%', '− ' + money(L.retencion))}
        ${filaR(admin ? 'Neto a pagar al aliado' : 'Neto a recibir', money(L.neto), 'total')}
      </table>
      <p class="muted">Se paga a medida que los clientes pagan. ${L.trabajosPerdida ? `${L.trabajosPerdida} trabajo(s) con pérdida: pagan el fijo, sin variable.` : ''}</p></div>` : '';

    const liqComp = hayComp ? `<div class="card"><h2>Liquidación sociedad ${C.ids.join(', ')} (mensual)</h2>
      <table class="pyg">
        ${filaR('Ingresos', money(C.ingreso))}
        ${filaR('Utilidad de caja del periodo', money(C.utilidadCaja), 'sub')}
        ${filaR(`${Math.round(C.pctAli * 100)}% Martin Ruiz`, money(C.parteAliado))}
        ${filaR('+ Reembolso gastos que pagó Martin Ruiz', money(C.gastosPagadosAliado))}
        ${filaR('Factura de Martin Ruiz a COLFOG', money(C.factura), 'sub')}
        ${C.factura > 0 ? filaR('Retención 4%', '− ' + money(C.retencion)) : ''}
        ${filaR(C.factura >= 0 ? (admin ? 'Neto a pagar a Martin Ruiz' : 'Neto a recibir') : (admin ? 'Martin Ruiz debe aportar' : 'Debes aportar'), money(Math.abs(C.neto)), 'total')}
        ${filaR(`${Math.round((1 - C.pctAli) * 100)}% COLFOG`, money(C.parteColfog))}
      </table>
      <p class="muted">Ganancias y pérdidas del mes se compensan y se reparten 50/50. Sin fijo ni variable. El desgaste de baterías y generador (${money(C.utilidadCaja - C.utilidadEconomica)}) también se reparte, pero no es caja: se usa para reponer equipos.</p></div>` : '';

    const clientes = `<div class="card"><h2>Principales clientes</h2><table class="pyg"><thead><tr><th>Cliente</th><th class="num">Ha</th><th class="num">Ingreso</th></tr></thead><tbody>
      ${R.clientes.slice(0, 8).map((c) => `<tr><td>${esc(c.cliente)}</td><td class="num">${ha1(c.ha)}</td><td class="num">${compacto(c.ingreso)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin trabajos en el periodo</td></tr>'}
    </tbody></table></div>`;

    const cats = Object.entries(R.porCategoria).sort((a, b) => b[1] - a[1]);
    const gastosCat = cats.length ? `<div class="card"><h2>Gastos aprobados por categoría</h2><table class="pyg">${cats.map(([c, v]) => filaR(esc(nombreCat(c)), money(v))).join('')}</table></div>` : '';

    const equipos = `<div class="card"><h2>Baterías y generadores</h2><ul class="list">${S.activos.filter((a) => drones.includes(a.dron_id)).map(medidor).join('')}</ul></div>`;

    const avisos = [
      R.sinPrecio && `${R.sinPrecio} trabajo(s) sin precio (faltan litros/Ha o paquete): cuentan con ingreso $0.`,
      R.lecturasAbiertas && `${R.lecturasAbiertas} lectura(s) sin cierre: su desgaste aún no se cuenta.`,
      admin && 'No incluye salarios de pilotos ni el costo fijo de camioneta y auxiliar en días sin vuelo.'
    ].filter(Boolean).map((t) => `<p class="note">${t}</p>`).join('');

    return `${filtros}
      <p class="muted periodo">${esc(fechaLarga(desde))} – ${esc(fechaLarga(hasta))}</p>
      ${hero}${tiles}
      <div class="card"><h2>Hectáreas por ${Math.round((new Date(hasta) - new Date(desde)) / 864e5) <= 34 ? 'día' : 'semana'}</h2>${graficoHa(R.trabajos, desde, hasta, drones)}</div>
      <div class="cols">${drones.map(resultado).join('')}</div>
      ${liquidacion}
      ${liqComp}
      <div class="cols">${clientes}${gastosCat}</div>
      ${equipos}
      ${avisos}
      <p class="muted">Valores estimados con la lista de precios y los parámetros vigentes. La liquidación definitiva se hace sobre lo facturado.</p>`;
  },
  init: (params) => {
    $$('[data-periodo]').forEach((b) => b.addEventListener('click', () => { pila[pila.length - 1].params = { periodo: b.dataset.periodo }; render(); }));
    const wrap = $('.chart-wrap'); if (!wrap) return;
    const tip = $('.chart-tip', wrap);
    wrap.addEventListener('pointermove', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip.hidden = true; return; }
      const r = wrap.getBoundingClientRect();
      tip.textContent = t.dataset.tip; tip.hidden = false;
      tip.style.left = Math.min(r.width - 150, Math.max(0, e.clientX - r.left - 60)) + 'px';
      tip.style.top = Math.max(0, e.clientY - r.top - 40) + 'px';
    });
    wrap.addEventListener('pointerleave', () => (tip.hidden = true));
  }
};
