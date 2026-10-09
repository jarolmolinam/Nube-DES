// Interfaz del applet "Un pod es una cola de un servidor".
// Usa el motor (src/motor) y el modelo (src/modelos/pod-unico.js) tal cual:
// aquí solo hay dibujo, formularios y el bucle de animación.

/* global PodUnico, teoriaPara, validarEscenario, escenarioPorDefecto, crearDistribucion,
   especPorDefecto, resumenDistribucion, CATALOGO, percentil,
   $, el, elSvg, num, entero, adapt, pct, corto, Grafico, vistaDistribucion */

// ---------------------------------------------------------------------------
// Escenarios de ejemplo
// ---------------------------------------------------------------------------
const base = escenarioPorDefecto();
const PREAJUSTES = [
  { id: 'mm1', esc: { ...base } },
  { id: 'md1', esc: { ...base, nombre: 'M/D/1: servicio constante', servicio: { tipo: 'constante', valor: 80 } } },
  { id: 'mg1', esc: { ...base, nombre: 'M/G/1: servicio muy variable (CV = 2)', servicio: { tipo: 'lognormal', media: 80, cv: 2 } } },
  { id: 'saturado', esc: { ...base, nombre: 'Saturado (ρ = 1,25): la cola no para de crecer', servicio: { tipo: 'exponencial', media: 125 }, horizonte: 600000 } },
  { id: 'mm1k', esc: { ...base, nombre: 'M/M/1/5: sobrecarga con rechazos', servicio: { tipo: 'exponencial', media: 125 }, capacidadCola: 4 } },
  { id: 'traza', esc: { ...base, nombre: 'Traza para seguir a mano (D/D/1 con rechazos)', llegadas: { tipo: 'constante', valor: 2 }, servicio: { tipo: 'constante', valor: 3 }, capacidadCola: 1, horizonte: 30 } },
];
const VELOCIDADES = [0.5, 1, 2, 5, 10, 25, 100]; // llegadas por segundo real, en promedio
const NOMBRE_EVENTO = { 'llegada': 'Llegada', 'fin-servicio': 'Fin de servicio', 'fin-calentamiento': 'Fin de calentamiento' };

// Geometría del diagrama (coordenadas del viewBox)
const GEO = {
  fuente: { x: 174, y: 104 },
  ranura: (i) => ({ x: 540 - i * 23, y: 124 }),
  entradaCola: { x: 280, y: 124 },
  pod: { x: 726, y: 98 },
  salida: { x: 868, y: 104 },
  rechazo: { x: 218, y: 184 },
  ranurasVisibles: 12,
};

// ---------------------------------------------------------------------------
// Estado de la interfaz
// ---------------------------------------------------------------------------
let esc = validarEscenario(PREAJUSTES[0].esc);
let modelo = null;
let teoria = null;
let resultados = null;
let corriendo = false;
let rapido = false;
let relojVisual = 0;        // el reloj que se muestra; avanza de forma continua al animar
let relojIntegro = true;    // ¿algún evento hizo retroceder el reloj?
let instantePrevio = 0;
let bitacora = [];
let serieN = [];
let serieW = [];
let zancadaW = 1;
const fichas = new Map();
const pendiente = { diagrama: true, motor: true, metricas: true, graficos: true };
const ultimo = { motor: 0, metricas: 0, graficos: 0, diagrama: 0 };

// ---------------------------------------------------------------------------
// Ciclo de vida de la corrida
// ---------------------------------------------------------------------------
function reiniciar() {
  modelo = new PodUnico(esc);
  teoria = teoriaPara(esc);
  corriendo = false;
  rapido = false;
  relojVisual = 0;
  relojIntegro = true;
  instantePrevio = 0;
  bitacora = [];
  serieN = [{ t: 0, n: 0 }];
  serieW = [];
  zancadaW = 1;
  for (const f of fichas.values()) f.nodo.remove();
  fichas.clear();
  pintarEstatico();
  marcarTodo();
}

function marcarTodo() {
  pendiente.diagrama = pendiente.motor = pendiente.metricas = pendiente.graficos = true;
  ultimo.motor = ultimo.metricas = ultimo.graficos = ultimo.diagrama = 0;
}

/** Registra en la interfaz el resultado de ejecutar un evento del modelo. */
function procesar(paso, animar) {
  const { evento, novedades } = paso;
  if (evento.t < instantePrevio) relojIntegro = false;
  instantePrevio = evento.t;

  bitacora.push({ t: evento.t, tipo: evento.tipo, novedades, n: modelo.enSistema, cola: modelo.cola.length });
  if (bitacora.length > 120) bitacora.splice(0, 60);

  serieN.push({ t: evento.t, n: modelo.enSistema });
  if (serieN.length > 800) serieN.splice(0, 400);

  for (const nov of novedades) {
    if (nov.tipo === 'sale') {
      const k = modelo.obs.respuesta.n;
      if (k % zancadaW === 0) {
        serieW.push({ n: k, w: modelo.obs.respuesta.media });
        if (serieW.length > 600) {
          serieW = serieW.filter((_, i) => i % 2 === 1);
          zancadaW *= 2;
        }
      }
    } else if (nov.tipo === 'calentamiento') {
      serieW = [];
      zancadaW = 1;
    }
    if (animar) animarNovedad(nov);
  }
  marcarCambio();
}

