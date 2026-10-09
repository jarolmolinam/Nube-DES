// Distribuciones de probabilidad para tiempos (entre llegadas, de servicio, ...).
//
// Una distribución se describe con un objeto plano, que es lo que se guarda en
// el JSON del escenario:   { "tipo": "exponencial", "media": 100 }
// crearDistribucion(espec) la valida y devuelve un objeto con:
//   media, varianza, cv2 (coeficiente de variación al cuadrado),
//   kendall (letra de la notación de Kendall) y muestrear(rng).

/** Función gamma (aproximación de Lanczos), necesaria para la Weibull. */
export function gamma(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/** Catálogo: lo usa la interfaz para dibujar los formularios. */
export const CATALOGO = {
  exponencial: {
    etiqueta: 'Exponencial',
    params: [{ id: 'media', etiqueta: 'Media', unidad: 'tiempo', min: 0 }],
  },
  constante: {
    etiqueta: 'Constante (determinista)',
    params: [{ id: 'valor', etiqueta: 'Valor', unidad: 'tiempo', min: 0 }],
  },
  uniforme: {
    etiqueta: 'Uniforme',
    params: [
      { id: 'min', etiqueta: 'Mínimo', unidad: 'tiempo', min: 0 },
      { id: 'max', etiqueta: 'Máximo', unidad: 'tiempo', min: 0 },
    ],
  },
  triangular: {
    etiqueta: 'Triangular',
    params: [
      { id: 'min', etiqueta: 'Mínimo', unidad: 'tiempo', min: 0 },
      { id: 'moda', etiqueta: 'Moda', unidad: 'tiempo', min: 0 },
      { id: 'max', etiqueta: 'Máximo', unidad: 'tiempo', min: 0 },
    ],
  },
  erlang: {
    etiqueta: 'Erlang-k',
    params: [
      { id: 'k', etiqueta: 'Fases k', unidad: '', min: 1, entero: true },
      { id: 'media', etiqueta: 'Media', unidad: 'tiempo', min: 0 },
    ],
  },
  lognormal: {
    etiqueta: 'Lognormal',
    params: [
      { id: 'media', etiqueta: 'Media', unidad: 'tiempo', min: 0 },
      { id: 'cv', etiqueta: 'Coef. de variación', unidad: '', min: 0 },
    ],
  },
  weibull: {
    etiqueta: 'Weibull',
    params: [
      { id: 'forma', etiqueta: 'Forma k', unidad: '', min: 0 },
      { id: 'escala', etiqueta: 'Escala', unidad: 'tiempo', min: 0 },
    ],
  },
  empirica: {
    etiqueta: 'Empírica (datos medidos)',
    params: [{ id: 'valores', etiqueta: 'Valores separados por coma', unidad: 'lista' }],
  },
};

function exigir(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje);
}

