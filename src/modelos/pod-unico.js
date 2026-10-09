// Modelo 1: un solo pod visto como una cola de un servidor.
//
// Traducción de Kubernetes al modelo de eventos discretos:
//   petición HTTP            -> entidad
//   pod con un contenedor    -> servidor (atiende una petición a la vez)
//   peticiones en espera     -> cola FIFO
//   límite de la cola        -> capacidad; lo que no cabe se rechaza (HTTP 503)
//
// Eventos del modelo (lo único que hace avanzar el reloj):
//   llegada            una petición llega al pod
//   fin-servicio       el pod termina de atender una petición
//   fin-calentamiento  se descartan las estadísticas del arranque
// "Iniciar servicio" no es un evento: es una consecuencia inmediata de una
// llegada (si el pod está libre) o de un fin de servicio (si hay cola).

import { Simulador } from '../motor/simulador.js';
import { crearDistribucion } from '../motor/distribuciones.js';
import { Acumulador, PromedioTemporal, percentil } from '../motor/estadisticas.js';

// Desempate de eventos simultáneos: primero sale quien termina, luego entra
// quien llega. Así, el puesto que se libera en t puede ocuparlo quien llega en t.
export const PRIORIDAD = { CONTROL: 0, FIN_SERVICIO: 1, LLEGADA: 2 };

export function escenarioPorDefecto() {
  return {
    version: 1,
    modelo: 'pod-unico',
    nombre: 'M/M/1 estable (ρ = 0,8)',
    unidadTiempo: 'ms',
    semilla: 2026,
    llegadas: { tipo: 'exponencial', media: 100 },
    servicio: { tipo: 'exponencial', media: 80 },
    capacidadCola: null,
    calentamiento: 0,
    horizonte: 3600000,
  };
}

/** Valida un escenario y devuelve una copia normalizada. Lanza Error si no sirve. */
export function validarEscenario(entrada) {
  if (!entrada || typeof entrada !== 'object') throw new Error('El escenario debe ser un objeto JSON.');
  const base = escenarioPorDefecto();
  const e = { ...base, ...JSON.parse(JSON.stringify(entrada)) };
  if (e.modelo !== 'pod-unico') throw new Error(`Este applet solo entiende el modelo "pod-unico" (recibió "${e.modelo}").`);
  crearDistribucion(e.llegadas);
  crearDistribucion(e.servicio);
  if (!Number.isInteger(e.semilla) || e.semilla < 0 || e.semilla > 4294967295) {
    throw new Error('La semilla debe ser un entero entre 0 y 4294967295.');
  }
  if (!(typeof e.horizonte === 'number' && Number.isFinite(e.horizonte) && e.horizonte > 0)) {
    throw new Error('El horizonte de simulación debe ser mayor que 0.');
  }
  if (!(typeof e.calentamiento === 'number' && e.calentamiento >= 0 && e.calentamiento < e.horizonte)) {
    throw new Error('El calentamiento debe ser mayor o igual a 0 y menor que el horizonte.');
  }
  if (e.capacidadCola !== null && !(Number.isInteger(e.capacidadCola) && e.capacidadCola >= 0)) {
    throw new Error('La capacidad de la cola debe ser un entero mayor o igual a 0, o null para cola sin límite.');
  }
  return e;
}