function marcarCambio() {
  pendiente.diagrama = pendiente.motor = pendiente.metricas = pendiente.graficos = true;
}

function unEvento() {
  if (modelo.terminado) return;
  corriendo = false;
  rapido = false;
  const paso = modelo.paso();
  if (paso) procesar(paso, true);
  relojVisual = modelo.reloj;
  marcarTodo();
}

/** Adelanta la corrida sin animar hasta el instante t (se usa al abrir la página). */
function adelantarHasta(t) {
  for (;;) {
    const prox = modelo.sim.proximo();
    if (!prox || prox.t > t || prox.t > esc.horizonte) break;
    procesar(modelo.paso(), false);
  }
  relojVisual = Math.min(t, esc.horizonte);
  reconstruirFichas();
  marcarTodo();
}

// ---------------------------------------------------------------------------
// Fichas: las peticiones que se ven moverse por el diagrama
// ---------------------------------------------------------------------------
function crearFicha(id, pos, estado) {
  const nodo = elSvg('g', { class: 'ficha' });
  nodo.append(elSvg('circle', { r: 10 }));
  if (id < 10000) {
    const t = elSvg('text', { y: 3.4 }, String(id));
    if (id >= 1000) t.setAttribute('style', 'font-size:7.5px');
    nodo.append(t);
  }
  $('capa-fichas').append(nodo);
  const f = { id, x: pos.x, y: pos.y, estado, nodo };
  if (estado === 'rechazada') nodo.classList.add('rechazada');
  fichas.set(id, f);
  return f;
}

function animarNovedad(nov) {
  if (nov.tipo === 'encola') {
    if (modelo.cola.length <= GEO.ranurasVisibles) crearFicha(nov.id, GEO.fuente, 'cola');
  } else if (nov.tipo === 'inicia') {
    const f = fichas.get(nov.id) || crearFicha(nov.id, GEO.fuente, 'servicio');
    f.estado = 'servicio';
  } else if (nov.tipo === 'sale') {
    const f = fichas.get(nov.id);
    if (f) f.estado = 'saliendo';
  } else if (nov.tipo === 'rechazo') {
    crearFicha(nov.id, GEO.fuente, 'rechazada');
  }
}

function reconstruirFichas() {
  for (const f of fichas.values()) f.nodo.remove();
  fichas.clear();
  if (modelo.enServicio) crearFicha(modelo.enServicio.id, GEO.pod, 'servicio');
  const visibles = Math.min(GEO.ranurasVisibles, modelo.cola.length);
  for (let i = 0; i < visibles; i++) crearFicha(modelo.cola[i].id, GEO.ranura(i), 'cola');
}

function moverFichas(dt) {
  const puesto = new Map();
  const visibles = Math.min(GEO.ranurasVisibles, modelo.cola.length);
  for (let i = 0; i < visibles; i++) {
    const id = modelo.cola[i].id;
    puesto.set(id, i);
    if (!fichas.has(id)) crearFicha(id, GEO.entradaCola, 'cola'); // venía oculta, más atrás
  }
  const k = 1 - Math.exp(-dt / 80);
  for (const f of fichas.values()) {
    let destino;
    if (f.estado === 'servicio') destino = GEO.pod;
    else if (f.estado === 'saliendo') destino = GEO.salida;
    else if (f.estado === 'rechazada') destino = GEO.rechazo;
    else if (puesto.has(f.id)) destino = GEO.ranura(puesto.get(f.id));
    else { f.nodo.remove(); fichas.delete(f.id); continue; }
    f.x += (destino.x - f.x) * k;
    f.y += (destino.y - f.y) * k;
    const lejos = Math.hypot(destino.x - f.x, destino.y - f.y);
    if ((f.estado === 'saliendo' || f.estado === 'rechazada') && lejos < 3) {
      f.nodo.remove();
      fichas.delete(f.id);
      continue;
    }
    f.nodo.setAttribute('transform', `translate(${f.x.toFixed(1)} ${f.y.toFixed(1)})`);
  }
  // Si la animación va muy rápida se acumulan fichas de salida: se descartan.
  if (fichas.size > 60) {
    for (const f of [...fichas.values()]) {
      if (f.estado === 'saliendo' || f.estado === 'rechazada') { f.nodo.remove(); fichas.delete(f.id); }
    }
  }
}