function esNumero(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Valida una especificación y construye la distribución. */
export function crearDistribucion(espec) {
  exigir(espec && typeof espec === 'object', 'La distribución debe ser un objeto con el campo "tipo".');
  const tipo = espec.tipo;
  exigir(Object.prototype.hasOwnProperty.call(CATALOGO, tipo), `Distribución desconocida: "${tipo}".`);
  let d;

  switch (tipo) {
    case 'exponencial': {
      const { media } = espec;
      exigir(esNumero(media) && media > 0, 'Exponencial: la media debe ser mayor que 0.');
      d = {
        media,
        varianza: media * media,
        kendall: 'M',
        muestrear: (rng) => -media * Math.log(rng.uniforme()),
      };
      break;
    }
    case 'constante': {
      const { valor } = espec;
      exigir(esNumero(valor) && valor > 0, 'Constante: el valor debe ser mayor que 0.');
      d = { media: valor, varianza: 0, kendall: 'D', muestrear: () => valor };
      break;
    }
    case 'uniforme': {
      const { min, max } = espec;
      exigir(esNumero(min) && esNumero(max), 'Uniforme: mínimo y máximo deben ser números.');
      exigir(min >= 0, 'Uniforme: el mínimo no puede ser negativo.');
      exigir(max > min, 'Uniforme: el máximo debe ser mayor que el mínimo.');
      d = {
        media: (min + max) / 2,
        varianza: ((max - min) * (max - min)) / 12,
        kendall: 'G',
        muestrear: (rng) => min + (max - min) * rng.uniforme(),
      };
      break;
    }
    case 'triangular': {
      const { min: a, moda: c, max: b } = espec;
      exigir(esNumero(a) && esNumero(b) && esNumero(c), 'Triangular: mínimo, moda y máximo deben ser números.');
      exigir(a >= 0, 'Triangular: el mínimo no puede ser negativo.');
      exigir(b > a, 'Triangular: el máximo debe ser mayor que el mínimo.');
      exigir(c >= a && c <= b, 'Triangular: la moda debe estar entre el mínimo y el máximo.');
      const corte = (c - a) / (b - a);
      d = {
        media: (a + b + c) / 3,
        varianza: (a * a + b * b + c * c - a * b - a * c - b * c) / 18,
        kendall: 'G',
        muestrear: (rng) => {
          const u = rng.uniforme();
          return u < corte
            ? a + Math.sqrt(u * (b - a) * (c - a))
            : b - Math.sqrt((1 - u) * (b - a) * (b - c));
        },
      };
      break;
    }
    case 'erlang': {
      const { k, media } = espec;
      exigir(Number.isInteger(k) && k >= 1, 'Erlang: k debe ser un entero mayor o igual a 1.');
      exigir(esNumero(media) && media > 0, 'Erlang: la media debe ser mayor que 0.');
      const mediaFase = media / k;
      d = {
        media,
        varianza: (media * media) / k,
        kendall: k === 1 ? 'M' : `E${k}`,
        // Suma de k exponenciales: -mediaFase * ln(U1 * U2 * ... * Uk)
        muestrear: (rng) => {
          let suma = 0;
          for (let i = 0; i < k; i++) suma -= Math.log(rng.uniforme());
          return mediaFase * suma;
        },
      };
      break;
    }
    case 'lognormal': {
      const { media, cv } = espec;
      exigir(esNumero(media) && media > 0, 'Lognormal: la media debe ser mayor que 0.');
      exigir(esNumero(cv) && cv > 0, 'Lognormal: el coeficiente de variación debe ser mayor que 0.');
      const sigma2 = Math.log(1 + cv * cv);
      const sigma = Math.sqrt(sigma2);
      const mu = Math.log(media) - sigma2 / 2;
      d = {
        media,
        varianza: cv * cv * media * media,
        kendall: 'G',
        // Normal estándar por Box-Muller (consume dos uniformes por muestra).
        muestrear: (rng) => {
          const u1 = rng.uniforme();
          const u2 = rng.uniforme();
          const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          return Math.exp(mu + sigma * z);
        },
      };
      break;
    }
    case 'weibull': {
      const { forma, escala } = espec;
      exigir(esNumero(forma) && forma > 0, 'Weibull: la forma debe ser mayor que 0.');
      exigir(esNumero(escala) && escala > 0, 'Weibull: la escala debe ser mayor que 0.');
      const g1 = gamma(1 + 1 / forma);
      const g2 = gamma(1 + 2 / forma);
      d = {
        media: escala * g1,
        varianza: escala * escala * (g2 - g1 * g1),
        kendall: forma === 1 ? 'M' : 'G',
        muestrear: (rng) => escala * Math.pow(-Math.log(rng.uniforme()), 1 / forma),
      };
      break;
    }
    case 'empirica': {
      const { valores } = espec;
      exigir(Array.isArray(valores) && valores.length >= 1, 'Empírica: se necesita al menos un valor.');
      exigir(valores.every((v) => esNumero(v) && v >= 0), 'Empírica: todos los valores deben ser números no negativos.');
      const n = valores.length;
      const media = valores.reduce((s, v) => s + v, 0) / n;
      exigir(media > 0, 'Empírica: la media de los valores debe ser mayor que 0.');
      const varianza = valores.reduce((s, v) => s + (v - media) * (v - media), 0) / n;
      d = {
        media,
        varianza,
        kendall: varianza === 0 ? 'D' : 'G',
        // Remuestreo: cada valor medido tiene la misma probabilidad.
        muestrear: (rng) => valores[Math.min(n - 1, Math.floor(rng.uniforme() * n))],
      };
      break;
    }
  }

  d.tipo = tipo;
  d.espec = espec;
  d.cv2 = d.varianza / (d.media * d.media);
  d.esExponencial = d.kendall === 'M';
  d.esDeterminista = d.varianza === 0;
  return d;
}

/** Especificación por defecto de un tipo, conservando la media indicada. */
export function especPorDefecto(tipo, media = 100) {
  const m = media;
  const r = (x) => Math.round(x * 1000) / 1000;
  switch (tipo) {
    case 'exponencial': return { tipo, media: r(m) };
    case 'constante': return { tipo, valor: r(m) };
    case 'uniforme': return { tipo, min: r(0.5 * m), max: r(1.5 * m) };
    case 'triangular': return { tipo, min: r(0.4 * m), moda: r(0.8 * m), max: r(1.8 * m) };
    case 'erlang': return { tipo, k: 4, media: r(m) };
    case 'lognormal': return { tipo, media: r(m), cv: 1.5 };
    case 'weibull': return { tipo, forma: 1.5, escala: r(m / gamma(1 + 1 / 1.5)) };
    case 'empirica': return { tipo, valores: [0.4, 0.6, 0.8, 0.9, 1.0, 1.1, 1.3, 1.9].map((f) => r(f * m)) };
    default: throw new Error(`Distribución desconocida: "${tipo}".`);
  }
}

/** Texto corto para mostrar en un bloque, p. ej. "Exp(100)". */
export function resumenDistribucion(espec) {
  const n = (x) => String(Math.round(x * 100) / 100).replace('.', ',');
  switch (espec.tipo) {
    case 'exponencial': return `Exp(${n(espec.media)})`;
    case 'constante': return `Const(${n(espec.valor)})`;
    case 'uniforme': return `U(${n(espec.min)}; ${n(espec.max)})`;
    case 'triangular': return `Tri(${n(espec.min)}; ${n(espec.moda)}; ${n(espec.max)})`;
    case 'erlang': return `Erlang-${espec.k}(${n(espec.media)})`;
    case 'lognormal': return `LogN(${n(espec.media)}; CV ${n(espec.cv)})`;
    case 'weibull': return `Weibull(${n(espec.forma)}; ${n(espec.escala)})`;
    case 'empirica': return `Empírica (${espec.valores.length} datos)`;
    default: return String(espec.tipo);
  }
}
