// Interfaz del applet "Una cadena de microservicios sobre un nodo".
// El modelo está en src/modelos/cadena.js; aquí solo hay dibujo, formularios,
// el bucle de animación y los tres paneles de observabilidad.

/* global Cadena, validarCadena, escenarioCadenaPorDefecto, teoriaCadena, BALANCEOS, MODOS_HPA,
   crearDistribucion, resumenDistribucion,
   $, el, NS_SVG, num, entero, adapt, pct, corto, marcasEje, etiquetaEje, montarFormDist */

// ---------------------------------------------------------------------------
// Escenarios de ejemplo
// ---------------------------------------------------------------------------
function variante(nombre, cambiar) {
  const e = escenarioCadenaPorDefecto();
  e.nombre = nombre;
  cambiar(e);
  return e;
}
const PREAJUSTES = [
  { id: 'guia', esc: escenarioCadenaPorDefecto() },
  { id: 'estable', esc: variante('Dimensionado a mano: 1, 2 y 2 réplicas', (e) => {
    e.servicios[1].replicas = 2; e.servicios[2].replicas = 2; e.hpa.modo = 'apagado'; e.horizonte = 3600000;
  }) },
  { id: 'hpa', esc: variante('El HPA aplica el escalado', (e) => { e.hpa.modo = 'aplicar'; }) },
  { id: 'pico', esc: variante('Pico de tráfico: de 5 a 40 pet/s durante 5 minutos', (e) => {
    e.llegadas.media = 200; e.pico = { desde: 300000, hasta: 600000, factor: 8 };
    e.hpa.modo = 'aplicar'; e.hpa.estabilizacion = 120000; e.horizonte = 1200000;
  }) },
  { id: 'nodo', esc: variante('Nodo pequeño: el HPA se queda sin cupo', (e) => {
    e.nodo.cpu = 4000; e.nodo.ram = 4096; e.hpa.modo = 'aplicar';
  }) },
  { id: 'contencion', esc: variante('Limits sin respaldo: contención en el nodo', (e) => {
    e.nodo.cpu = 2000; e.hpa.modo = 'apagado'; e.balanceo = 'menos-ocupada';
    [1, 3, 2].forEach((c, k) => { e.servicios[k].replicas = c; e.servicios[k].cpuRequest = 250; });
  }) },
];
const VELOCIDADES = [0.25, 0.5, 1, 2, 5, 10, 30, 60]; // segundos simulados por segundo real
const VENTANA = 15; // muestras (segundos) que resumen los bloques de métricas

// Geometría del tablero, en píxeles antes de escalar
const TAB = {
  ancho: 1200, alto: 648, x0: 214, x1: 1058, hueco: 38, yEje: 261,
  cluster: { x: 196, y: 8, w: 880, h: 632 },
  nodo: { y: 34, h: 98 },
  servicio: { y: 172, h: 178 },
  info: { y: 384, h: 112 },
  hpa: { y: 530, h: 106 },
  llegadas: { x: 12, y: 200, w: 160, h: 122 },
  salida: { x: 1100, y: 219, w: 88, h: 84 },
};
function cajaServicio(k, n) {
  const w = (TAB.x1 - TAB.x0 - TAB.hueco * (n - 1)) / n;
  return { x: TAB.x0 + k * (w + TAB.hueco), w };
}
const colorDe = (k) => `var(--s${k + 1})`;

// ---------------------------------------------------------------------------
// Estado de la interfaz
// ---------------------------------------------------------------------------
let esc = validarCadena(PREAJUSTES[0].esc);
let modelo = null;
let teoria = null;
let resultados = null;
let corriendo = false;
let rapido = false;
let metaTramo = null;       // si no es null, "Avanzar 15 s" corre hasta ese instante
let relojVisual = 0;
let relojIntegro = true;
let cupoIntegro = true;
let instantePrevio = 0;
let logControl = [];
let logPeticiones = [];
let filtroLog = 'control';
let firmaHPA = [];
let fichas = [];
let tramosCable = [];
const pendiente = { tablero: true, info: true, cifras: true, graficos: true, logs: true, trazas: true, teoria: true };
const ultimo = { tablero: 0, info: 0, cifras: 0, graficos: 0, logs: 0, trazas: 0, teoria: 0 };
const PERIODO = { tablero: 80, info: 250, cifras: 250, graficos: 400, logs: 250, trazas: 500, teoria: 500 };

function marcarTodo(inmediato = false) {
  for (const k of Object.keys(pendiente)) {
    pendiente[k] = true;
    if (inmediato) ultimo[k] = 0;
  }
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------
const seg = (ms, d = 1) => `${num(ms / 1000, d)} s`;
function marcaTiempo(t) {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60000);
  const s = (total - m * 60000) / 1000;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}
const plural = (n, uno, varios) => `${entero(n)} ${n === 1 ? uno : varios}`;

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
function anotarLog(t, origen, texto, aviso = false) {
  const destino = origen === 'gateway' ? logPeticiones : logControl;
  destino.push({ t, origen, texto, aviso });
  if (destino.length > 400) destino.splice(0, 200);
  pendiente.logs = true;
}

function registrarNovedad(t, nov) {
  const s = nov.i !== undefined ? modelo.servicios[nov.i] : null;
  const id = s ? s.def.id : '';
  const nodo = esc.nodo.nombre;
  switch (nov.tipo) {
    case 'completa':
      anotarLog(t, 'gateway', `GET /compra 200 en ${adapt(nov.total)} ms · traza ${String(nov.id).padStart(6, '0')}`);
      break;
    case 'hpa': {
      // Solo se anota cuando la decisión cambia; si no, el registro se llena de "sin cambios".
      const firma = `${modelo.esc.hpa.modo}/${nov.cruda}/${nov.deseadas}/${nov.actuales}`;
      if (firmaHPA[nov.i] === firma) break;
      firmaHPA[nov.i] = firma;
      const obj = esc.hpa.objetivo;
      let texto = `${id}: uso ${pct(nov.uso, 0)} del request con ${plural(nov.listas, 'réplica lista', 'réplicas listas')}; `
        + `⌈${nov.listas} × ${num(nov.uso * 100, 0)} / ${num(obj * 100, 0)}⌉ = ${nov.cruda}`;
      if (nov.deseadas === nov.actuales) texto += nov.deseadas > nov.cruda ? `; conserva ${nov.actuales} mientras dura la ventana de estabilización` : '; sin cambios';
      else if (modelo.esc.hpa.modo === 'aplicar') texto += `; ordena pasar de ${nov.actuales} a ${nov.deseadas}`;
      else texto += `; recomienda pasar de ${nov.actuales} a ${nov.deseadas}`;
      anotarLog(t, 'hpa', texto);
      break;
    }
    case 'escala':
      anotarLog(t, 'deployment', `${id}: réplicas deseadas de ${nov.de} a ${nov.a} (${nov.origen === 'hpa' ? 'orden del HPA' : 'cambio manual'})`);
      break;
    case 'pod-creado':
      if (!nov.lista) anotarLog(t, 'planificador', `${nov.pod} ubicado en ${nodo}: reserva ${entero(s.def.cpuRequest)} m y ${entero(s.def.ramRequest)} Mi; arrancando`);
      break;
    case 'pod-listo':
      anotarLog(t, 'kubelet', `${nov.pod} listo tras ${corto(nov.arranque / 1000)} s de arranque; el Service ya le envía peticiones`);
      break;
    case 'pod-pendiente':
      anotarLog(t, 'planificador', `${id}: pod Pending, ${nov.falta === 'cpu' ? 'CPU' : 'RAM'} insuficiente en ${nodo}`, true);
      break;
    case 'pod-terminando':
      anotarLog(t, 'kubelet', `${nov.pod} deja de recibir peticiones${nov.pendientes ? `; termina ${plural(nov.pendientes, 'petición', 'peticiones')} antes de apagarse` : ''}`);
      break;
    case 'pod-eliminado':
      anotarLog(t, 'kubelet', `${nov.pod} eliminado: libera ${entero(s.def.cpuRequest)} m y ${entero(s.def.ramRequest)} Mi`);
      break;
    case 'calentamiento':
      anotarLog(t, 'simulador', 'Fin del calentamiento: se reinician las estadísticas');
      break;
    default:
  }
}

