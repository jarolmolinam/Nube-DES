// Piezas de interfaz que comparten todos los applets: acceso al DOM, formato
// de números, gráficos y formularios de distribuciones.

/* global crearDistribucion, especPorDefecto, CATALOGO, Aleatorio, percentil */

const $ = (id) => document.getElementById(id);
const NS_SVG = 'http://www.w3.org/2000/svg';

function el(nombre, attrs = {}, texto) {
  const n = document.createElement(nombre);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (texto !== undefined) n.textContent = texto;
  return n;
}
function elSvg(nombre, attrs = {}, texto) {
  const n = document.createElementNS(NS_SVG, nombre);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (texto !== undefined) n.textContent = texto;
  return n;
}

// ---------------------------------------------------------------------------
// Formato de números (coma decimal, como se escribe en Colombia)
// ---------------------------------------------------------------------------
const FORMATOS = [0, 1, 2, 3].map((d) => new Intl.NumberFormat('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }));
const num = (x, d = 2) => (Number.isFinite(x) ? FORMATOS[d].format(x) : '—');
const entero = (x) => num(x, 0);
/** Número con decimales según su tamaño: 1.234 · 123,4 · 12,34 · 1,23 */
function adapt(x) {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  return num(x, a >= 1000 ? 0 : a >= 100 ? 1 : 2);
}
const pct = (x, d = 1) => (Number.isFinite(x) ? `${num(x * 100, d)} %` : '—');
const corto = (x) => (Number.isFinite(x) ? String(Math.round(x * 100) / 100).replace('.', ',') : '—');

// ---------------------------------------------------------------------------
// Gráficos (SVG dibujado a mano, una sola escala por eje)
// ---------------------------------------------------------------------------
function marcasEje(min, max, cuantas) {
  const rango = max - min;
  if (!(rango > 0)) return { paso: 1, valores: [min] };
  const bruto = rango / cuantas;
  const mag = Math.pow(10, Math.floor(Math.log10(bruto)));
  const norm = bruto / mag;
  const paso = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const valores = [];
  for (let v = Math.ceil(min / paso - 1e-9) * paso; v <= max + paso * 1e-9; v += paso) valores.push(Math.abs(v) < paso * 1e-9 ? 0 : v);
  return { paso, valores };
}
function etiquetaEje(v, paso) {
  const d = Math.max(0, Math.min(3, -Math.floor(Math.log10(paso) + 1e-9)));
  return num(v, d);
}

class Grafico {
  constructor(id) {
    this.raiz = $(id);
    this.svg = this.raiz.querySelector('svg');
    this.globo = this.raiz.querySelector('.globo');
    this.puntero = null;
    this.puntos = [];
    this.raiz.addEventListener('pointermove', (e) => {
      this.puntero = e.clientX - this.svg.getBoundingClientRect().left;
      this.resaltar();
    });
    this.raiz.addEventListener('pointerleave', () => { this.puntero = null; this.resaltar(); });
  }

  /**
   * def = { x:{min,max,titulo}, y:{min,max}, vacio, capas(ctx) -> string SVG,
   *         puntos:[{x, titulo, filas:[{clave,nombre,valor}], barra}] }
   */
  dibujar(def) {
    const ancho = Math.max(260, this.raiz.clientWidth || 340);
    const alto = 210;
    const m = { izq: 46, der: 14, sup: 14, inf: 36 };
    this.svg.setAttribute('viewBox', `0 0 ${ancho} ${alto}`);
    if (def.vacio) {
      this.svg.innerHTML = `<text class="vacio" x="${ancho / 2}" y="${alto / 2}" text-anchor="middle">${def.vacio}</text>`;
      this.puntos = [];
      this.globo.hidden = true;
      return;
    }
    const px = (v) => m.izq + ((v - def.x.min) / (def.x.max - def.x.min || 1)) * (ancho - m.izq - m.der);
    const py = (v) => alto - m.inf - ((v - def.y.min) / (def.y.max - def.y.min || 1)) * (alto - m.sup - m.inf);
    const ctx = { px, py, ancho, alto, m, x0: m.izq, x1: ancho - m.der, y0: alto - m.inf, y1: m.sup };
    const ex = marcasEje(def.x.min, def.x.max, Math.max(2, Math.floor((ancho - m.izq - m.der) / 70)));
    const ey = marcasEje(def.y.min, def.y.max, 4);
    let s = '';
    for (const v of ey.valores) {
      s += `<line class="rejilla" x1="${ctx.x0}" x2="${ctx.x1}" y1="${py(v)}" y2="${py(v)}"/>`;
      s += `<text x="${ctx.x0 - 6}" y="${py(v) + 3.5}" text-anchor="end">${etiquetaEje(v, ey.paso)}</text>`;
    }
    for (const v of ex.valores) {
      s += `<text x="${px(v)}" y="${ctx.y0 + 14}" text-anchor="middle">${etiquetaEje(v, ex.paso)}</text>`;
    }
    s += `<text class="titulo-eje" x="${(ctx.x0 + ctx.x1) / 2}" y="${alto - 4}" text-anchor="middle">${def.x.titulo}</text>`;
    s += def.capas(ctx);
    s += `<line class="eje" x1="${ctx.x0}" x2="${ctx.x1}" y1="${ctx.y0}" y2="${ctx.y0}"/>`;
    s += `<line class="cruz" data-cruz x1="0" x2="0" y1="${ctx.y1}" y2="${ctx.y0}" visibility="hidden"/>`;
    this.svg.innerHTML = s;
    this.puntos = (def.puntos || []).map((p) => ({ ...p, pxX: px(p.x) }));
    this.ctx = ctx;
    this.resaltar();
  }

  resaltar() {
    const cruz = this.svg.querySelector('[data-cruz]');
    for (const b of this.svg.querySelectorAll('.activa')) b.classList.remove('activa');
    if (this.puntero === null || this.puntos.length === 0 || !cruz) {
      this.globo.hidden = true;
      if (cruz) cruz.setAttribute('visibility', 'hidden');
      return;
    }
    const escala = (this.svg.viewBox.baseVal.width || 1) / (this.svg.getBoundingClientRect().width || 1);
    const x = this.puntero * escala;
    let mejor = this.puntos[0];
    for (const p of this.puntos) if (Math.abs(p.pxX - x) < Math.abs(mejor.pxX - x)) mejor = p;
    if (mejor.barra !== undefined) {
      const b = this.svg.querySelector(`[data-barra="${mejor.barra}"]`);
      if (b) b.classList.add('activa');
    } else {
      cruz.setAttribute('x1', mejor.pxX);
      cruz.setAttribute('x2', mejor.pxX);
      cruz.setAttribute('visibility', 'visible');
    }
    this.globo.replaceChildren(el('div', {}, mejor.titulo));
    for (const f of mejor.filas) {
      const fila = el('div');
      fila.append(el('span', { class: `clave ${f.clave}` }), el('strong', {}, f.valor), document.createTextNode(` ${f.nombre}`));
      this.globo.append(fila);
    }
    this.globo.hidden = false;
    const mitad = this.globo.offsetWidth / 2;
    const anchoReal = this.raiz.clientWidth;
    const izq = Math.max(mitad, Math.min(anchoReal - mitad, mejor.pxX / escala));
    this.globo.style.left = `${izq}px`;
    this.globo.style.top = `${this.ctx.y1 + 2}px`;
  }
}

// ---------------------------------------------------------------------------
// Distribuciones: vista previa y formulario
// ---------------------------------------------------------------------------
function vistaDistribucion(svg, espec) {
  const d = crearDistribucion(espec);
  const rng = new Aleatorio(12345);
  const N = 4000;
  const muestras = new Float64Array(N);
  for (let i = 0; i < N; i++) muestras[i] = d.muestrear(rng);
  muestras.sort();
  const tope = d.esDeterminista ? d.media * 2 : Math.max(percentil(muestras, 0.985), d.media * 1.2);
  const ancho = Math.max(200, svg.clientWidth || 300);
  const alto = 54;
  const base = alto - 14;
  const CUBETAS = Math.min(40, Math.floor(ancho / 8));
  const cuenta = new Array(CUBETAS).fill(0);
  for (const v of muestras) if (v <= tope) cuenta[Math.min(CUBETAS - 1, Math.floor((v / tope) * CUBETAS))]++;
  const maxC = Math.max(...cuenta);
  const paso = ancho / CUBETAS;
  let s = '';
  cuenta.forEach((c, i) => {
    const h = (c / maxC) * (base - 2);
    if (c > 0) s += `<rect class="barra" x="${(i * paso + 1).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${(paso - 2).toFixed(1)}" height="${h.toFixed(1)}"/>`;
  });
  const xMedia = (d.media / tope) * ancho;
  s += `<line class="media" x1="${xMedia}" x2="${xMedia}" y1="0" y2="${base}"/>`;
  s += `<text x="0" y="${alto - 2}">0</text>`;
  s += `<text x="${Math.min(ancho - 30, Math.max(14, xMedia))}" y="${alto - 2}" text-anchor="middle">media</text>`;
  s += `<text x="${ancho}" y="${alto - 2}" text-anchor="end">${adapt(tope)} ms</text>`;
  svg.setAttribute('viewBox', `0 0 ${ancho} ${alto}`);
  svg.innerHTML = s;
}

/**
 * Formulario de una distribución: tipo, parámetros, vista previa y resumen.
 *   cont        elemento donde se dibuja
 *   pref        prefijo para los id de los controles (deben ser estables)
 *   espec       especificación actual, p. ej. { tipo: 'exponencial', media: 25 }
 *   etiqueta    texto del selector de tipo
 *   tasa        'λ', 'μ' o null: símbolo de la tasa que se muestra en el resumen
 *   alCambiar   función que recibe la nueva especificación (quien llama la valida)
 */
function montarFormDist(cont, { pref, espec, etiqueta, tasa = null, alCambiar }) {
  cont.replaceChildren();
  const leer = () => {
    const tipo = selector.value;
    const nueva = { tipo };
    for (const p of CATALOGO[tipo].params) {
      const bruto = $(`${pref}-p-${p.id}`).value;
      nueva[p.id] = p.unidad === 'lista'
        ? bruto.split(/[;\s]+/).filter(Boolean).map((x) => Number(x.replace(',', '.')))
        : Number(bruto);
    }
    alCambiar(nueva);
  };

  const campoTipo = el('div', { class: 'campo ancho' });
  const selector = el('select', { id: `${pref}-tipo` });
  for (const [tipo, info] of Object.entries(CATALOGO)) selector.append(el('option', { value: tipo }, info.etiqueta));
  selector.value = espec.tipo;
  selector.addEventListener('change', () => alCambiar(especPorDefecto(selector.value, crearDistribucion(espec).media)));
  campoTipo.append(el('label', { for: `${pref}-tipo` }, etiqueta), selector);

  const campos = el('div', { class: 'campos' });
  campos.append(campoTipo);
  for (const p of CATALOGO[espec.tipo].params) {
    const id = `${pref}-p-${p.id}`;
    const esLista = p.unidad === 'lista';
    const campo = el('div', { class: `campo${esLista ? ' ancho' : ''}` });
    const entrada = esLista
      ? el('input', { type: 'text', id, class: 'dato', inputmode: 'decimal' })
      : el('input', { type: 'number', id, min: p.min, step: p.entero ? 1 : 'any' });
    entrada.value = esLista ? espec[p.id].join('; ') : espec[p.id];
    entrada.addEventListener('change', leer);
    campo.append(
      el('label', { for: id }, esLista ? 'Valores medidos (ms), separados por punto y coma' : `${p.etiqueta}${p.unidad === 'tiempo' ? ' (ms)' : ''}`),
      entrada,
    );
    campos.append(campo);
  }
  const d = crearDistribucion(espec);
  const vista = document.createElementNS(NS_SVG, 'svg');
  vista.setAttribute('class', 'vista-dist');
  vista.setAttribute('aria-hidden', 'true');
  const textoTasa = tasa ? ` · ${tasa} = ${corto(1000 / d.media)} pet/s` : '';
  const resumen = el('p', { class: 'resumen-dist' }, `media ${corto(d.media)} ms · CV² = ${corto(d.cv2)}${textoTasa}`);
  cont.append(campos, vista, resumen);
  vistaDistribucion(vista, espec);
  return { redibujar: () => vistaDistribucion(vista, espec) };
}