// ---------------------------------------------------------------------------
// Diagrama
// ---------------------------------------------------------------------------
function pintarEstatico() {
  const dl = crearDistribucion(esc.llegadas);
  $('d-dist-llegadas').textContent = resumenDistribucion(esc.llegadas);
  $('d-dist-servicio').textContent = resumenDistribucion(esc.servicio);
  $('d-lambda').textContent = `λ = ${corto(1000 / dl.media)} req/s`;
  const limitada = esc.capacidadCola !== null;
  $('d-cola-tipo').textContent = limitada
    ? `FIFO · ${esc.capacidadCola === 1 ? 'cabe 1' : `caben ${esc.capacidadCola}`}`
    : 'FIFO · sin límite';
  $('rama-rechazo').classList.toggle('apagado', !limitada);
  const ranuras = $('ranuras');
  ranuras.replaceChildren();
  const cuantas = limitada ? Math.min(esc.capacidadCola, GEO.ranurasVisibles) : GEO.ranurasVisibles;
  for (let i = 0; i < cuantas; i++) {
    const p = GEO.ranura(i);
    ranuras.append(elSvg('circle', { class: 'ranura', cx: p.x, cy: p.y, r: 10 }));
  }
  $('kendall').textContent = teoria.kendall;
  $('teoria-nombre').textContent = teoria.nombre;
  const nota = $('teoria-nota');
  nota.hidden = !teoria.nota;
  nota.textContent = teoria.nota || '';
  const hayTeoria = teoria.metodo === 'exacta' || teoria.metodo === 'aproximada';
  $('ley-g1-teo').hidden = !hayTeoria;
  $('ley-g2-teo').hidden = !hayTeoria;
  $('ley-g3-teo').hidden = !teoria.densidadW;
}

function pintarDiagrama() {
  $('d-llegadas').textContent = `llegadas: ${entero(modelo.llegadas)}`;
  $('d-atendidas').textContent = entero(modelo.atendidas);
  $('d-rechazadas').textContent = `rechazadas: ${entero(modelo.rechazadas)}`;
  const ocultas = modelo.cola.length - Math.min(modelo.cola.length, GEO.ranurasVisibles);
  $('d-en-cola').textContent = `en cola: ${entero(modelo.cola.length)}${ocultas > 0 ? ` (${entero(ocultas)} sin dibujar)` : ''}`;
  $('d-pod-estado').textContent = modelo.enServicio ? `atiende #${modelo.enServicio.id}` : 'libre';
}

function pintarReloj() {
  const s = modelo.enServicio;
  const fraccion = s && s.servicio > 0 ? Math.max(0, Math.min(1, (relojVisual - s.tInicio) / s.servicio)) : 0;
  $('d-avance').setAttribute('width', (124 * fraccion).toFixed(1));
  $('reloj-valor').textContent = `${num(relojVisual, relojVisual >= 100000 ? 0 : 1)} ms`;
  $('avance-horizonte').style.width = `${Math.min(100, (relojVisual / esc.horizonte) * 100)}%`;
  const estado = modelo.terminado ? ' · terminó' : '';
  $('reloj-detalle').textContent = `${entero(modelo.sim.eventosEjecutados)} eventos · horizonte ${corto(esc.horizonte / 1000)} s${estado}`;
}

function pintarBotones() {
  $('btn-correr').textContent = corriendo ? 'Pausar' : 'Correr';
  $('btn-correr').disabled = modelo.terminado || rapido;
  $('btn-paso').disabled = modelo.terminado || rapido;
  $('btn-final').disabled = modelo.terminado || rapido;
}

// ---------------------------------------------------------------------------
// El motor por dentro
// ---------------------------------------------------------------------------
function describir(r) {
  const [a, b] = r.novedades;
  if (r.tipo === 'llegada') {
    if (a.tipo === 'inicia') return `#${a.id} llega y pasa directo al pod`;
    if (a.tipo === 'encola') return `#${a.id} llega y espera (${entero(r.cola)} en cola)`;
    return `#${a.id} llega con la cola llena: rechazada`;
  }
  if (r.tipo === 'fin-servicio') {
    return `#${a.id} sale tras ${adapt(a.respuesta)} ms${b ? `; entra #${b.id}` : '; el pod queda libre'}`;
  }
  return 'Se descartan las estadísticas del arranque';
}

function celdaEvento(tipo) {
  const td = el('td');
  td.append(el('span', { class: 'tipo-evento', 'data-tipo': tipo }, NOMBRE_EVENTO[tipo] || tipo));
  return td;
}

function pintarMotor() {
  $('e-sistema').textContent = entero(modelo.enSistema);
  $('e-cola').textContent = entero(modelo.cola.length);
  $('e-pod').textContent = modelo.enServicio ? 'ocupado' : 'libre';

  const lista = $('tabla-lista');
  lista.replaceChildren();
  modelo.sim.lista.ordenados().forEach((ev, i) => {
    const tr = el('tr', i === 0 ? { class: 'proximo' } : {});
    tr.append(
      el('td', { class: 'num' }, num(ev.t, 2)),
      celdaEvento(ev.tipo),
      el('td', { class: 'num' }, ev.datos.id ? `#${ev.datos.id}` : '—'),
      el('td', { class: 'num' }, num(Math.max(0, ev.t - relojVisual), 2)),
    );
    lista.append(tr);
  });

  const cuerpo = $('tabla-bitacora');
  cuerpo.replaceChildren();
  if (bitacora.length === 0) {
    const tr = el('tr');
    tr.append(el('td', { colspan: 4, class: 'tenue' }, 'Todavía no se ha ejecutado ningún evento. Pulsa “Un evento” para ver el primero.'));
    cuerpo.append(tr);
    return;
  }
  for (let i = bitacora.length - 1; i >= Math.max(0, bitacora.length - 40); i--) {
    const r = bitacora[i];
    const tr = el('tr');
    tr.append(el('td', { class: 'num' }, num(r.t, 2)), celdaEvento(r.tipo), el('td', {}, describir(r)), el('td', { class: 'num' }, entero(r.n)));
    cuerpo.append(tr);
  }
}

