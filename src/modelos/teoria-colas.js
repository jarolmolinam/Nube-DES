// Resultados teóricos de colas de un servidor, para verificar el simulador.
//
// Verificar es comprobar que el programa hace lo que el modelo dice. La forma
// más directa es correrlo en un caso que tenga solución analítica y comparar.
// Todas las tasas y tiempos usan la unidad de tiempo del escenario.

import { crearDistribucion } from '../motor/distribuciones.js';

/** M/M/1: llegadas Poisson, servicio exponencial, cola sin límite. */
export function mm1(lambda, mu) {
  const rho = lambda / mu;
  if (rho >= 1) return null;
  const W = 1 / (mu - lambda);
  const Wq = rho / (mu - lambda);
  return {
    rho,
    L: rho / (1 - rho),
    Lq: (rho * rho) / (1 - rho),
    W,
    Wq,
    X: lambda,
    pRechazo: 0,
    // El tiempo de respuesta de M/M/1 es exponencial de tasa (mu - lambda).
    percentilW: (p) => -Math.log(1 - p) / (mu - lambda),
    densidadW: (t) => (mu - lambda) * Math.exp(-(mu - lambda) * t),
  };
}

/** M/M/1/K: como M/M/1 pero caben K peticiones en total (cola + servicio). */
export function mm1k(lambda, mu, K) {
  const a = lambda / mu;
  // Pesos proporcionales a a^n, reescalados para no desbordar si a > 1.
  const pesos = new Array(K + 1);
  let w = 1;
  let suma = 0;
  for (let n = 0; n <= K; n++) {
    pesos[n] = w;
    suma += w;
    w *= a;
    if (w > 1e200) {
      for (let j = 0; j <= n; j++) pesos[j] /= 1e200;
      suma /= 1e200;
      w /= 1e200;
    }
  }
  const p = pesos.map((x) => x / suma);
  const pK = p[K];
  let L = 0;
  for (let n = 0; n <= K; n++) L += n * p[n];
  const lambdaEf = lambda * (1 - pK);
  const W = L / lambdaEf;
  const Wq = W - 1 / mu;
  return {
    rho: 1 - p[0],
    L,
    Lq: lambdaEf * Wq,
    W,
    Wq,
    X: lambdaEf,
    pRechazo: pK,
  };
}

/** M/G/1: fórmula de Pollaczek-Khinchine (exacta). */
export function mg1(lambda, mediaServicio, cv2Servicio) {
  const rho = lambda * mediaServicio;
  if (rho >= 1) return null;
  const Wq = (rho * mediaServicio * (1 + cv2Servicio)) / (2 * (1 - rho));
  const W = Wq + mediaServicio;
  return { rho, L: lambda * W, Lq: lambda * Wq, W, Wq, X: lambda, pRechazo: 0 };
}

/** G/G/1: aproximación de Kingman (buena con carga alta, no es exacta). */
export function gg1Kingman(lambda, mediaServicio, cv2Llegadas, cv2Servicio) {
  const rho = lambda * mediaServicio;
  if (rho >= 1) return null;
  const Wq = (rho / (1 - rho)) * ((cv2Llegadas + cv2Servicio) / 2) * mediaServicio;
  const W = Wq + mediaServicio;
  return { rho, L: lambda * W, Lq: lambda * Wq, W, Wq, X: lambda, pRechazo: 0 };
}

/**
 * Elige la mejor referencia teórica disponible para un escenario de un pod.
 * metodo: 'exacta' | 'aproximada' | 'inestable' | 'ninguna'
 */
export function teoriaPara(escenario) {
  const a = crearDistribucion(escenario.llegadas);
  const s = crearDistribucion(escenario.servicio);
  const lambda = 1 / a.media;
  const mu = 1 / s.media;
  const cargaOfrecida = lambda / mu;
  const finita = escenario.capacidadCola !== null && escenario.capacidadCola !== undefined;
  const K = finita ? escenario.capacidadCola + 1 : null;
  const kendall = `${a.kendall}/${s.kendall}/1${finita ? `/${K}` : ''}`;
  const base = { kendall, lambda, mu, cargaOfrecida, cv2Llegadas: a.cv2, cv2Servicio: s.cv2, K };

  if (finita) {
    if (a.esExponencial && s.esExponencial) {
      return { ...base, metodo: 'exacta', nombre: `Fórmulas de M/M/1/${K}`, ...mm1k(lambda, mu, K) };
    }
    return {
      ...base,
      metodo: 'ninguna',
      nombre: 'Sin fórmula cerrada sencilla',
      nota: 'Con cola limitada y distribuciones generales no hay una fórmula sencilla: aquí la simulación es la herramienta.',
    };
  }

  if (a.esDeterminista && s.esDeterminista) {
    if (cargaOfrecida > 1) {
      return { ...base, metodo: 'inestable', nombre: 'Sistema saturado', nota: 'El servicio tarda más que el intervalo entre llegadas: la cola crece sin límite.' };
    }
    return {
      ...base,
      metodo: 'exacta',
      nombre: 'D/D/1: sin azar no hay espera',
      rho: cargaOfrecida, L: cargaOfrecida, Lq: 0, W: s.media, Wq: 0, X: lambda, pRechazo: 0,
    };
  }

  if (cargaOfrecida >= 1) {
    return {
      ...base,
      metodo: 'inestable',
      nombre: 'Sistema saturado',
      nota: 'Llegan peticiones más rápido de lo que el pod las atiende (ρ ≥ 1): la cola crece sin límite y no existe un estado estable con el cual comparar.',
    };
  }

  if (a.esExponencial && s.esExponencial) {
    return { ...base, metodo: 'exacta', nombre: 'Fórmulas de M/M/1', ...mm1(lambda, mu) };
  }
  if (a.esExponencial) {
    return { ...base, metodo: 'exacta', nombre: 'Pollaczek-Khinchine (M/G/1)', ...mg1(lambda, s.media, s.cv2) };
  }
  return {
    ...base,
    metodo: 'aproximada',
    nombre: 'Aproximación de Kingman (G/G/1)',
    nota: 'Kingman es una aproximación: se acerca al valor real cuando la carga es alta, pero no es exacta.',
    ...gg1Kingman(lambda, s.media, a.cv2, s.cv2),
  };
}