// ---------------------------------------------------------------------------
// Ciclo de vida de la corrida
// ---------------------------------------------------------------------------
function reiniciar() {
  modelo = new Cadena(esc);
  teoria = teoriaCadena(esc);
  corriendo = false;
  rapido = false;
  metaTramo = null;
  relojVisual = 0;
  relojIntegro = true;
  cupoIntegro = true;
  instantePrevio = 0;
  logControl = [];
  logPeticiones = [];
  firmaHPA = [];
  limpiarFichas();
  for (const s of modelo.servicios) {
    for (const r of s.replicas) anotarLog(0, 'kubelet', `${r.nombre} listo (réplica inicial, imagen ${s.def.imagen})`);
  }
  pintarEstatico();
  marcarTodo(true);
}

function procesar(paso, animar) {
  const { evento, novedades } = paso;
  if (evento.t < instantePrevio) relojIntegro = false;
  instantePrevio = evento.t;
  if (modelo.nodo.cpuAsignada > modelo.nodo.cpu + 1e-6 || modelo.nodo.ramAsignada > modelo.nodo.ram + 1e-6) cupoIntegro = false;
  for (const nov of novedades) {
    registrarNovedad(evento.t, nov);
    if (animar) animarNovedad(nov);
  }
  marcarTodo();
}

/** Ejecuta todos los eventos hasta el instante t (sin pasar del horizonte). */
function avanzarHasta(t, animar) {
  let cuenta = 0;
  for (;;) {
    const prox = modelo.sim.proximo();
    if (!prox || prox.t > t || prox.t > esc.horizonte) break;
    procesar(modelo.paso(), animar);
    if (++cuenta > 8000) return false; // demasiados eventos para un solo cuadro
  }
  return true;
}

function cerrarSiTermino() {
  if (relojVisual >= esc.horizonte && !modelo.terminado) {
    relojVisual = esc.horizonte;
    modelo.paso();
    corriendo = false;
    rapido = false;
    metaTramo = null;
    marcarTodo(true);
  }
}

// Intervenciones en vivo ------------------------------------------------------
function cambiarReplicas(k, delta) {
  const s = modelo.servicios[k];
  const n = modelo.deseadas(s) + delta;
  if (n < 1 || modelo.terminado) return;
  if (modelo.sim.eventosEjecutados === 0) {
    cambiarEscenario((e) => { e.servicios[k].replicas = n; });
    return;
  }
  if (modelo.escalarManual(k, n, Math.min(relojVisual, esc.horizonte))) {
    for (const nov of modelo.novedades) registrarNovedad(modelo.reloj, nov);
    marcarTodo(true);
  }
}

function cambiarModoHPA(modo) {
  if (modelo.sim.eventosEjecutados === 0 || modelo.terminado) {
    cambiarEscenario((e) => { e.hpa.modo = modo; });
    return;
  }
  if (modelo.cambiarModoHPA(modo, Math.min(relojVisual, esc.horizonte))) {
    esc = { ...esc, nombre: 'Personalizado', hpa: { ...esc.hpa, modo } };
    $('preajuste').value = 'propio';
    $('json-texto').value = JSON.stringify(esc, null, 2);
    anotarLog(modelo.reloj, 'hpa', `Modo cambiado a "${MODOS_HPA[modo].toLowerCase()}" (cambio manual)`);
    marcarTodo(true);
  }
}

// ---------------------------------------------------------------------------
// Tablero: construcción
// ---------------------------------------------------------------------------
function colocar(nodo, caja) {
  nodo.style.left = `${caja.x}px`;
  nodo.style.top = `${caja.y}px`;
  nodo.style.width = `${caja.w}px`;
  nodo.style.height = `${caja.h}px`;
}

function montarTablero() {
  const n = esc.servicios.length;
  const tablero = $('tablero');
  tablero.style.width = `${TAB.ancho}px`;
  tablero.style.height = `${TAB.alto}px`;
  colocar($('cluster'), TAB.cluster);
  colocar($('b-nodo'), { x: TAB.x0, y: TAB.nodo.y, w: TAB.x1 - TAB.x0, h: TAB.nodo.h });
  colocar($('b-hpa'), { x: TAB.x0, y: TAB.hpa.y, w: TAB.x1 - TAB.x0, h: TAB.hpa.h });
  colocar($('b-llegadas'), TAB.llegadas);
  colocar($('b-salida'), TAB.salida);

  const zona = $('bloques-servicio');
  zona.replaceChildren();
  const cols = $('hpa-cols');
  cols.replaceChildren();
  const ancho = cajaServicio(0, n).w;
  cols.style.gridTemplateColumns = `repeat(${n}, ${ancho}px)`;
  cols.style.columnGap = `${TAB.hueco}px`;

  esc.servicios.forEach((def, k) => {
    const caja = cajaServicio(k, n);
    const b = el('div', { class: 'bloque b-servicio', id: `b-s${k}`, style: `--color:${colorDe(k)}` });
    colocar(b, { ...caja, y: TAB.servicio.y, h: TAB.servicio.h });
    const cab = el('div', { class: 'b-cab' });
    const titulo = el('span', { class: 'b-titulo' });
    titulo.append(el('i', { class: 'muestra' }), document.createTextNode(def.nombre));
    cab.append(titulo, el('span', { class: 'b-sub dato', title: 'Imagen del contenedor' }, def.imagen));
    const fService = el('div', { class: 'b-fila' });
    fService.append(el('span', { class: 'etq' }, 'Service'), el('span', { id: `s${k}-balanceo` }), el('span', { class: 'val', id: `s${k}-tiempo`, title: 'Tiempo medio de servicio por réplica' }));
    const fCola = el('div', { class: 'b-fila' });
    const puntos = el('span', { class: 'cola-puntos', id: `s${k}-cola` });
    for (let j = 0; j < 12; j++) puntos.append(el('i'));
    fCola.append(el('span', { class: 'etq' }, 'En cola'), puntos, el('span', { class: 'val', id: `s${k}-cola-n` }, '0'));
    const fPods = el('div', { class: 'b-fila' });
    fPods.append(el('span', { class: 'etq' }, 'Pods'), el('span', { class: 'pods', id: `s${k}-pods` }));
    const fRep = el('div', { class: 'b-fila' });
    const pasos = el('span', { class: 'pasos' });
    const menos = el('button', { type: 'button', id: `s${k}-menos`, 'aria-label': `Quitar una réplica de ${def.nombre}` }, '−');
    const mas = el('button', { type: 'button', id: `s${k}-mas`, 'aria-label': `Agregar una réplica a ${def.nombre}` }, '+');
    menos.addEventListener('click', () => cambiarReplicas(k, -1));
    mas.addEventListener('click', () => cambiarReplicas(k, 1));
    pasos.append(menos, el('output', { id: `s${k}-replicas`, for: `s${k}-menos s${k}-mas` }, '1'), mas);
    fRep.append(el('span', { class: 'etq' }, 'Réplicas'), pasos, el('span', { class: 'val tenue', id: `s${k}-reserva`, title: 'Lo que reserva cada réplica en el nodo (requests)' }));
    b.append(cab, fService, fCola, fPods, fRep);

    const info = el('div', { class: 'bloque b-info', id: `b-i${k}`, style: `--color:${colorDe(k)}` });
    colocar(info, { ...caja, y: TAB.info.y, h: TAB.info.h });
    const cabInfo = el('div', { class: 'b-cab' });
    cabInfo.append(el('span', { class: 'b-titulo' }, 'Métricas'), el('span', { class: 'b-sub' }, `${def.nombre} · últimos ${VENTANA} s`));
    const medidor = el('div', { class: 'medidor', id: `i${k}-medidor`, 'data-nivel': 'normal' });
    const pista = el('div', { class: 'medidor-pista' });
    pista.append(el('div', { class: 'medidor-relleno', id: `i${k}-relleno` }));
    medidor.append(pista);
    const filaRho = el('div', { class: 'info-rho' });
    filaRho.append(el('span', { class: 'etq' }, 'Factor de utilización ρ'), el('strong', { id: `i${k}-rho` }, '—'));
    const rejilla = el('div', { class: 'rejilla-info' });
    for (const [clave, etiqueta] of [['cpu', 'CPU / request'], ['est', 'Estancia media'], ['tasa', 'Atendidas']]) {
      const celda = el('div');
      celda.append(el('span', { class: 'etq' }, etiqueta), el('strong', { id: `i${k}-${clave}` }, '—'));
      rejilla.append(celda);
    }
    info.append(cabInfo, filaRho, medidor, rejilla);
    zona.append(b, info);

    const col = el('div', { class: 'hpa-col', style: `--color:${colorDe(k)}` });
    col.append(el('div', { class: 'hpa-formula', id: `h${k}-formula` }), el('div', { class: 'hpa-pide', id: `h${k}-pide` }), el('div', { class: 'hpa-estado', id: `h${k}-estado` }));
    cols.append(col);
  });

  // Cables
  const svg = $('cables');
  svg.setAttribute('width', TAB.ancho);
  svg.setAttribute('height', TAB.alto);
  svg.setAttribute('viewBox', `0 0 ${TAB.ancho} ${TAB.alto}`);
  const y = TAB.yEje;
  const flechaH = (xa, xb) => `<path class="cable" d="M${xa} ${y}H${xb - 8}"/><path class="punta" d="M${xb} ${y}l-9 -4.5v9z"/>`;
  const flechaV = (x, ya, yb) => `<path class="cable" d="M${x} ${ya}V${yb - 8}"/><path class="punta" d="M${x} ${yb}l-4.5 -9h9z"/>`;
  let s = '';
  tramosCable = [];
  const cajas = esc.servicios.map((_, k) => cajaServicio(k, n));
  const xs = [TAB.llegadas.x + TAB.llegadas.w, ...cajas.flatMap((c) => [c.x, c.x + c.w]), TAB.salida.x];
  for (let j = 0; j < xs.length; j += 2) {
    s += flechaH(xs[j], xs[j + 1]);
    tramosCable.push({ xa: xs[j], xb: xs[j + 1] - 8 });
  }
  cajas.forEach((c) => {
    const x = c.x + c.w / 2;
    s += `<path class="cable tenue" d="M${x} ${TAB.nodo.y + TAB.nodo.h}V${TAB.servicio.y}"/>`;
    s += `<circle class="puerto" cx="${x}" cy="${TAB.nodo.y + TAB.nodo.h}" r="3"/><circle class="puerto" cx="${x}" cy="${TAB.servicio.y}" r="3"/>`;
    s += `<text x="${x + 8}" y="${(TAB.nodo.y + TAB.nodo.h + TAB.servicio.y) / 2 + 4}">corre en el nodo</text>`;
    s += flechaV(x, TAB.servicio.y + TAB.servicio.h, TAB.info.y);
    s += `<text x="${x + 8}" y="${(TAB.servicio.y + TAB.servicio.h + TAB.info.y) / 2 + 4}">mide</text>`;
    s += flechaV(x, TAB.info.y + TAB.info.h, TAB.hpa.y);
    s += `<text x="${x + 8}" y="${(TAB.info.y + TAB.info.h + TAB.hpa.y) / 2 + 4}">métricas al HPA</text>`;
  });
  s += '<g id="capa-fichas"></g>';
  svg.innerHTML = s;
  fichas = [];
  ajustarEscala();
}