export class PodUnico {
  constructor(escenario) {
    this.esc = validarEscenario(escenario);
    this.sim = new Simulador({ semilla: this.esc.semilla });
    this.distLlegadas = crearDistribucion(this.esc.llegadas);
    this.distServicio = crearDistribucion(this.esc.servicio);
    this.azarLlegadas = this.sim.flujo('llegadas');
    this.azarServicio = this.sim.flujo('servicio');

    // Estado del sistema
    this.cola = [];
    this.enServicio = null;
    this.siguienteId = 1;
    this.terminado = false;

    // Contadores de toda la corrida (para el invariante de conservación)
    this.llegadas = 0;
    this.atendidas = 0;
    this.rechazadas = 0;

    // Estadísticas del periodo de observación (después del calentamiento)
    this.obs = {
      desde: 0,
      llegadas: 0,
      atendidas: 0,
      rechazadas: 0,
      respuesta: new Acumulador(),
      espera: new Acumulador(),
      servicio: new Acumulador({ guardarMuestras: false }),
      enSistema: new PromedioTemporal(0, 0),
      enCola: new PromedioTemporal(0, 0),
      ocupado: new PromedioTemporal(0, 0),
    };

    this.novedades = [];
    this.sim.en('llegada', (ev) => this.#alLlegar(ev));
    this.sim.en('fin-servicio', (ev) => this.#alTerminarServicio(ev));
    this.sim.en('fin-calentamiento', () => this.#alTerminarCalentamiento());

    this.sim.agendar(this.distLlegadas.muestrear(this.azarLlegadas), 'llegada', { id: this.siguienteId }, PRIORIDAD.LLEGADA);
    if (this.esc.calentamiento > 0) {
      this.sim.agendar(this.esc.calentamiento, 'fin-calentamiento', {}, PRIORIDAD.CONTROL);
    }
  }

  get reloj() {
    return this.sim.reloj;
  }

  get enSistema() {
    return this.cola.length + (this.enServicio ? 1 : 0);
  }

  /** Ejecuta un evento. Devuelve { evento, novedades } o null si terminó. */
  paso() {
    if (this.terminado) return null;
    const prox = this.sim.proximo();
    if (!prox || prox.t > this.esc.horizonte) {
      this.sim.avanzarReloj(this.esc.horizonte);
      this.terminado = true;
      return null;
    }
    this.novedades = [];
    const evento = this.sim.paso();
    return { evento, novedades: this.novedades };
  }

  /** Corre hasta el horizonte sin detenerse. */
  correr() {
    while (this.paso()) { /* un evento por vuelta */ }
    return this.resultados();
  }

  #alLlegar() {
    const t = this.sim.reloj;
    const peticion = { id: this.siguienteId++, tLlegada: t, tInicio: null, tFin: null, servicio: null };
    this.llegadas++;
    this.obs.llegadas++;

    // La siguiente llegada se agenda siempre: la fuente no depende del pod.
    this.sim.agendar(this.distLlegadas.muestrear(this.azarLlegadas), 'llegada', { id: this.siguienteId }, PRIORIDAD.LLEGADA);

    if (this.enServicio === null) {
      this.#iniciarServicio(peticion);
    } else if (this.esc.capacidadCola !== null && this.cola.length >= this.esc.capacidadCola) {
      this.rechazadas++;
      this.obs.rechazadas++;
      this.novedades.push({ tipo: 'rechazo', id: peticion.id });
    } else {
      this.cola.push(peticion);
      this.novedades.push({ tipo: 'encola', id: peticion.id });
    }
    this.#registrarEstado();
  }

  #iniciarServicio(peticion) {
    peticion.tInicio = this.sim.reloj;
    peticion.servicio = this.distServicio.muestrear(this.azarServicio);
    this.enServicio = peticion;
    this.sim.agendar(peticion.servicio, 'fin-servicio', { id: peticion.id }, PRIORIDAD.FIN_SERVICIO);
    this.novedades.push({ tipo: 'inicia', id: peticion.id });
  }

  #alTerminarServicio() {
    const t = this.sim.reloj;
    const peticion = this.enServicio;
    peticion.tFin = t;
    this.enServicio = null;
    this.atendidas++;
    this.obs.atendidas++;
    this.obs.respuesta.agregar(peticion.tFin - peticion.tLlegada);
    this.obs.espera.agregar(peticion.tInicio - peticion.tLlegada);
    this.obs.servicio.agregar(peticion.servicio);
    this.novedades.push({ tipo: 'sale', id: peticion.id, respuesta: peticion.tFin - peticion.tLlegada });
    if (this.cola.length > 0) this.#iniciarServicio(this.cola.shift());
    this.#registrarEstado();
  }

  #alTerminarCalentamiento() {
    const t = this.sim.reloj;
    const o = this.obs;
    o.desde = t;
    o.llegadas = 0;
    o.atendidas = 0;
    o.rechazadas = 0;
    o.respuesta.reiniciar();
    o.espera.reiniciar();
    o.servicio.reiniciar();
    o.enSistema.reiniciar(t);
    o.enCola.reiniciar(t);
    o.ocupado.reiniciar(t);
    this.novedades.push({ tipo: 'calentamiento' });
  }

  #registrarEstado() {
    const t = this.sim.reloj;
    this.obs.enSistema.actualizar(t, this.enSistema);
    this.obs.enCola.actualizar(t, this.cola.length);
    this.obs.ocupado.actualizar(t, this.enServicio ? 1 : 0);
  }

  /** Indicadores del periodo de observación, evaluados en el reloj actual. */
  resultados() {
    const t = this.sim.reloj;
    const o = this.obs;
    const duracion = t - o.desde;
    const ordenadas = o.respuesta.ordenadas();
    const admitidas = o.llegadas - o.rechazadas;
    return {
      reloj: t,
      duracionObservada: duracion,
      eventos: this.sim.eventosEjecutados,
      huella: this.sim.huella,
      llegadas: this.llegadas,
      atendidas: this.atendidas,
      rechazadas: this.rechazadas,
      enSistema: this.enSistema,
      conserva: this.llegadas === this.atendidas + this.rechazadas + this.enSistema,
      n: o.respuesta.n,
      rho: o.ocupado.media(t),
      L: o.enSistema.media(t),
      Lq: o.enCola.media(t),
      W: o.respuesta.n ? o.respuesta.media : NaN,
      Wq: o.espera.n ? o.espera.media : NaN,
      S: o.servicio.n ? o.servicio.media : NaN,
      p50: percentil(ordenadas, 0.5),
      p95: percentil(ordenadas, 0.95),
      p99: percentil(ordenadas, 0.99),
      maxW: o.respuesta.n ? o.respuesta.max : NaN,
      maxEnSistema: o.enSistema.maximo,
      X: duracion > 0 ? o.atendidas / duracion : NaN,
      lambdaObservada: duracion > 0 ? o.llegadas / duracion : NaN,
      lambdaEfectiva: duracion > 0 ? admitidas / duracion : NaN,
      pRechazo: o.llegadas > 0 ? o.rechazadas / o.llegadas : NaN,
      respuestasOrdenadas: ordenadas,
    };
  }
}