// ---------------------------------------------------------------------------
// Indicadores y verificación
// ---------------------------------------------------------------------------
const reqSeg = (x) => (Number.isFinite(x) ? `${adapt(x * 1000)} req/s` : '—');
const ms = (x) => (Number.isFinite(x) ? `${adapt(x)} ms` : '—');
const FILAS = [
  { id: 'rho', nombre: 'Utilización del pod', simbolo: 'ρ', fmt: (x) => pct(x) },
  { id: 'L', nombre: 'Peticiones en el sistema', simbolo: 'L', fmt: adapt },
  { id: 'Lq', nombre: 'Peticiones en cola', simbolo: 'Lq', fmt: adapt },
  { id: 'W', nombre: 'Tiempo de respuesta medio', simbolo: 'W', fmt: ms },
  { id: 'Wq', nombre: 'Espera en cola media', simbolo: 'Wq', fmt: ms },
  { id: 'p95', nombre: 'Tiempo de respuesta p95', simbolo: 'p95', fmt: ms, teo: (t) => (t.percentilW ? t.percentilW(0.95) : NaN) },
  { id: 'X', nombre: 'Rendimiento', simbolo: 'X', fmt: reqSeg },
  { id: 'pRechazo', nombre: 'Peticiones rechazadas', simbolo: '', fmt: (x) => pct(x, 2) },
];

function pintarMetricas() {
  resultados = modelo.resultados();
  const r = resultados;
  const hayTeoria = teoria.metodo === 'exacta' || teoria.metodo === 'aproximada';
  const cuerpo = $('tabla-metricas');
  cuerpo.replaceChildren();
  for (const f of FILAS) {
    const sim = r[f.id];
    const teo = hayTeoria ? (f.teo ? f.teo(teoria) : teoria[f.id]) : NaN;
    const tr = el('tr');
    const celdaDif = el('td', { class: 'num' });
    if (Number.isFinite(sim) && Number.isFinite(teo)) {
      const caja = el('span', { class: 'dif' });
      if (Math.abs(teo) < 1e-12) {
        caja.append(el('span', {}, Math.abs(sim) < 1e-12 ? 'igual' : '—'));
        if (Math.abs(sim) < 1e-12 && teoria.metodo === 'exacta') caja.append(el('span', { class: 'ok', title: 'Coincide con la teoría' }, '✓'));
      } else {
        const d = (sim - teo) / teo;
        caja.append(el('span', {}, `${d > 0 ? '+' : ''}${num(d * 100, 1)} %`));
        if (Math.abs(d) <= 0.05 && teoria.metodo === 'exacta') caja.append(el('span', { class: 'ok', title: 'A menos del 5 % de la teoría' }, '✓'));
      }
      celdaDif.append(caja);
    } else {
      celdaDif.textContent = '—';
    }
    tr.append(
      el('td', {}, f.nombre),
      el('td', { class: 'simbolo' }, f.simbolo),
      el('td', { class: 'num' }, f.fmt(sim)),
      el('td', { class: 'num' }, Number.isFinite(teo) ? f.fmt(teo) : '—'),
      celdaDif,
    );
    cuerpo.append(tr);
  }
  const calent = esc.calentamiento > 0 ? ` Se descartan los primeros ${corto(esc.calentamiento / 1000)} s.` : '';
  $('metricas-nota').textContent =
    `Medido sobre ${entero(r.n)} peticiones atendidas en ${corto(r.duracionObservada / 1000)} s simulados.${calent} ` +
    (teoria.metodo === 'exacta'
      ? 'La marca ✓ aparece cuando lo simulado queda a menos del 5 % del valor teórico. Con pocas peticiones la diferencia es grande y baja al crecer la muestra.'
      : teoria.metodo === 'aproximada'
        ? 'El valor teórico es una aproximación, así que una diferencia de varios puntos no indica un error del simulador.'
        : 'Sin referencia teórica, la verificación descansa en los invariantes de la derecha.');

  pintarVerificacion(r);
}