function ajustarEscala() {
  const disponible = $('lienzo').clientWidth || TAB.ancho;
  const k = Math.max(0.8, Math.min(1, disponible / TAB.ancho));
  const tablero = $('tablero');
  tablero.style.transform = k < 1 ? `scale(${k})` : '';
  tablero.style.marginRight = `${-(1 - k) * TAB.ancho}px`;
  tablero.style.marginBottom = `${-(1 - k) * TAB.alto}px`;
}

// Fichas: puntos que cruzan los cables cuando una petición cambia de bloque ------
function limpiarFichas() {
  for (const f of fichas) f.nodo.remove();
  fichas = [];
}
function lanzarFicha(tramo) {
  const capa = $('capa-fichas');
  const c = tramosCable[tramo];
  if (!capa || !c || fichas.length >= 48) return;
  const nodo = document.createElementNS(NS_SVG, 'circle');
  nodo.setAttribute('class', 'ficha');
  nodo.setAttribute('r', 4);
  nodo.setAttribute('cy', TAB.yEje);
  nodo.setAttribute('cx', c.xa);
  capa.append(nodo);
  fichas.push({ nodo, xa: c.xa, xb: c.xb, edad: 0 });
}
function animarNovedad(nov) {
  if (nov.tipo === 'llega') lanzarFicha(0);
  else if (nov.tipo === 'salto' || nov.tipo === 'completa') lanzarFicha(nov.de + 1);
}
function moverFichas(dt) {
  const DURACION = 240;
  fichas = fichas.filter((f) => {
    f.edad += dt;
    if (f.edad >= DURACION) { f.nodo.remove(); return false; }
    f.nodo.setAttribute('cx', (f.xa + (f.xb - f.xa) * (f.edad / DURACION)).toFixed(1));
    return true;
  });
}

// ---------------------------------------------------------------------------
// Tablero: lo que cambia con cada escenario y con cada cuadro
// ---------------------------------------------------------------------------
function pintarEstatico() {
  $('ll-dist').textContent = resumenDistribucion(esc.llegadas);
  $('nodo-titulo').textContent = `Nodo · ${esc.nodo.nombre}`;
  $('hpa-modo').value = esc.hpa.modo;
  esc.servicios.forEach((def, k) => {
    const s = modelo.servicios[k];
    $(`s${k}-balanceo`).textContent = { aleatorio: 'reparto aleatorio', turnos: 'reparto por turnos', 'menos-ocupada': 'a la menos ocupada', compartida: 'cola compartida' }[esc.balanceo];
    $(`s${k}-tiempo`).textContent = `${corto(s.dist.media / s.demanda)} ms`;
    $(`s${k}-reserva`).textContent = `${def.cpuRequest}m · ${def.ramRequest}Mi`;
  });
  const hay = teoria.aplica;
  $('teoria-nombre').textContent = hay ? teoria.nombre : 'Sin fórmula cerrada para este escenario';
  const ley = $('leyenda-trazas');
  ley.replaceChildren();
  const item = (clase, texto) => { const sp = el('span'); sp.append(el('i', { class: clase }), document.createTextNode(texto)); return sp; };
  ley.append(item('espera', 'espera en cola'), item('', 'servicio'), item('red', 'red entre servicios'));
}

/** Resumen de las últimas muestras de un servicio (lo que muestran los bloques de métricas). */
function resumenVentana(k) {
  const serie = modelo.serie;
  const s = modelo.servicios[k];
  const desde = Math.max(0, serie.length - VENTANA);
  let ocup = 0, listas = 0, cpu = 0, comp = 0, est = 0, n = 0;
  for (let j = desde; j < serie.length; j++) {
    const m = serie[j].s[k];
    ocup += m.ocupacion; listas += m.listas; cpu += m.cpu; comp += m.completadas;
    if (m.completadas) est += m.estancia * m.completadas;
    n++;
  }
  if (n === 0) return { rho: s.listas.length ? s.ocupadas / s.listas.length : NaN, usoRequest: NaN, cpu: s.tasaCPU, estancia: NaN, tasa: NaN };
  return { rho: ocup / listas, usoRequest: cpu / (listas * s.peso), cpu: cpu / n, estancia: comp ? est / comp : NaN, tasa: comp / n };
}

function pintarTablero() {
  const t = relojVisual;
  const factor = modelo.factorTrafico(t);
  $('ll-tasa').textContent = `λ = ${corto((1000 / modelo.distLlegadas.media) * factor)} pet/s${factor !== 1 ? ` (pico ×${corto(factor)})` : ''}`;
  $('ll-cuenta').textContent = `generadas: ${entero(modelo.llegadas)}`;
  $('sal-cuenta').textContent = entero(modelo.completadas);

  modelo.servicios.forEach((s, k) => {
    const puntos = $(`s${k}-cola`).children;
    for (let j = 0; j < puntos.length; j++) puntos[j].classList.toggle('lleno', j < s.enCola);
    $(`s${k}-cola-n`).textContent = entero(s.enCola);
    const pods = $(`s${k}-pods`);
    pods.replaceChildren();
    const MAXIMO = 6;
    const pendientes = modelo.pendientes.filter((x) => x === s).length;
    const todos = s.replicas.map((r) => ({ r })).concat(Array.from({ length: pendientes }, () => ({ pendiente: true })));
    todos.slice(0, MAXIMO).forEach((x) => {
      if (x.pendiente) {
        pods.append(el('span', { class: 'pod pendiente', title: 'Pending: no cabe en el nodo' }, '!'));
        return;
      }
      const r = x.r;
      const clases = ['pod'];
      let texto = r.cola.length ? (r.cola.length > 99 ? '99+' : String(r.cola.length)) : '';
      let estado = r.enServicio ? 'atendiendo' : 'libre';
      if (r.estado === 'arrancando') { clases.push('arrancando'); texto = '…'; estado = 'arrancando'; }
      else {
        if (r.enServicio) clases.push('ocupada');
        if (r.estado === 'terminando') { clases.push('terminando'); estado = 'apagándose'; }
      }
      pods.append(el('span', { class: clases.join(' '), title: `${r.nombre}: ${estado}${r.cola.length ? `, ${r.cola.length} en su cola` : ''}` }, texto));
    });
    if (todos.length > MAXIMO) pods.append(el('span', { class: 'tenue' }, `+${todos.length - MAXIMO}`));
    $(`s${k}-replicas`).textContent = String(modelo.deseadas(s));
    const mas = $(`s${k}-mas`);
    const cabe = modelo.cabe(s);
    mas.disabled = modelo.terminado || !cabe;
    mas.title = cabe ? '' : 'No cabe otra réplica en el nodo';
    $(`s${k}-menos`).disabled = modelo.terminado || modelo.deseadas(s) <= 1;
  });

  pintarNodo();
  pintarHPA();
}