/** M/M/c: c servidores iguales con una cola compartida (fórmula de Erlang C). */
export function mmc(lambda, mu, c) {
  const a = lambda / mu;
  const rho = a / c;
  if (rho >= 1) return null;
  let termino = 1; // a^n / n!
  let suma = 1;
  for (let n = 1; n < c; n++) {
    termino *= a / n;
    suma += termino;
  }
  const ultimo = (termino * a) / c / (1 - rho); // a^c / (c! (1 - rho))
  const pEspera = ultimo / (suma + ultimo);
  const Lq = (pEspera * rho) / (1 - rho);
  const Wq = Lq / lambda;
  const W = Wq + 1 / mu;
  return { rho, pEspera, Lq, Wq, W, L: lambda * W, X: lambda, pRechazo: 0 };
}

/**
 * Referencia teórica para una cadena en serie (red de Jackson).
 *
 * Si las llegadas son de Poisson y cada servicio es exponencial, la salida de
 * cada etapa vuelve a ser de Poisson (teorema de Burke) y cada servicio se
 * analiza por separado. Con cola compartida es un M/M/c; con reparto aleatorio
 * son c colas M/M/1 que reciben λ/c cada una.
 *
 * Devuelve { aplica: true, servicios: [...], W } o { aplica: false, motivo }.
 */
export function teoriaCadena(escenario) {
  const e = escenario;
  const no = (motivo) => ({ aplica: false, motivo });
  const llegadas = crearDistribucion(e.llegadas);
  if (!llegadas.esExponencial) return no('Las llegadas no son de Poisson.');
  if (e.pico) return no('El tráfico cambia durante la corrida (hay un pico).');
  if (e.hpa.modo === 'aplicar') return no('El HPA cambia el número de réplicas durante la corrida.');
  if (e.balanceo !== 'compartida' && e.balanceo !== 'aleatorio') {
    return no('Solo hay fórmula cerrada para cola compartida (M/M/c) y reparto aleatorio (M/M/1 por réplica).');
  }
  const lambda = 1 / llegadas.media;
  let demandaMaxima = 0;
  const servicios = [];
  for (const s of e.servicios) {
    const d = crearDistribucion(s.servicio);
    if (!d.esExponencial) return no(`El tiempo de servicio de ${s.nombre} no es exponencial.`);
    const velocidad = Math.min(1, s.cpuLimit / 1000);
    demandaMaxima += s.replicas * velocidad;
    const mu = velocidad / d.media;
    const c = s.replicas;
    const rho = lambda / (c * mu);
    if (rho >= 1) return no(`${s.nombre} está saturado (ρ = ${rho.toFixed(2).replace('.', ',')}): su cola crece sin límite y no hay estado estable.`);
    const t = e.balanceo === 'compartida' ? mmc(lambda, mu, c) : mm1(lambda / c, mu);
    servicios.push({ id: s.id, rho, Wq: t.Wq, S: 1 / mu, W: t.W, Lq: lambda * t.Wq });
  }
  if (demandaMaxima > e.nodo.cpu / 1000 + 1e-9) {
    return no('Los limits de CPU suman más que los núcleos del nodo: puede haber contención y la fórmula no la contempla.');
  }
  const red = e.redMs * e.servicios.length;
  return {
    aplica: true,
    nombre: e.balanceo === 'compartida' ? 'Red de Jackson con etapas M/M/c' : 'Red de Jackson con colas M/M/1 por réplica',
    lambda,
    servicios,
    red,
    W: servicios.reduce((suma, s) => suma + s.W, 0) + red,
  };
}