function pintarVerificacion(r) {
  const little = r.lambdaEfectiva * r.W;
  const difLittle = Number.isFinite(little) && little > 0 ? Math.abs(r.L - little) / little : NaN;
  const hayMuestra = r.n >= 500;
  const items = [
    {
      titulo: 'Conservación de peticiones',
      estado: r.conserva ? 'bien' : 'falla',
      detalle: `llegadas ${entero(r.llegadas)} = atendidas ${entero(r.atendidas)} + rechazadas ${entero(r.rechazadas)} + en el sistema ${entero(r.enSistema)}`,
    },
    {
      titulo: 'El reloj nunca retrocede',
      estado: relojIntegro ? 'bien' : 'falla',
      detalle: `${entero(r.eventos)} eventos ejecutados en orden de tiempo`,
    },
    {
      titulo: 'Ley de Little: L = λ · W',
      estado: !hayMuestra ? 'pendiente' : difLittle <= 0.03 ? 'bien' : 'pendiente',
      detalle: hayMuestra || Number.isFinite(difLittle)
        ? `L = ${adapt(r.L)} frente a λ·W = ${adapt(little)} (diferencia ${pct(difLittle)})`
        : 'necesita peticiones atendidas',
    },
    {
      titulo: 'Corrida reproducible',
      estado: 'info',
      detalle: `semilla ${esc.semilla} · huella ${r.huella} tras ${entero(r.eventos)} eventos`,
    },
  ];
  const SELLO = { bien: '✓ Cumple', falla: '✕ Falla', pendiente: '… Faltan datos', info: 'Huella' };
  const lista = $('verificaciones');
  lista.replaceChildren();
  for (const it of items) {
    const li = el('li');
    const cuerpo = el('div');
    cuerpo.append(el('strong', {}, it.titulo), el('span', { class: 'detalle' }, it.detalle));
    li.append(el('span', { class: 'sello', 'data-estado': it.estado === 'info' ? 'pendiente' : it.estado }, SELLO[it.estado]), cuerpo);
    lista.append(li);
  }
}

// ---------------------------------------------------------------------------
// Gráficos del applet (la clase Grafico está en web/comun/base.js)
// ---------------------------------------------------------------------------
let gN, gW, gH;

function graficoN() {
  const hayTeoria = Number.isFinite(teoria.L);
  const pts = serieN.slice(-300);
  const tFin = Math.max(relojVisual, pts[pts.length - 1].t);
  const t0 = pts[0].t;
  if (!(tFin > t0)) return gN.dibujar({ vacio: 'Aún no hay cambios de estado' });
  const enSeg = tFin >= 20000;
  const u = enSeg ? 1000 : 1;
  let maxN = 4;
  for (const p of pts) if (p.n > maxN) maxN = p.n;
  if (hayTeoria) maxN = Math.max(maxN, teoria.L * 1.25);
  gN.dibujar({
    x: { min: t0 / u, max: tFin / u, titulo: `tiempo simulado (${enSeg ? 's' : 'ms'})` },
    y: { min: 0, max: maxN },
    capas: ({ px, py, x0, x1, y0 }) => {
      let d = `M${px(pts[0].t / u).toFixed(1)} ${py(pts[0].n).toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) d += `H${px(pts[i].t / u).toFixed(1)}V${py(pts[i].n).toFixed(1)}`;
      d += `H${px(tFin / u).toFixed(1)}`;
      let s = `<path class="a-sim" d="${d}V${y0}H${px(pts[0].t / u).toFixed(1)}Z"/><path class="l-sim" d="${d}"/>`;
      if (hayTeoria) {
        const y = py(teoria.L);
        s += `<line class="l-teo" x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"/>`;
        s += `<text class="directa" x="${x1}" y="${y - 5}" text-anchor="end">L = ${adapt(teoria.L)}</text>`;
      }
      return s;
    },
    puntos: pts.map((p) => ({
      x: p.t / u,
      titulo: `t = ${enSeg ? `${num(p.t / 1000, 2)} s` : `${num(p.t, 2)} ms`}`,
      filas: [{ clave: '', nombre: 'en el sistema', valor: entero(p.n) }]
        .concat(hayTeoria ? [{ clave: 'teo', nombre: 'L teórico', valor: adapt(teoria.L) }] : []),
    })),
  });
}

function graficoW() {
  const hayTeoria = Number.isFinite(teoria.W);
  if (serieW.length < 2) return gW.dibujar({ vacio: 'Aún no hay peticiones atendidas' });
  const fin = serieW[serieW.length - 1];
  let maxW = 0;
  for (const p of serieW) if (p.w > maxW) maxW = p.w;
  if (hayTeoria) maxW = Math.max(maxW, teoria.W);
  gW.dibujar({
    x: { min: 0, max: fin.n, titulo: 'peticiones atendidas' },
    y: { min: 0, max: maxW * 1.15 },
    capas: ({ px, py, x0, x1 }) => {
      let d = '';
      serieW.forEach((p, i) => { d += `${i ? 'L' : 'M'}${px(p.n).toFixed(1)} ${py(p.w).toFixed(1)}`; });
      let s = '';
      if (hayTeoria) {
        const y = py(teoria.W);
        s += `<line class="l-teo" x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"/>`;
        s += `<text class="directa" x="${x0 + 6}" y="${y - 5}">W = ${adapt(teoria.W)} ms</text>`;
      }
      s += `<path class="l-sim" d="${d}"/><circle class="punto" cx="${px(fin.n)}" cy="${py(fin.w)}" r="4.5"/>`;
      const arriba = !hayTeoria || fin.w >= teoria.W;
      s += `<text class="directa" x="${x1}" y="${py(fin.w) + (arriba ? -9 : 17)}" text-anchor="end">${adapt(fin.w)} ms</text>`;
      return s;
    },
    puntos: serieW.map((p) => ({
      x: p.n,
      titulo: `${entero(p.n)} peticiones`,
      filas: [{ clave: '', nombre: 'media simulada', valor: `${adapt(p.w)} ms` }]
        .concat(hayTeoria ? [{ clave: 'teo', nombre: 'W teórico', valor: `${adapt(teoria.W)} ms` }] : []),
    })),
  });
}