function pintarNodo() {
  const nd = modelo.nodo;
  const pend = modelo.pendientes.length;
  const ubicados = modelo.servicios.reduce((suma, s) => suma + s.replicas.length, 0);
  $('nodo-pods').textContent = `${plural(ubicados, 'pod ubicado', 'pods ubicados')}${pend ? ` · ${entero(pend)} Pending` : ''}`;
  const tramos = (idPista, valorDe, capacidad) => {
    const pista = $(idPista);
    pista.replaceChildren();
    modelo.servicios.forEach((s, k) => {
      const ancho = (valorDe(s, k) / capacidad) * 100;
      if (ancho > 0.05) pista.append(el('div', { class: 'tramo', style: `--color:${colorDe(k)};width:calc(${Math.min(100, ancho).toFixed(2)}% - 2px)`, title: s.def.nombre }));
    });
  };
  tramos('nodo-cpu-pista', (s) => s.replicas.length * s.def.cpuRequest, nd.cpu);
  tramos('nodo-ram-pista', (s) => s.replicas.length * s.def.ramRequest, nd.ram);
  $('nodo-cpu-texto').textContent = `${entero(nd.cpuAsignada)} de ${entero(nd.cpu)} m · libres ${entero(nd.cpu - nd.cpuAsignada)} m`;
  $('nodo-ram-texto').textContent = `${entero(nd.ramAsignada)} de ${entero(nd.ram)} Mi · libres ${entero(nd.ram - nd.ramAsignada)} Mi`;
  const usos = modelo.servicios.map((_, k) => resumenVentana(k).cpu);
  tramos('nodo-uso-pista', (s, k) => usos[k] * 1000, nd.cpu);
  const usoTotal = usos.reduce((a, b) => a + b, 0);
  const saturada = usoTotal >= (nd.cpu / 1000) * 0.98;
  $('nodo-uso-texto').textContent = `${num(usoTotal, 2)} de ${corto(nd.cpu / 1000)} núcleos${saturada ? ' · saturada: todos se frenan' : ''}`;
  $('rec-uso').classList.toggle('saturada', saturada);

  const sinCupo = modelo.servicios.filter((s) => !modelo.cabe(s));
  const bloque = $('b-nodo');
  const agotado = pend > 0 || sinCupo.length === modelo.servicios.length;
  bloque.classList.toggle('agotado', agotado);
  bloque.classList.toggle('justo', !agotado && sinCupo.length > 0);
  $('rec-cpu').classList.toggle('lleno', modelo.servicios.some((s) => nd.cpuAsignada + s.def.cpuRequest > nd.cpu));
  $('rec-ram').classList.toggle('lleno', modelo.servicios.some((s) => nd.ramAsignada + s.def.ramRequest > nd.ram));
  let aviso = '';
  if (pend > 0) aviso = `✕ Sin cupo: ${plural(pend, 'pod Pending', 'pods Pending')}`;
  else if (agotado) aviso = '✕ Agotado: no cabe otra réplica';
  else if (sinCupo.length) aviso = `Ya no cabe otra réplica de ${sinCupo.map((s) => s.def.nombre).join(' ni de ')}`;
  $('nodo-aviso').textContent = aviso;
}

function pintarHPA() {
  const h = modelo.esc.hpa;
  const sel = $('hpa-modo');
  if (document.activeElement !== sel) sel.value = h.modo;
  let ciclo = `cada ${corto(h.periodo / 1000)} s · objetivo ${num(h.objetivo * 100, 0)} % del request · de ${h.min} a ${h.max} réplicas`;
  if (h.modo === 'apagado') ciclo = 'apagado: no observa ni escala';
  else if (!modelo.terminado) {
    const prox = modelo.sim.lista.ordenados().find((ev) => ev.tipo === 'hpa');
    if (prox) ciclo += ` · revisa en ${num(Math.max(0, prox.t - relojVisual) / 1000, 0)} s`;
  }
  $('hpa-ciclo').textContent = ciclo;
  modelo.servicios.forEach((s, k) => {
    const d = s.hpa;
    const formula = $(`h${k}-formula`);
    const pide = $(`h${k}-pide`);
    const estado = $(`h${k}-estado`);
    pide.className = 'hpa-pide';
    estado.className = 'hpa-estado';
    pide.replaceChildren();
    if (h.modo === 'apagado') {
      formula.textContent = '';
      pide.textContent = 'Sin autoescalado';
      estado.textContent = `${plural(s.listas.length, 'réplica fija', 'réplicas fijas')}`;
      return;
    }
    if (!d) {
      formula.textContent = '⌈réplicas × uso / objetivo⌉';
      pide.textContent = 'Esperando la primera revisión';
      estado.textContent = '';
      return;
    }
    formula.textContent = `⌈${d.listas} × ${num(d.uso * 100, 0)} % / ${num(h.objetivo * 100, 0)} %⌉ = ${d.cruda}`;
    const aplica = h.modo === 'aplicar';
    if (d.extra > 0) {
      pide.classList.add('sube');
      pide.append(el('strong', {}, `${aplica ? 'Pidió' : 'Faltan'} +${plural(d.extra, 'réplica', 'réplicas')}`), document.createTextNode(` · de ${d.actuales} a ${d.deseadas}`));
    } else if (d.extra < 0) {
      pide.append(el('strong', {}, `${aplica ? 'Retiró' : 'Sobran'} ${plural(-d.extra, 'réplica', 'réplicas')}`), document.createTextNode(` · de ${d.actuales} a ${d.deseadas}`));
    } else {
      pide.append(el('strong', {}, 'Sin cambios'), document.createTextNode(` · se queda en ${d.actuales}`));
    }
    const pend = modelo.pendientes.filter((x) => x === s).length;
    const arrancando = s.replicas.filter((r) => r.estado === 'arrancando').length;
    if (pend > 0) {
      estado.classList.add('sin-cupo');
      estado.textContent = `${plural(pend, 'pod Pending', 'pods Pending')}: no cabe en el nodo`;
    } else if (arrancando > 0) {
      estado.textContent = `${plural(arrancando, 'pod arrancando', 'pods arrancando')} (${corto(esc.arranquePod / 1000)} s de arranque en frío)`;
    } else if (d.frenada) {
      estado.textContent = `podría bajar a ${d.cruda}; espera la ventana de estabilización`;
    } else if (!aplica && d.extra !== 0) {
      estado.textContent = 'solo recomienda; no escala';
    } else {
      estado.textContent = `${plural(s.listas.length, 'réplica lista', 'réplicas listas')}`;
    }
  });
}

function pintarInfo() {
  modelo.servicios.forEach((_, k) => {
    const v = resumenVentana(k);
    $(`i${k}-rho`).textContent = pct(v.rho, 0);
    $(`i${k}-cpu`).textContent = pct(v.usoRequest, 0);
    $(`i${k}-est`).textContent = Number.isFinite(v.estancia) ? `${adapt(v.estancia)} ms` : '—';
    $(`i${k}-tasa`).textContent = Number.isFinite(v.tasa) ? `${num(v.tasa, 1)}/s` : '—';
    $(`i${k}-relleno`).style.width = `${Math.max(0, Math.min(1, v.rho || 0)) * 100}%`;
    $(`i${k}-medidor`).dataset.nivel = v.rho >= 0.98 ? 'critico' : v.rho >= 0.85 ? 'alerta' : 'normal';
  });
}

function pintarReloj() {
  $('reloj-valor').textContent = seg(relojVisual, 1);
  $('avance-horizonte').style.width = `${Math.min(100, (relojVisual / esc.horizonte) * 100)}%`;
  $('reloj-detalle').textContent = `${entero(modelo.sim.eventosEjecutados)} eventos · duración ${corto(esc.horizonte / 1000)} s${modelo.terminado ? ' · terminó' : ''}`;
  const ocupado = rapido || metaTramo !== null;
  $('btn-correr').textContent = corriendo ? 'Pausar' : 'Correr';
  $('btn-correr').disabled = modelo.terminado || ocupado;
  $('btn-tramo').disabled = modelo.terminado || ocupado;
  $('btn-final').disabled = modelo.terminado || ocupado;
}