function graficoH() {
  const datos = resultados ? resultados.respuestasOrdenadas : [];
  const n = datos.length;
  if (n < 10) return gH.dibujar({ vacio: 'Se necesitan al menos 10 peticiones atendidas' });
  const tope = percentil(datos, 0.99) || datos[n - 1] || 1;
  const CUBETAS = 24;
  const anchoCubeta = tope / CUBETAS;
  const cuenta = new Array(CUBETAS).fill(0);
  for (let i = 0; i < n; i++) {
    const v = datos[i];
    if (v > tope) break;
    cuenta[Math.min(CUBETAS - 1, Math.floor(v / anchoCubeta))]++;
  }
  let maxC = Math.max(...cuenta);
  const densidad = teoria.densidadW;
  if (densidad) maxC = Math.max(maxC, n * anchoCubeta * densidad(0));
  const p50 = percentil(datos, 0.5);
  const p95 = percentil(datos, 0.95);
  gH.dibujar({
    x: { min: 0, max: tope, titulo: 'tiempo de respuesta (ms)' },
    y: { min: 0, max: maxC * 1.08 },
    capas: ({ px, py, y0, y1 }) => {
      let s = '';
      cuenta.forEach((c, i) => {
        const xa = px(i * anchoCubeta) + 1;
        const xb = px((i + 1) * anchoCubeta) - 1;
        const y = py(c);
        const r = Math.min(3, (xb - xa) / 2, y0 - y);
        if (c > 0) {
          s += `<path class="b-sim" data-barra="${i}" d="M${xa.toFixed(1)} ${y0}V${(y + r).toFixed(1)}q0 ${-r} ${r} ${-r}H${(xb - r).toFixed(1)}q${r} 0 ${r} ${r}V${y0}Z"/>`;
        }
      });
      if (densidad) {
        let d = '';
        for (let i = 0; i <= 48; i++) {
          const x = (tope * i) / 48;
          d += `${i ? 'L' : 'M'}${px(x).toFixed(1)} ${py(n * anchoCubeta * densidad(x)).toFixed(1)}`;
        }
        s += `<path class="l-teo" d="${d}"/>`;
      }
      for (const [nombre, v] of [['p50', p50], ['p95', p95]]) {
        if (v <= tope) {
          s += `<line class="marca-p" x1="${px(v)}" x2="${px(v)}" y1="${y1 + 10}" y2="${y0}"/>`;
          s += `<text class="directa" x="${px(v)}" y="${y1 + 6}" text-anchor="middle">${nombre}</text>`;
        }
      }
      return s;
    },
    puntos: cuenta.map((c, i) => ({
      x: (i + 0.5) * anchoCubeta,
      barra: i,
      titulo: `${adapt(i * anchoCubeta)} a ${adapt((i + 1) * anchoCubeta)} ms`,
      filas: [{ clave: 'caja', nombre: `peticiones (${pct(c / n)})`, valor: entero(c) }],
    })),
  });
}

function pintarGraficos() {
  graficoN();
  graficoW();
  graficoH();
}

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------
const GRUPOS = { lleg: 'llegadas', serv: 'servicio' };

function pintarFormDist(pref) {
  const espec = esc[GRUPOS[pref]];
  $(`${pref}-tipo`).value = espec.tipo;
  const cont = $(`${pref}-params`);
  cont.replaceChildren();
  for (const p of CATALOGO[espec.tipo].params) {
    const id = `${pref}-p-${p.id}`;
    const esLista = p.unidad === 'lista';
    const campo = el('div', { class: `campo${esLista ? ' ancho' : ''}` });
    const entrada = esLista
      ? el('input', { type: 'text', id, class: 'dato', inputmode: 'decimal' })
      : el('input', { type: 'number', id, min: p.min, step: p.entero ? 1 : 'any' });
    entrada.value = esLista ? espec[p.id].join('; ') : espec[p.id];
    entrada.addEventListener('change', () => leerFormDist(pref));
    campo.append(
      el('label', { for: id }, esLista ? 'Valores medidos (ms), separados por punto y coma' : `${p.etiqueta}${p.unidad === 'tiempo' ? ' (ms)' : ''}`),
      entrada,
    );
    cont.append(campo);
  }
  const d = crearDistribucion(espec);
  const tasa = pref === 'lleg' ? `λ = ${corto(1000 / d.media)} req/s` : `μ = ${corto(1000 / d.media)} req/s`;
  $(`${pref}-resumen`).textContent = `media ${corto(d.media)} ms · CV² = ${corto(d.cv2)} · ${tasa}`;
  vistaDistribucion($(`${pref}-vista`), espec);
}

function leerFormDist(pref) {
  const tipo = $(`${pref}-tipo`).value;
  const espec = { tipo };
  for (const p of CATALOGO[tipo].params) {
    const bruto = $(`${pref}-p-${p.id}`).value;
    espec[p.id] = p.unidad === 'lista'
      ? bruto.split(/[;\s]+/).filter(Boolean).map((x) => Number(x.replace(',', '.')))
      : Number(bruto);
  }
  aplicarCambio({ [GRUPOS[pref]]: espec }, `${pref}-error`);
}

function mostrarError(id, mensaje) {
  for (const otro of ['lleg-error', 'serv-error', 'corrida-error', 'json-error']) {
    $(otro).hidden = otro !== id || !mensaje;
    if (otro === id) $(otro).textContent = mensaje || '';
  }
}

function aplicarCambio(cambios, idError) {
  try {
    const nuevo = validarEscenario({ ...esc, ...cambios, nombre: 'Personalizado' });
    mostrarError(idError, '');
    fijarEscenario(nuevo, 'propio');
  } catch (e) {
    mostrarError(idError, e.message);
  }
}

function pintarFormularios() {
  pintarFormDist('lleg');
  pintarFormDist('serv');
  const limitada = esc.capacidadCola !== null;
  $('cola-limitada').checked = limitada;
  $('cola-capacidad').disabled = !limitada;
  if (limitada) $('cola-capacidad').value = esc.capacidadCola;
  $('horizonte').value = esc.horizonte / 1000;
  $('calentamiento').value = esc.calentamiento / 1000;
  $('semilla').value = esc.semilla;

  const carga = teoriaPara(esc).cargaOfrecida;
  const medidor = $('medidor-carga');
  $('medidor-relleno').style.width = `${(Math.min(carga, 1.5) / 1.5) * 100}%`;
  let nivel = 'normal';
  let lectura = 'el pod da abasto';
  if (carga >= 1) {
    nivel = 'critico';
    lectura = limitada ? 'sobrecarga: habrá rechazos' : 'saturado: la cola crece sin límite';
  } else if (carga >= 0.9) {
    nivel = 'alerta';
    lectura = 'cerca del límite: esperas largas';
  }
  medidor.dataset.nivel = nivel;
  const texto = $('medidor-texto');
  texto.replaceChildren(document.createTextNode('Carga ofrecida ρ = λ/μ = '), el('strong', {}, corto(carga)), document.createTextNode(` · ${lectura}`));
}

function fijarEscenario(nuevo, idPreajuste) {
  esc = nuevo;
  $('preajuste').value = idPreajuste;
  $('json-texto').value = JSON.stringify(esc, null, 2);
  $('json-estado').textContent = '';
  pintarFormularios();
  reiniciar();
}

function leerCorrida() {
  const limitada = $('cola-limitada').checked;
  $('cola-capacidad').disabled = !limitada;
  aplicarCambio({
    capacidadCola: limitada ? Number($('cola-capacidad').value) : null,
    horizonte: Number($('horizonte').value) * 1000,
    calentamiento: Number($('calentamiento').value) * 1000,
    semilla: Number($('semilla').value),
  }, 'corrida-error');
}

function pintarVelocidad() {
  const v = VELOCIDADES[Number($('velocidad').value)];
  $('velocidad-texto').textContent = `≈ ${corto(v)} ${v === 1 ? 'llegada' : 'llegadas'} por segundo`;
}

// ---------------------------------------------------------------------------
// Bucle de animación
// ---------------------------------------------------------------------------
let marcaPrevia = 0;