// ---------------------------------------------------------------------------
// Observabilidad: cifras, franjas de métricas, logs y trazas
// ---------------------------------------------------------------------------
function pintarCifras() {
  resultados = modelo.resultados();
  const r = resultados;
  const listas = r.servicios.reduce((a, s) => a + s.listas, 0);
  const deseadas = r.servicios.reduce((a, s) => a + s.deseadas, 0);
  const usoNodo = modelo.servicios.reduce((a, _, k) => a + resumenVentana(k).cpu, 0);
  const cifras = [
    ['Latencia media', Number.isFinite(r.W) ? `${adapt(r.W)} ms` : '—', `extremo a extremo · ${entero(r.n)} peticiones`],
    ['Latencia p95', Number.isFinite(r.p95) ? `${adapt(r.p95)} ms` : '—', `p99 ${Number.isFinite(r.p99) ? `${adapt(r.p99)} ms` : '—'}`],
    ['Rendimiento', Number.isFinite(r.X) ? `${num(r.X * 1000, 1)} pet/s` : '—', `llegan ${Number.isFinite(r.lambdaObservada) ? num(r.lambdaObservada * 1000, 1) : '—'} pet/s`],
    ['En el sistema', entero(r.enSistema), 'peticiones sin terminar'],
    ['Réplicas listas', entero(listas), deseadas !== listas ? `${entero(deseadas)} deseadas` : 'igual a las deseadas'],
    ['CPU del nodo en uso', pct(usoNodo / (modelo.nodo.cpu / 1000), 0), `reservada ${pct(modelo.nodo.cpuAsignada / modelo.nodo.cpu, 0)}`],
    ['Costo acumulado', `${num(r.replicaSegundos / 60, 1)}`, 'réplica-minutos'],
  ];
  const cont = $('cifras');
  cont.replaceChildren();
  for (const [etiqueta, valor, detalle] of cifras) {
    const d = el('div');
    d.append(el('span', { class: 'etiqueta' }, etiqueta), el('div', { class: 'valor' }, valor), el('span', { class: 'detalle' }, detalle));
    cont.append(d);
  }
}

/** Gráfico de franjas: una fila por serie, todas con el mismo eje de tiempo. */
class Franjas {
  constructor(id) {
    this.raiz = $(id);
    this.svg = this.raiz.querySelector('svg');
    this.globo = this.raiz.querySelector('.globo');
    this.puntero = null;
    this.datos = null;
    this.raiz.addEventListener('pointermove', (e) => { this.puntero = e.clientX - this.svg.getBoundingClientRect().left; this.resaltar(); });
    this.raiz.addEventListener('pointerleave', () => { this.puntero = null; this.resaltar(); });
  }

  /** def = { t: [s], franjas: [{ nombre, color, valores, fmt, escalon, minMax }], yComun, ref: { valor, texto } } */
  dibujar(def) {
    const ancho = Math.max(260, this.raiz.clientWidth || 440);
    const ALTO_FRANJA = 44;
    const ROTULO = 16;
    const SEPARA = 10;
    const mIzq = 4;
    const mDer = 4;
    const alto = def.franjas.length * (ROTULO + ALTO_FRANJA + SEPARA) + 26;
    this.svg.setAttribute('viewBox', `0 0 ${ancho} ${alto}`);
    this.svg.setAttribute('height', alto);
    if (def.t.length < 2) {
      this.svg.innerHTML = `<text class="vacio" x="${ancho / 2}" y="${alto / 2}" text-anchor="middle">Aún no hay muestras. Pulsa Correr.</text>`;
      this.datos = null;
      this.globo.hidden = true;
      return;
    }
    // Con muchas muestras se promedian por tramos para no dibujar miles de puntos.
    const N = def.t.length;
    const grupo = Math.max(1, Math.ceil(N / 420));
    const reducir = (v, escalon) => {
      if (grupo === 1) return v;
      const out = [];
      for (let i = 0; i < N; i += grupo) {
        let suma = 0, n = 0, maximo = -Infinity;
        for (let j = i; j < Math.min(N, i + grupo); j++) if (Number.isFinite(v[j])) { suma += v[j]; n++; if (v[j] > maximo) maximo = v[j]; }
        out.push(n ? (escalon ? maximo : suma / n) : NaN);
      }
      return out;
    };
    const t = grupo === 1 ? def.t : def.t.filter((_, i) => i % grupo === grupo - 1 || i === N - 1).slice(0, Math.ceil(N / grupo));
    const series = def.franjas.map((f) => ({ ...f, v: reducir(f.valores, f.escalon) }));
    const tMax = Math.max(60, def.t[N - 1]);
    const px = (x) => mIzq + (x / tMax) * (ancho - mIzq - mDer);
    const maximoDe = (f) => Math.max(f.minMax || 0, ...f.v.filter(Number.isFinite), def.ref ? def.ref.valor * 1.15 : 0);
    const comun = def.yComun ? Math.max(...series.map(maximoDe)) : null;
    let s = '';
    series.forEach((f, k) => {
      const y0 = k * (ROTULO + ALTO_FRANJA + SEPARA) + ROTULO + ALTO_FRANJA;
      const yMax = (comun ?? maximoDe(f)) || 1;
      const py = (v) => y0 - (Math.min(v, yMax) / yMax) * ALTO_FRANJA;
      f.py = py;
      const actual = f.valores[N - 1];
      s += `<rect x="${mIzq}" y="${y0 - ALTO_FRANJA - ROTULO + 4}" width="9" height="9" rx="2" style="fill:${f.color}"/>`;
      s += `<text class="nombre" x="${mIzq + 14}" y="${y0 - ALTO_FRANJA - 4}">${f.nombre}</text>`;
      s += `<text class="actual" x="${ancho - mDer}" y="${y0 - ALTO_FRANJA - 4}" text-anchor="end">ahora ${f.fmt(actual)} · tope ${f.fmt(yMax)}</text>`;
      s += `<line class="tope" x1="${mIzq}" x2="${ancho - mDer}" y1="${y0 - ALTO_FRANJA}" y2="${y0 - ALTO_FRANJA}"/>`;
      let d = '';
      let abierto = false;
      let ultX = 0;
      let primX = 0;
      f.v.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = px(t[i]);
        const y = py(v);
        if (!abierto) { d += `M${x.toFixed(1)} ${y.toFixed(1)}`; abierto = true; primX = x; }
        else d += f.escalon ? `H${x.toFixed(1)}V${y.toFixed(1)}` : `L${x.toFixed(1)} ${y.toFixed(1)}`;
        ultX = x;
      });
      if (abierto) {
        s += `<path class="area" style="fill:${f.color}" d="${d}V${y0}H${primX.toFixed(1)}Z"/>`;
        s += `<path class="linea" style="stroke:${f.color}" d="${d}"/>`;
      }
      if (def.ref && def.ref.valor <= yMax) {
        const yr = py(def.ref.valor);
        s += `<line class="ref" x1="${mIzq}" x2="${ancho - mDer}" y1="${yr}" y2="${yr}"/>`;
        if (k === 0) s += `<text x="${mIzq + 2}" y="${yr - 3}">${def.ref.texto}</text>`;
      }
      s += `<line class="base" x1="${mIzq}" x2="${ancho - mDer}" y1="${y0}" y2="${y0}"/>`;
      f.y0 = y0;
    });
    const yEje = alto - 26;
    const marcas = marcasEje(0, tMax, Math.max(2, Math.floor(ancho / 80)));
    for (const v of marcas.valores) {
      const ancla = v === 0 ? 'start' : px(v) > ancho - 16 ? 'end' : 'middle';
      s += `<text x="${px(v)}" y="${yEje + 6}" text-anchor="${ancla}">${etiquetaEje(v, marcas.paso)}</text>`;
    }
    s += `<text class="titulo-eje" x="${ancho / 2}" y="${alto - 4}" text-anchor="middle">tiempo simulado (s)</text>`;
    s += `<line class="cruz" data-cruz x1="0" x2="0" y1="0" y2="${yEje - 10}" visibility="hidden"/>`;
    this.svg.innerHTML = s;
    this.datos = { t, series, px, ancho };
    this.resaltar();
  }

  resaltar() {
    const cruz = this.svg.querySelector('[data-cruz]');
    if (this.puntero === null || !this.datos || !cruz) {
      this.globo.hidden = true;
      if (cruz) cruz.setAttribute('visibility', 'hidden');
      return;
    }
    const { t, series, px, ancho } = this.datos;
    const escala = ancho / (this.svg.getBoundingClientRect().width || ancho);
    const x = this.puntero * escala;
    let i = 0;
    for (let j = 1; j < t.length; j++) if (Math.abs(px(t[j]) - x) < Math.abs(px(t[i]) - x)) i = j;
    cruz.setAttribute('x1', px(t[i]));
    cruz.setAttribute('x2', px(t[i]));
    cruz.setAttribute('visibility', 'visible');
    this.globo.replaceChildren(el('div', {}, `t = ${num(t[i], 0)} s`));
    for (const f of series) {
      const fila = el('div');
      fila.append(el('span', { class: 'clave c', style: `--color:${f.color}` }), el('strong', {}, f.fmt(f.v[i])), document.createTextNode(` ${f.nombre}`));
      this.globo.append(fila);
    }
    this.globo.hidden = false;
    const mitad = this.globo.offsetWidth / 2;
    this.globo.style.left = `${Math.max(mitad, Math.min(this.raiz.clientWidth - mitad, px(t[i]) / escala))}px`;
    this.globo.style.top = '14px';
  }
}

let fCpu, fRep, fCola, fLat;

function pintarGraficos() {
  const serie = modelo.serie;
  const t = serie.map((m) => m.t / 1000);
  const porServicio = (campo, extra) => modelo.servicios.map((s, k) => ({
    nombre: s.def.nombre,
    color: colorDe(k),
    valores: serie.map((m) => m.s[k][campo]),
    ...extra,
  }));
  const fPct = (v) => (Number.isFinite(v) ? `${num(v * 100, 0)} %` : '—');
  const fEnt = (v) => (Number.isFinite(v) ? entero(v) : '—');
  fCpu.dibujar({ t, franjas: porServicio('usoRequest', { fmt: fPct, minMax: 1 }), yComun: true, ref: { valor: esc.hpa.objetivo, texto: `objetivo ${num(esc.hpa.objetivo * 100, 0)} %` } });
  fRep.dibujar({ t, franjas: porServicio('listas', { fmt: fEnt, escalon: true, minMax: 2 }), yComun: true });
  fCola.dibujar({ t, franjas: porServicio('cola', { fmt: fEnt, minMax: 5 }) });
  fLat.dibujar({
    t,
    franjas: [
      { nombre: 'Latencia media de las peticiones completadas', color: 'var(--tinta-2)', valores: serie.map((m) => m.latencia), fmt: (v) => (Number.isFinite(v) ? `${adapt(v)} ms` : '—'), minMax: 50 },
      { nombre: 'Peticiones completadas por segundo', color: 'var(--tinta-2)', valores: serie.map((m) => m.completadas), fmt: fEnt, minMax: 10 },
    ],
  });
}

const FILTROS = { control: 'HPA y orquestador', peticiones: 'Peticiones', todo: 'Todo' };

function pintarLogs() {
  const pre = $('registro');
  let lineas;
  if (filtroLog === 'control') lineas = logControl.slice(-160);
  else if (filtroLog === 'peticiones') lineas = logPeticiones.slice(-160);
  else lineas = logControl.slice(-120).concat(logPeticiones.slice(-80)).sort((a, b) => a.t - b.t);
  pre.replaceChildren();
  if (lineas.length === 0) {
    pre.textContent = 'Sin registros todavía.';
    return;
  }
  for (let i = lineas.length - 1; i >= 0; i--) {
    const l = lineas[i];
    const fila = el('div', l.aviso ? { class: 'aviso-log' } : {});
    fila.append(el('span', { class: 't' }, `${marcaTiempo(l.t)}  `), el('span', {}, `${l.aviso ? 'AVISO' : 'INFO '}  `), el('span', { class: 'origen' }, `${l.origen.padEnd(13)} `), document.createTextNode(l.texto));
    pre.append(fila);
  }
}

function pintarTrazas() {
  const cuerpo = $('tabla-trazas');
  cuerpo.replaceChildren();
  const ultimas = modelo.trazas.slice(-9).reverse();
  if (ultimas.length === 0) {
    const tr = el('tr');
    tr.append(el('td', { colspan: 4, class: 'tenue' }, 'Aún no ha terminado ninguna petición.'));
    cuerpo.append(tr);
    return;
  }
  const maximo = Math.max(...ultimas.map((p) => p.tFin - p.tLlegada));
  for (const p of ultimas) {
    const total = p.tFin - p.tLlegada;
    const barra = el('div', { class: 'traza-barra', role: 'img', 'aria-label': `Recorrido de la traza ${p.id}` });
    const tramo = (clase, dur, k, titulo) => {
      if (dur <= 0) return;
      const sp = el('span', { class: clase, title: titulo, style: `width:${((dur / maximo) * 100).toFixed(3)}%${k !== null ? `;--color:${colorDe(k)}` : ''}` });
      barra.append(sp);
    };
    let cursor = p.tLlegada;
    const partes = [];
    p.tramos.forEach((x) => {
      const nombre = modelo.servicios[x.i].def.nombre;
      tramo('red', x.tEntrada - cursor, null, `Red: ${adapt(x.tEntrada - cursor)} ms`);
      tramo('espera', x.tInicio - x.tEntrada, x.i, `${nombre} (${x.pod}): espera ${adapt(x.tInicio - x.tEntrada)} ms`);
      tramo('', x.tFin - x.tInicio, x.i, `${nombre} (${x.pod}): servicio ${adapt(x.tFin - x.tInicio)} ms`);
      partes.push(`${x.pod} ${adapt(x.tFin - x.tEntrada)}`);
      cursor = x.tFin;
    });
    const celda = el('td', { class: 'barra' });
    celda.append(barra);
    const tr = el('tr');
    tr.append(el('td', { class: 'num' }, String(p.id).padStart(6, '0')), el('td', { class: 'num' }, adapt(total)), celda, el('td', { class: 'dato' }, partes.join(' · ')));
    cuerpo.append(tr);
  }
}

// ---------------------------------------------------------------------------
// Teoría y verificación
// ---------------------------------------------------------------------------
function celdaDiferencia(sim, teo) {
  const td = el('td', { class: 'num' });
  if (!Number.isFinite(sim) || !Number.isFinite(teo) || Math.abs(teo) < 1e-12) { td.textContent = '—'; return td; }
  const d = (sim - teo) / teo;
  const caja = el('span', { class: 'dif' });
  caja.append(el('span', {}, `${d > 0 ? '+' : ''}${num(d * 100, 1)} %`));
  if (Math.abs(d) <= 0.05) caja.append(el('span', { class: 'ok', title: 'A menos del 5 % de la teoría' }, '✓'));
  td.append(caja);
  return td;
}