function cuadro(marca) {
  const dt = Math.min(100, marca - (marcaPrevia || marca));
  marcaPrevia = marca;

  if (rapido) {
    const limite = performance.now() + 12;
    let sigue = true;
    while (sigue && performance.now() < limite) {
      for (let i = 0; i < 2000; i++) {
        const paso = modelo.paso();
        if (!paso) { sigue = false; break; }
        procesar(paso, false);
      }
    }
    relojVisual = modelo.reloj;
    reconstruirFichas();
    if (modelo.terminado) { rapido = false; marcarTodo(); }
  } else if (corriendo) {
    const mediaLlegadas = modelo.distLlegadas.media;
    relojVisual += (dt / 1000) * VELOCIDADES[Number($('velocidad').value)] * mediaLlegadas;
    let cuenta = 0;
    for (;;) {
      const prox = modelo.sim.proximo();
      if (!prox || prox.t > relojVisual || prox.t > esc.horizonte) break;
      procesar(modelo.paso(), true);
      if (++cuenta > 4000) { relojVisual = modelo.reloj; break; }
    }
    if (relojVisual >= esc.horizonte) {
      relojVisual = esc.horizonte;
      modelo.paso(); // cierra la corrida en el horizonte
      corriendo = false;
      marcarTodo();
    }
    pendiente.motor = true;
  }

  if (!rapido) moverFichas(dt);
  pintarReloj();
  pintarBotones();
  if (pendiente.diagrama && marca - ultimo.diagrama > 60) { pintarDiagrama(); pendiente.diagrama = false; ultimo.diagrama = marca; }
  if (pendiente.motor && marca - ultimo.motor > 110) { pintarMotor(); pendiente.motor = false; ultimo.motor = marca; }
  if (pendiente.metricas && marca - ultimo.metricas > 260) { pintarMetricas(); pendiente.metricas = false; ultimo.metricas = marca; }
  if (pendiente.graficos && marca - ultimo.graficos > 260) { pintarGraficos(); pendiente.graficos = false; ultimo.graficos = marca; }
  requestAnimationFrame(cuadro);
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
function enfocarGrupo(idGrupo, idCampo) {
  const grupo = $(idGrupo);
  grupo.scrollIntoView({ block: 'center', behavior: 'smooth' });
  grupo.classList.add('resaltado');
  setTimeout(() => grupo.classList.remove('resaltado'), 1800);
  $(idCampo).focus({ preventScroll: true });
}

function conectarBloque(idBloque, idGrupo, idCampo) {
  const b = $(idBloque);
  b.addEventListener('click', () => enfocarGrupo(idGrupo, idCampo));
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enfocarGrupo(idGrupo, idCampo); }
  });
}

function iniciar() {
  const sel = $('preajuste');
  for (const p of PREAJUSTES) sel.append(el('option', { value: p.id }, p.esc.nombre));
  sel.append(el('option', { value: 'propio' }, 'Personalizado'));
  sel.addEventListener('change', () => {
    const p = PREAJUSTES.find((x) => x.id === sel.value);
    if (p) { mostrarError('', ''); fijarEscenario(validarEscenario(p.esc), p.id); }
    else sel.value = 'propio';
  });

  for (const pref of ['lleg', 'serv']) {
    const s = $(`${pref}-tipo`);
    for (const [tipo, info] of Object.entries(CATALOGO)) s.append(el('option', { value: tipo }, info.etiqueta));
    s.addEventListener('change', () => {
      const mediaActual = crearDistribucion(esc[GRUPOS[pref]]).media;
      aplicarCambio({ [GRUPOS[pref]]: especPorDefecto(s.value, mediaActual) }, `${pref}-error`);
    });
  }
  for (const id of ['cola-limitada', 'cola-capacidad', 'horizonte', 'calentamiento', 'semilla']) {
    $(id).addEventListener('change', leerCorrida);
  }
  $('btn-semilla').addEventListener('click', () => {
    $('semilla').value = 1 + Math.floor(Math.random() * 99999);
    leerCorrida();
  });

  $('btn-correr').addEventListener('click', () => { if (!modelo.terminado) corriendo = !corriendo; });
  $('btn-paso').addEventListener('click', unEvento);
  $('btn-final').addEventListener('click', () => { if (!modelo.terminado) { corriendo = false; rapido = true; } });
  $('btn-reiniciar').addEventListener('click', reiniciar);
  $('velocidad').addEventListener('input', pintarVelocidad);

  $('btn-json-aplicar').addEventListener('click', () => {
    try {
      const nuevo = validarEscenario(JSON.parse($('json-texto').value));
      mostrarError('json-error', '');
      const igual = PREAJUSTES.find((p) => JSON.stringify(validarEscenario(p.esc)) === JSON.stringify(nuevo));
      fijarEscenario(nuevo, igual ? igual.id : 'propio');
      $('json-estado').textContent = 'Escenario aplicado';
    } catch (e) {
      mostrarError('json-error', e instanceof SyntaxError ? `El texto no es JSON válido: ${e.message}` : e.message);
    }
  });
  $('btn-json-copiar').addEventListener('click', async () => {
    const area = $('json-texto');
    try {
      await navigator.clipboard.writeText(area.value);
      $('json-estado').textContent = 'Copiado';
    } catch {
      area.focus();
      area.select();
      $('json-estado').textContent = 'Texto seleccionado: cópialo con Ctrl+C';
    }
  });

  conectarBloque('b-fuente', 'fs-llegadas', 'lleg-tipo');
  conectarBloque('b-pod', 'fs-servicio', 'serv-tipo');
  conectarBloque('b-cola', 'fs-corrida', 'cola-limitada');

  gN = new Grafico('g-n');
  gW = new Grafico('g-w');
  gH = new Grafico('g-h');
  let espera = 0;
  window.addEventListener('resize', () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      vistaDistribucion($('lleg-vista'), esc.llegadas);
      vistaDistribucion($('serv-vista'), esc.servicio);
      marcarTodo();
    }, 150);
  });

  pintarVelocidad();
  fijarEscenario(esc, 'mm1');
  // La página abre con 30 s ya simulados para que el tablero no esté vacío.
  adelantarHasta(30000);
  requestAnimationFrame(cuadro);
}

iniciar();