function pintarTeoria() {
  const r = resultados || modelo.resultados();
  const intervenida = r.intervenciones > 0;
  const hay = teoria.aplica && !intervenida;
  const nota = $('teoria-nota');
  nota.hidden = hay;
  nota.textContent = hay ? '' : intervenida
    ? 'Hubo cambios manuales durante la corrida, así que no hay un estado estable único con el cual comparar.'
    : `${teoria.motivo} En este caso la simulación es la herramienta: no hay fórmula que la reemplace.`;
  const cuerpo = $('tabla-teoria');
  cuerpo.replaceChildren();
  const ms = (x) => (Number.isFinite(x) ? `${adapt(x)} ms` : '—');
  r.servicios.forEach((s, k) => {
    const teo = hay ? teoria.servicios[k] : null;
    const nombre = el('td');
    const etiqueta = el('span', { class: 'nombre-servicio', style: `--color:${colorDe(k)}` });
    etiqueta.append(el('i', { class: 'muestra' }), document.createTextNode(s.nombre));
    nombre.append(etiqueta);
    const tr = el('tr');
    tr.append(nombre, el('td', { class: 'num' }, pct(s.rho)), el('td', { class: 'num' }, teo ? pct(teo.rho) : '—'),
      el('td', { class: 'num' }, ms(s.Wq)), el('td', { class: 'num' }, teo ? ms(teo.Wq) : '—'), celdaDiferencia(s.Wq, teo ? teo.Wq : NaN));
    cuerpo.append(tr);
  });
  const tr = el('tr');
  tr.append(el('td', {}, 'Latencia extremo a extremo'), el('td', { class: 'num' }, '—'), el('td', { class: 'num' }, '—'),
    el('td', { class: 'num' }, ms(r.W)), el('td', { class: 'num' }, hay ? ms(teoria.W) : '—'), celdaDiferencia(r.W, hay ? teoria.W : NaN));
  cuerpo.append(tr);
  $('teoria-pie').textContent = `Medido sobre ${entero(r.n)} peticiones en ${corto(r.duracionObservada / 1000)} s simulados. `
    + (hay ? 'Con pocas peticiones la diferencia es grande y baja al crecer la muestra; usa "Hasta el final" para comparar.' : '');

  const errorCPU = r.trabajo.entregado > 0 ? Math.abs(r.trabajo.entregado - r.trabajo.atendido) / r.trabajo.entregado : 0;
  const items = [
    ['Conservación de peticiones', r.conserva, `llegadas ${entero(r.llegadas)} = completadas ${entero(r.completadas)} + en el sistema ${entero(r.enSistema)}`],
    ['El reloj nunca retrocede', relojIntegro, `${entero(r.eventos)} eventos ejecutados en orden de tiempo`],
    ['El nodo nunca se sobreasigna', cupoIntegro, `reservados ${entero(r.nodo.cpuAsignada)} de ${entero(r.nodo.cpu)} m y ${entero(r.nodo.ramAsignada)} de ${entero(r.nodo.ram)} Mi`],
    ['La CPU entregada es la que recibieron las peticiones', errorCPU < 1e-6, `${num(r.trabajo.entregado / 1000, 1)} núcleos·s entregados; ${num(r.trabajo.atendido / 1000, 1)} recibidos`],
  ];
  const lista = $('verificaciones');
  lista.replaceChildren();
  for (const [titulo, ok, detalle] of items) {
    const li = el('li');
    const cuerpoLi = el('div');
    cuerpoLi.append(el('strong', {}, titulo), el('span', { class: 'detalle' }, detalle));
    li.append(el('span', { class: 'sello', 'data-estado': ok ? 'bien' : 'falla' }, ok ? '✓ Cumple' : '✕ Falla'), cuerpoLi);
    lista.append(li);
  }
  const li = el('li');
  const cuerpoLi = el('div');
  cuerpoLi.append(el('strong', {}, intervenida ? 'Corrida con cambios manuales' : 'Corrida reproducible'),
    el('span', { class: 'detalle' }, `semilla ${esc.semilla} · huella ${r.huella} tras ${entero(r.eventos)} eventos`
      + (intervenida ? ` · ${plural(r.intervenciones, 'cambio manual', 'cambios manuales')}: el JSON solo ya no la repite` : '')));
  li.append(el('span', { class: 'sello', 'data-estado': 'pendiente' }, 'Huella'), cuerpoLi);
  lista.append(li);
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
function mostrarError(id, mensaje) {
  for (const otro of ['config-error', 'json-error']) {
    $(otro).hidden = otro !== id || !mensaje;
    if (otro === id) $(otro).textContent = mensaje || '';
  }
}

let reconstruyendo = false; // al rehacer los formularios, el campo con foco dispara un "change" que hay que ignorar

function cambiarEscenario(mutar) {
  if (reconstruyendo) return;
  const copia = JSON.parse(JSON.stringify(esc));
  mutar(copia);
  copia.nombre = 'Personalizado';
  try {
    const nuevo = validarCadena(copia);
    mostrarError('', '');
    fijarEscenario(nuevo, 'propio');
  } catch (e) {
    mostrarError('config-error', e.message);
    $('config-error').scrollIntoView({ block: 'nearest' });
  }
}

function campoNumero(id, etiqueta, valor, alCambiar, { min = 0, step = 'any' } = {}) {
  const campo = el('div', { class: 'campo' });
  const entrada = el('input', { type: 'number', id, min, step });
  entrada.value = valor;
  entrada.addEventListener('change', () => alCambiar(Number(entrada.value)));
  campo.append(el('label', { for: id }, etiqueta), entrada);
  return campo;
}

let formulariosDist = [];

function pintarConfig() {
  const foco = document.activeElement && document.activeElement.id;
  const cont = $('config');
  reconstruyendo = true;
  try {
    cont.replaceChildren();
  } finally {
    reconstruyendo = false;
  }
  formulariosDist = [];
  const grupo = (titulo, k = null) => {
    const fs = el('fieldset', k !== null ? { class: 'de-servicio', style: `--color:${colorDe(k)}` } : {});
    const leyenda = el('legend');
    if (k !== null) leyenda.append(el('i', { class: 'muestra' }));
    leyenda.append(document.createTextNode(titulo));
    fs.append(leyenda);
    cont.append(fs);
    return fs;
  };

  // Llegadas
  const fsLl = grupo('Llegadas');
  const zonaLl = el('div');
  fsLl.append(zonaLl);
  formulariosDist.push(montarFormDist(zonaLl, { pref: 'll', espec: esc.llegadas, etiqueta: 'Tiempo entre llegadas', tasa: 'λ', alCambiar: (d) => cambiarEscenario((e) => { e.llegadas = d; }) }));
  const casilla = el('label', { class: 'casilla', for: 'pico-activo' });
  const marca = el('input', { type: 'checkbox', id: 'pico-activo' });
  marca.checked = esc.pico !== null;
  marca.addEventListener('change', () => cambiarEscenario((e) => { e.pico = marca.checked ? { desde: Math.round(e.horizonte / 3), hasta: Math.round((2 * e.horizonte) / 3), factor: 4 } : null; }));
  casilla.append(marca, document.createTextNode(' Pico de tráfico'));
  fsLl.append(casilla);
  if (esc.pico) {
    const c = el('div', { class: 'campos' });
    c.append(
      campoNumero('pico-desde', 'Desde (s)', esc.pico.desde / 1000, (v) => cambiarEscenario((e) => { e.pico.desde = v * 1000; })),
      campoNumero('pico-hasta', 'Hasta (s)', esc.pico.hasta / 1000, (v) => cambiarEscenario((e) => { e.pico.hasta = v * 1000; })),
      campoNumero('pico-factor', 'Multiplica λ por', esc.pico.factor, (v) => cambiarEscenario((e) => { e.pico.factor = v; })),
    );
    fsLl.append(c);
  }

  // Servicios
  esc.servicios.forEach((def, k) => {
    const fs = grupo(def.nombre, k);
    const zona = el('div');
    fs.append(zona);
    formulariosDist.push(montarFormDist(zona, { pref: `sv${k}`, espec: def.servicio, etiqueta: 'Tiempo de servicio con un núcleo', alCambiar: (d) => cambiarEscenario((e) => { e.servicios[k].servicio = d; }) }));
    const c = el('div', { class: 'campos' });
    c.append(
      campoNumero(`sv${k}-replicas`, 'Réplicas iniciales', def.replicas, (v) => cambiarEscenario((e) => { e.servicios[k].replicas = v; }), { min: 1, step: 1 }),
      campoNumero(`sv${k}-cpu`, 'CPU request (m)', def.cpuRequest, (v) => cambiarEscenario((e) => { e.servicios[k].cpuRequest = v; }), { min: 1, step: 50 }),
      campoNumero(`sv${k}-limite`, 'CPU limit (m)', def.cpuLimit, (v) => cambiarEscenario((e) => { e.servicios[k].cpuLimit = v; }), { min: 1, step: 50 }),
      campoNumero(`sv${k}-ram`, 'RAM request (Mi)', def.ramRequest, (v) => cambiarEscenario((e) => { e.servicios[k].ramRequest = v; }), { min: 0, step: 64 }),
    );
    fs.append(c);
    const d = crearDistribucion(def.servicio);
    const velocidad = Math.min(1, def.cpuLimit / 1000);
    fs.append(el('p', { class: 'resumen-dist' }, `con el limit: ${corto(d.media / velocidad)} ms por petición · cada réplica atiende hasta ${corto((1000 * velocidad) / d.media)} pet/s`));
  });

  // Nodo
  const fsNodo = grupo('Nodo');
  const cNodo = el('div', { class: 'campos' });
  cNodo.append(
    campoNumero('nodo-cpu', 'CPU (m)', esc.nodo.cpu, (v) => cambiarEscenario((e) => { e.nodo.cpu = v; }), { min: 1, step: 500 }),
    campoNumero('nodo-ram', 'RAM (Mi)', esc.nodo.ram, (v) => cambiarEscenario((e) => { e.nodo.ram = v; }), { min: 1, step: 512 }),
  );
  fsNodo.append(cNodo, el('p', { class: 'resumen-dist' }, `${corto(esc.nodo.cpu / 1000)} núcleos (1 núcleo = 1000 m) · ${corto(esc.nodo.ram / 1024)} Gi`));

  // HPA
  const fsHpa = grupo('HPA');
  const cHpa = el('div', { class: 'campos' });
  cHpa.append(
    campoNumero('hpa-objetivo', 'Objetivo de CPU (%)', esc.hpa.objetivo * 100, (v) => cambiarEscenario((e) => { e.hpa.objetivo = v / 100; }), { min: 1, step: 5 }),
    campoNumero('hpa-periodo', 'Revisa cada (s)', esc.hpa.periodo / 1000, (v) => cambiarEscenario((e) => { e.hpa.periodo = v * 1000; }), { min: 1 }),
    campoNumero('hpa-min', 'Mínimo', esc.hpa.min, (v) => cambiarEscenario((e) => { e.hpa.min = v; }), { min: 1, step: 1 }),
    campoNumero('hpa-max', 'Máximo', esc.hpa.max, (v) => cambiarEscenario((e) => { e.hpa.max = v; }), { min: 1, step: 1 }),
    campoNumero('hpa-tolerancia', 'Tolerancia (%)', esc.hpa.tolerancia * 100, (v) => cambiarEscenario((e) => { e.hpa.tolerancia = v / 100; }), { min: 0, step: 1 }),
    campoNumero('hpa-estabilizacion', 'Espera para reducir (s)', esc.hpa.estabilizacion / 1000, (v) => cambiarEscenario((e) => { e.hpa.estabilizacion = v * 1000; }), { min: 0, step: 30 }),
  );
  fsHpa.append(cHpa, el('p', { class: 'resumen-dist' }, 'deseadas = ⌈réplicas listas × uso / objetivo⌉'));

  // Orquestador, red y corrida
  const fsOrq = grupo('Balanceo, red y corrida');
  const campoBal = el('div', { class: 'campo ancho' });
  const selBal = el('select', { id: 'balanceo' });
  for (const [id, nombre] of Object.entries(BALANCEOS)) selBal.append(el('option', { value: id }, nombre));
  selBal.value = esc.balanceo;
  selBal.addEventListener('change', () => cambiarEscenario((e) => { e.balanceo = selBal.value; }));
  campoBal.append(el('label', { for: 'balanceo' }, 'Regla del balanceador'), selBal);
  const cOrq = el('div', { class: 'campos' });
  cOrq.append(
    campoBal,
    campoNumero('red', 'Red por salto (ms)', esc.redMs, (v) => cambiarEscenario((e) => { e.redMs = v; })),
    campoNumero('arranque', 'Arranque de pod (s)', esc.arranquePod / 1000, (v) => cambiarEscenario((e) => { e.arranquePod = v * 1000; })),
    campoNumero('horizonte', 'Duración (s)', esc.horizonte / 1000, (v) => cambiarEscenario((e) => { e.horizonte = v * 1000; })),
    campoNumero('calentamiento', 'Calentamiento (s)', esc.calentamiento / 1000, (v) => cambiarEscenario((e) => { e.calentamiento = v * 1000; })),
    campoNumero('semilla', 'Semilla', esc.semilla, (v) => cambiarEscenario((e) => { e.semilla = v; }), { min: 0, step: 1 }),
  );
  const otra = el('button', { type: 'button', id: 'btn-semilla' }, 'Otra semilla');
  otra.addEventListener('click', () => cambiarEscenario((e) => { e.semilla = 1 + Math.floor(Math.random() * 99999); }));
  fsOrq.append(cOrq, otra);

  if (foco && $(foco) && cont.contains($(foco))) $(foco).focus({ preventScroll: true });
}

function fijarEscenario(nuevo, idPreajuste) {
  const cambiaForma = !modelo || nuevo.servicios.length !== esc.servicios.length
    || nuevo.servicios.some((s, k) => s.nombre !== esc.servicios[k].nombre || s.imagen !== esc.servicios[k].imagen);
  esc = nuevo;
  $('preajuste').value = idPreajuste;
  $('json-texto').value = JSON.stringify(esc, null, 2);
  $('json-estado').textContent = '';
  if (cambiaForma) montarTablero();
  pintarConfig();
  reiniciar();
}

function pintarVelocidad() {
  const v = VELOCIDADES[Number($('velocidad').value)];
  $('velocidad-texto').textContent = `${corto(v)} s simulados por segundo`;
}

// ---------------------------------------------------------------------------
// Bucle de animación
// ---------------------------------------------------------------------------
let marcaPrevia = 0;

function cuadro(marca) {
  const dt = Math.min(100, marca - (marcaPrevia || marca));
  marcaPrevia = marca;

  if (rapido || metaTramo !== null) {
    const meta = rapido ? esc.horizonte : Math.min(metaTramo, esc.horizonte);
    const limite = performance.now() + 12;
    let sigue = true;
    while (sigue && performance.now() < limite) {
      for (let i = 0; i < 1500; i++) {
        const prox = modelo.sim.proximo();
        if (!prox || prox.t > meta) { sigue = false; break; }
        procesar(modelo.paso(), false);
      }
    }
    relojVisual = sigue ? modelo.reloj : meta;
    if (!sigue) { metaTramo = null; rapido = false; marcarTodo(true); }
    cerrarSiTermino();
  } else if (corriendo) {
    relojVisual += dt * VELOCIDADES[Number($('velocidad').value)];
    const animar = VELOCIDADES[Number($('velocidad').value)] <= 10;
    if (!avanzarHasta(relojVisual, animar)) relojVisual = modelo.reloj;
    cerrarSiTermino();
    pendiente.tablero = true;
  }

  moverFichas(dt);
  pintarReloj();
  const tareas = { tablero: pintarTablero, info: pintarInfo, cifras: pintarCifras, graficos: pintarGraficos, logs: pintarLogs, trazas: pintarTrazas, teoria: pintarTeoria };
  for (const [clave, pintar] of Object.entries(tareas)) {
    if (pendiente[clave] && marca - ultimo[clave] >= PERIODO[clave]) {
      pintar();
      pendiente[clave] = false;
      ultimo[clave] = marca;
    }
  }
  requestAnimationFrame(cuadro);
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
function iniciar() {
  const sel = $('preajuste');
  for (const p of PREAJUSTES) sel.append(el('option', { value: p.id }, p.esc.nombre));
  sel.append(el('option', { value: 'propio' }, 'Personalizado'));
  sel.addEventListener('change', () => {
    const p = PREAJUSTES.find((x) => x.id === sel.value);
    if (p) { mostrarError('', ''); fijarEscenario(validarCadena(p.esc), p.id); }
    else sel.value = 'propio';
  });

  const modo = $('hpa-modo');
  for (const [id, nombre] of Object.entries(MODOS_HPA)) modo.append(el('option', { value: id }, nombre));
  modo.addEventListener('change', () => cambiarModoHPA(modo.value));

  const filtros = $('filtros-log');
  for (const [id, nombre] of Object.entries(FILTROS)) {
    const b = el('button', { type: 'button', 'aria-pressed': String(id === filtroLog), 'data-filtro': id }, nombre);
    b.addEventListener('click', () => {
      filtroLog = id;
      for (const otro of filtros.children) otro.setAttribute('aria-pressed', String(otro === b));
      pintarLogs();
    });
    filtros.append(b);
  }

  $('btn-correr').addEventListener('click', () => { if (!modelo.terminado) corriendo = !corriendo; });
  $('btn-tramo').addEventListener('click', () => { if (!modelo.terminado) { corriendo = false; metaTramo = relojVisual + 15000; } });
  $('btn-final').addEventListener('click', () => { if (!modelo.terminado) { corriendo = false; rapido = true; } });
  $('btn-reiniciar').addEventListener('click', reiniciar);
  $('velocidad').addEventListener('input', pintarVelocidad);

  $('btn-json-aplicar').addEventListener('click', () => {
    try {
      const nuevo = validarCadena(JSON.parse($('json-texto').value));
      mostrarError('', '');
      const igual = PREAJUSTES.find((p) => JSON.stringify(validarCadena(p.esc)) === JSON.stringify(nuevo));
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

  fCpu = new Franjas('f-cpu');
  fRep = new Franjas('f-rep');
  fCola = new Franjas('f-cola');
  fLat = new Franjas('f-lat');
  let espera = 0;
  window.addEventListener('resize', () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      ajustarEscala();
      for (const f of formulariosDist) f.redibujar();
      marcarTodo(true);
    }, 150);
  });

  pintarVelocidad();
  fijarEscenario(esc, 'guia');
  // La página abre con 40 s ya simulados: dos revisiones del HPA y el catálogo acumulando cola.
  while (!avanzarHasta(40000, false)) { /* sigue hasta llegar */ }
  relojVisual = 40000;
  marcarTodo(true);
  requestAnimationFrame(cuadro);
}

iniciar();
