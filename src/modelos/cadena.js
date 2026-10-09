// Modelo 2: una cadena de microservicios sobre un nodo, con HPA.
//
// Traducción de la infraestructura al modelo de eventos discretos:
//   petición                  -> entidad que recorre los servicios en orden
//   microservicio             -> estación con varias réplicas
//   réplica (pod)             -> servidor: atiende una petición a la vez
//   Service + balanceador     -> regla que elige la réplica (o cola compartida)
//   request de CPU y RAM      -> lo que cada réplica reserva en el nodo
//   limit de CPU              -> tope de velocidad: t = trabajo / min(1, limit)
//   nodo                      -> capacidad fija; lo que no cabe queda Pending
//   contención en el nodo     -> si el uso real supera los núcleos, todos se frenan
//   HPA                       -> evento periódico que aplica la regla de Kubernetes
//   arranque en frío          -> retardo entre crear un pod y que quede listo
//   métricas, logs y trazas   -> muestreo periódico, novedades y tramos por petición
//
// Eventos: llegada, entra (a un servicio), fin-servicio, pod-listo, hpa,
// muestreo y fin-calentamiento.

import { Simulador } from '../motor/simulador.js';
import { crearDistribucion } from '../motor/distribuciones.js';
import { Acumulador, PromedioTemporal, percentil } from '../motor/estadisticas.js';

// Orden de ejecución cuando varios eventos caen en el mismo instante.
export const ORDEN = { CONTROL: 0, FIN_SERVICIO: 1, POD_LISTO: 2, ENTRA: 3, LLEGADA: 4, HPA: 5, MUESTREO: 6 };

export const BALANCEOS = {
  aleatorio: 'Aleatorio',
  turnos: 'Por turnos (round-robin)',
  'menos-ocupada': 'Réplica menos ocupada',
  compartida: 'Cola compartida (ideal, M/M/c)',
};

export const MODOS_HPA = {
  apagado: 'Apagado',
  recomendar: 'Solo recomienda',
  aplicar: 'Aplica el escalado',
};

/**
 * Regla del Horizontal Pod Autoscaler de Kubernetes:
 *   deseadas = techo( réplicas listas × uso / objetivo )
 * `uso` y `objetivo` son fracciones del request de CPU (0,6 = 60 %).
 * Si el uso está a menos de `tolerancia` del objetivo, no se cambia nada.
 */
export function reglaHPA({ listas, uso, objetivo, tolerancia = 0.1, min = 1, max = Infinity }) {
  const razon = uso / objetivo;
  let deseadas = listas;
  if (Number.isFinite(razon) && Math.abs(razon - 1) > tolerancia) {
    // El 1e-9 evita que 2 × 0,9 / 0,6 = 3,0000000000000004 se redondee a 4.
    deseadas = Math.ceil(listas * razon - 1e-9);
  }
  return Math.max(min, Math.min(max, deseadas));
}

export function escenarioCadenaPorDefecto() {
  return {
    version: 1,
    modelo: 'cadena',
    nombre: 'Ejemplo de la guía: catálogo saturado',
    unidadTiempo: 'ms',
    semilla: 2026,
    llegadas: { tipo: 'exponencial', media: 25 },
    pico: null,
    redMs: 2,
    balanceo: 'aleatorio',
    servicios: [
      { id: 'auth', nombre: 'Autenticación', imagen: 'tienda/auth:1.4', servicio: { tipo: 'exponencial', media: 8 }, replicas: 1, cpuRequest: 1000, cpuLimit: 1000, ramRequest: 256 },
      { id: 'catalogo', nombre: 'Catálogo', imagen: 'tienda/catalogo:2.1', servicio: { tipo: 'exponencial', media: 35 }, replicas: 1, cpuRequest: 1000, cpuLimit: 1000, ramRequest: 1024 },
      { id: 'pagos', nombre: 'Pagos', imagen: 'tienda/pagos:1.0', servicio: { tipo: 'exponencial', media: 20 }, replicas: 1, cpuRequest: 1000, cpuLimit: 1000, ramRequest: 512 },
    ],
    nodo: { nombre: 'worker-1', cpu: 8000, ram: 8192 },
    arranquePod: 30000,
    hpa: { modo: 'recomendar', objetivo: 0.6, periodo: 15000, min: 1, max: 6, tolerancia: 0.1, estabilizacion: 300000 },
    muestreo: 1000,
    calentamiento: 0,
    horizonte: 900000,
  };
}

const esNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Valida un escenario de cadena y devuelve una copia normalizada. */
export function validarCadena(entrada) {
  if (!entrada || typeof entrada !== 'object') throw new Error('El escenario debe ser un objeto JSON.');
  const base = escenarioCadenaPorDefecto();
  const copia = JSON.parse(JSON.stringify(entrada));
  const e = { ...base, ...copia, nodo: { ...base.nodo, ...(copia.nodo || {}) }, hpa: { ...base.hpa, ...(copia.hpa || {}) } };
  if (e.modelo !== 'cadena') throw new Error(`Este applet solo entiende el modelo "cadena" (recibió "${e.modelo}").`);
  crearDistribucion(e.llegadas);
  if (!Number.isInteger(e.semilla) || e.semilla < 0 || e.semilla > 4294967295) throw new Error('La semilla debe ser un entero entre 0 y 4294967295.');
  if (!(esNum(e.horizonte) && e.horizonte > 0)) throw new Error('La duración simulada debe ser mayor que 0.');
  if (!(esNum(e.calentamiento) && e.calentamiento >= 0 && e.calentamiento < e.horizonte)) throw new Error('El calentamiento debe ser mayor o igual a 0 y menor que la duración.');
  if (!(esNum(e.redMs) && e.redMs >= 0)) throw new Error('El retardo de red no puede ser negativo.');
  if (!(esNum(e.arranquePod) && e.arranquePod >= 0)) throw new Error('El tiempo de arranque de un pod no puede ser negativo.');
  if (!(esNum(e.muestreo) && e.muestreo > 0)) throw new Error('El intervalo de muestreo debe ser mayor que 0.');
  if (!Object.prototype.hasOwnProperty.call(BALANCEOS, e.balanceo)) throw new Error(`Regla de balanceo desconocida: "${e.balanceo}".`);

  if (!(esNum(e.nodo.cpu) && e.nodo.cpu > 0)) throw new Error('La CPU del nodo debe ser mayor que 0 m.');
  if (!(esNum(e.nodo.ram) && e.nodo.ram > 0)) throw new Error('La RAM del nodo debe ser mayor que 0 Mi.');

  if (!Array.isArray(e.servicios) || e.servicios.length < 1 || e.servicios.length > 5) throw new Error('La cadena debe tener entre 1 y 5 servicios.');
  const vistos = new Set();
  let cpu = 0;
  let ram = 0;
  for (const s of e.servicios) {
    if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(s.id)) throw new Error('Cada servicio necesita un "id" en minúsculas, sin espacios.');
    if (vistos.has(s.id)) throw new Error(`El id de servicio "${s.id}" está repetido.`);
    vistos.add(s.id);
    s.nombre = s.nombre || s.id;
    s.imagen = s.imagen || `tienda/${s.id}:1.0`;
    // Valores por omisión, para poder escribir un escenario corto a mano.
    if (s.replicas === undefined) s.replicas = 1;
    if (s.cpuRequest === undefined) s.cpuRequest = 1000;
    if (s.cpuLimit === undefined) s.cpuLimit = Math.max(1000, s.cpuRequest);
    if (s.ramRequest === undefined) s.ramRequest = 256;
    try {
      crearDistribucion(s.servicio);
    } catch (err) {
      throw new Error(`${s.nombre}: ${err.message}`);
    }
    if (!(Number.isInteger(s.replicas) && s.replicas >= 1)) throw new Error(`${s.nombre}: debe tener al menos 1 réplica.`);
    if (!(esNum(s.cpuRequest) && s.cpuRequest > 0)) throw new Error(`${s.nombre}: el request de CPU debe ser mayor que 0 m.`);
    if (!(esNum(s.cpuLimit) && s.cpuLimit >= s.cpuRequest)) throw new Error(`${s.nombre}: el limit de CPU no puede ser menor que el request.`);
    if (!(esNum(s.ramRequest) && s.ramRequest >= 0)) throw new Error(`${s.nombre}: la RAM no puede ser negativa.`);
    cpu += s.replicas * s.cpuRequest;
    ram += s.replicas * s.ramRequest;
  }
  if (cpu > e.nodo.cpu) throw new Error(`Las réplicas iniciales piden ${cpu} m de CPU y el nodo solo tiene ${e.nodo.cpu} m.`);
  if (ram > e.nodo.ram) throw new Error(`Las réplicas iniciales piden ${ram} Mi de RAM y el nodo solo tiene ${e.nodo.ram} Mi.`);

  const h = e.hpa;
  if (!Object.prototype.hasOwnProperty.call(MODOS_HPA, h.modo)) throw new Error(`Modo de HPA desconocido: "${h.modo}".`);
  if (!(esNum(h.objetivo) && h.objetivo > 0)) throw new Error('HPA: el objetivo de uso de CPU debe ser mayor que 0.');
  if (!(esNum(h.periodo) && h.periodo > 0)) throw new Error('HPA: el periodo de revisión debe ser mayor que 0.');
  if (!(Number.isInteger(h.min) && h.min >= 1)) throw new Error('HPA: el mínimo de réplicas debe ser un entero mayor o igual a 1.');
  if (!(Number.isInteger(h.max) && h.max >= h.min)) throw new Error('HPA: el máximo de réplicas no puede ser menor que el mínimo.');
  if (!(esNum(h.tolerancia) && h.tolerancia >= 0)) throw new Error('HPA: la tolerancia no puede ser negativa.');
  if (!(esNum(h.estabilizacion) && h.estabilizacion >= 0)) throw new Error('HPA: la ventana de estabilización no puede ser negativa.');

  if (e.pico !== null) {
    const p = e.pico;
    if (!p || !(esNum(p.desde) && esNum(p.hasta) && p.desde >= 0 && p.hasta > p.desde)) throw new Error('Pico de tráfico: "hasta" debe ser mayor que "desde".');
    if (!(esNum(p.factor) && p.factor > 0)) throw new Error('Pico de tráfico: el multiplicador debe ser mayor que 0.');
  }
  return e;
}

export class Cadena {
  constructor(escenario) {
    this.esc = validarCadena(escenario);
    const e = this.esc;
    this.sim = new Simulador({ semilla: e.semilla });
    this.distLlegadas = crearDistribucion(e.llegadas);
    this.azarLlegadas = this.sim.flujo('llegadas');
    this.terminado = false;
    this.novedades = [];
    this.intervenciones = 0;

    this.nodo = { cpu: e.nodo.cpu, ram: e.nodo.ram, cpuAsignada: 0, ramAsignada: 0 };
    this.nucleos = e.nodo.cpu / 1000;
    this.pendientes = [];       // pods que no caben en el nodo, en orden de solicitud
    this.demandaTotal = 0;      // núcleos que pedirían las réplicas ocupadas sin contención
    this.contencion = false;    // ¿se está repartiendo la CPU por falta de núcleos?
    this.tIntegrado = 0;

    this.llegadas = 0;
    this.completadas = 0;
    this.enSistema = 0;
    this.siguienteId = 1;
    this.trazas = [];           // últimas peticiones completadas, con sus tramos
    this.serie = [];            // muestras periódicas (las "métricas" del clúster)
    this.trabajoCompletado = 0; // ms de CPU de las peticiones ya atendidas

    this.servicios = e.servicios.map((def, i) => ({
      def,
      i,
      dist: crearDistribucion(def.servicio),
      azar: this.sim.flujo(`servicio:${def.id}`),
      azarBalanceo: this.sim.flujo(`balanceo:${def.id}`),
      demanda: Math.min(1, def.cpuLimit / 1000), // núcleos que usa una réplica ocupada
      peso: def.cpuRequest / 1000,               // núcleos garantizados por réplica
      replicas: [],
      listas: [],
      espera: [],        // cola compartida (o de reserva si no hay réplica lista)
      enCola: 0,
      ocupadas: 0,
      siguientePod: 1,
      turno: 0,
      tasaCPU: 0,        // núcleos en uso ahora mismo
      usoIntegral: 0,    // núcleos·ms acumulados
      hpaIntegral: 0,
      hpaT: 0,
      recomendaciones: [],
      hpa: null,         // última decisión del HPA
      mIntegral: 0,
      ocupIntegral: 0,   // réplicas ocupadas·ms acumuladas
      mOcupacion: 0,
      ventana: { completadas: 0, estancia: 0 },
      obs: this.#nuevasEstadisticas(0),
    }));
    this.obs = { desde: 0, llegadas: 0, completadas: 0, respuesta: new Acumulador() };
    this.ventana = { completadas: 0, latencia: 0 };

    this.sim.en('llegada', () => this.#alLlegar());
    this.sim.en('entra', (ev) => this.#alEntrar(ev.datos.peticion, ev.datos.i));
    this.sim.en('fin-servicio', (ev) => this.#alTerminarServicio(ev.datos.replica));
    this.sim.en('pod-listo', (ev) => this.#alQuedarListo(ev.datos.replica));
    this.sim.en('hpa', () => this.#alRevisarHPA());
    this.sim.en('muestreo', () => this.#alMuestrear());
    this.sim.en('fin-calentamiento', () => this.#alTerminarCalentamiento());

    // Las réplicas iniciales ya están listas en t = 0 (no pagan arranque en frío).
    for (const s of this.servicios) {
      for (let k = 0; k < s.def.replicas; k++) this.#crearReplica(s, true);
      this.#registrar(s);
    }
    this.novedades = [];

    this.sim.agendar(this.#intervaloLlegada(), 'llegada', {}, ORDEN.LLEGADA);
    this.sim.agendar(e.muestreo, 'muestreo', {}, ORDEN.MUESTREO);
    this.hpaAgendado = e.hpa.modo !== 'apagado';
    if (this.hpaAgendado) this.sim.agendar(e.hpa.periodo, 'hpa', {}, ORDEN.HPA);
    if (e.calentamiento > 0) this.sim.agendar(e.calentamiento, 'fin-calentamiento', {}, ORDEN.CONTROL);
  }

  get reloj() {
    return this.sim.reloj;
  }

  // -------------------------------------------------------------------------
  // Ciclo de la corrida
  // -------------------------------------------------------------------------

  /** Ejecuta un evento. Devuelve { evento, novedades } o null si terminó. */
  paso() {
    if (this.terminado) return null;
    const prox = this.sim.proximo();
    if (!prox || prox.t > this.esc.horizonte) {
      this.sim.avanzarReloj(this.esc.horizonte);
      this.#integrar();
      this.terminado = true;
      return null;
    }
    this.novedades = [];
    const evento = this.sim.paso();
    return { evento, novedades: this.novedades };
  }

  correr() {
    while (this.paso()) { /* un evento por vuelta */ }
    return this.resultados();
  }

  // -------------------------------------------------------------------------
  // Llegadas y recorrido de la cadena
  // -------------------------------------------------------------------------

  /** Multiplicador de la tasa de llegadas en el instante t (1 fuera del pico). */
  factorTrafico(t) {
    const p = this.esc.pico;
    return p && t >= p.desde && t < p.hasta ? p.factor : 1;
  }

  #intervaloLlegada() {
    // Simplificación: el intervalo se muestrea con la tasa vigente al agendarlo.
    return this.distLlegadas.muestrear(this.azarLlegadas) / this.factorTrafico(this.sim.reloj);
  }

  #alLlegar() {
    this.#integrar();
    const t = this.sim.reloj;
    const peticion = { id: this.siguienteId++, tLlegada: t, tFin: null, tramos: [], trabajo: 0, restante: 0, tVelocidad: 0 };
    this.llegadas++;
    this.obs.llegadas++;
    this.enSistema++;
    this.sim.agendar(this.#intervaloLlegada(), 'llegada', {}, ORDEN.LLEGADA);
    this.sim.agendar(this.esc.redMs, 'entra', { peticion, i: 0 }, ORDEN.ENTRA);
    this.novedades.push({ tipo: 'llega', id: peticion.id });
  }

  #alEntrar(peticion, i) {
    this.#integrar();
    const s = this.servicios[i];
    peticion.tramos.push({ i, pod: null, tEntrada: this.sim.reloj, tInicio: null, tFin: null });
    const replica = this.#elegirReplica(s);
    if (replica && !replica.enServicio) {
      this.#iniciarServicio(replica, peticion);
    } else if (replica) {
      replica.cola.push(peticion);
      s.enCola++;
    } else {
      s.espera.push(peticion);
      s.enCola++;
    }
    this.novedades.push({ tipo: 'entra', i, id: peticion.id });
    this.#repartirCPU();
    this.#registrar(s);
  }

  /** El balanceador del Service: decide qué réplica recibe la petición. */
  #elegirReplica(s) {
    const listas = s.listas;
    if (listas.length === 0) return null;
    switch (this.esc.balanceo) {
      case 'compartida':
        return listas.find((r) => !r.enServicio) || null;
      case 'aleatorio':
        return listas[Math.min(listas.length - 1, Math.floor(s.azarBalanceo.uniforme() * listas.length))];
      case 'turnos':
        return listas[s.turno++ % listas.length];
      default: { // menos-ocupada
        let mejor = listas[0];
        let carga = mejor.cola.length + (mejor.enServicio ? 1 : 0);
        for (let k = 1; k < listas.length; k++) {
          const c = listas[k].cola.length + (listas[k].enServicio ? 1 : 0);
          if (c < carga) { mejor = listas[k]; carga = c; }
        }
        return mejor;
      }
    }
  }

  #iniciarServicio(replica, peticion) {
    const s = replica.servicio;
    const t = this.sim.reloj;
    const tramo = peticion.tramos[peticion.tramos.length - 1];
    tramo.tInicio = t;
    tramo.pod = replica.nombre;
    // "trabajo" son los ms de CPU que necesita la petición con un núcleo entero.
    peticion.trabajo = s.dist.muestrear(s.azar);
    peticion.restante = peticion.trabajo;
    peticion.tVelocidad = t;
    replica.enServicio = peticion;
    replica.velocidad = s.demanda;
    replica.finServicio = this.sim.agendar(peticion.restante / replica.velocidad, 'fin-servicio', { replica }, ORDEN.FIN_SERVICIO);
    s.ocupadas++;
    s.tasaCPU += replica.velocidad;
    this.demandaTotal += s.demanda;
  }

  #alTerminarServicio(replica) {
    this.#integrar();
    const t = this.sim.reloj;
    const s = replica.servicio;
    const peticion = replica.enServicio;
    const tramo = peticion.tramos[peticion.tramos.length - 1];
    tramo.tFin = t;
    replica.enServicio = null;
    replica.finServicio = null;
    s.ocupadas--;
    s.tasaCPU -= replica.velocidad;
    replica.velocidad = 0;
    this.demandaTotal -= s.demanda;
    this.trabajoCompletado += peticion.trabajo;

    s.obs.salidas++;
    s.obs.espera.agregar(tramo.tInicio - tramo.tEntrada);
    s.obs.servicio.agregar(tramo.tFin - tramo.tInicio);
    s.ventana.completadas++;
    s.ventana.estancia += tramo.tFin - tramo.tEntrada;

    if (s.i + 1 < this.servicios.length) {
      this.sim.agendar(this.esc.redMs, 'entra', { peticion, i: s.i + 1 }, ORDEN.ENTRA);
      this.novedades.push({ tipo: 'salto', de: s.i, id: peticion.id });
    } else {
      peticion.tFin = t;
      const total = t - peticion.tLlegada;
      this.completadas++;
      this.enSistema--;
      this.obs.completadas++;
      this.obs.respuesta.agregar(total);
      this.ventana.completadas++;
      this.ventana.latencia += total;
      this.trazas.push(peticion);
      if (this.trazas.length > 400) this.trazas.splice(0, 200);
      this.novedades.push({ tipo: 'completa', de: s.i, id: peticion.id, total });
    }

    this.#atenderSiguiente(replica);
    this.#repartirCPU();
    this.#registrar(s);
  }

  /** La réplica quedó libre: toma otra petición o, si se estaba apagando, se retira. */
  #atenderSiguiente(replica) {
    const s = replica.servicio;
    if (replica.cola.length > 0) {
      s.enCola--;
      this.#iniciarServicio(replica, replica.cola.shift());
    } else if (replica.estado === 'lista' && s.espera.length > 0) {
      s.enCola--;
      this.#iniciarServicio(replica, s.espera.shift());
    } else if (replica.estado === 'terminando') {
      this.#retirar(replica);
    }
  }

  // -------------------------------------------------------------------------
  // CPU: integración del uso y reparto cuando el nodo no da abasto
  // -------------------------------------------------------------------------

  /** Acumula el uso de CPU de cada servicio desde la última vez. */
  #integrar() {
    const t = this.sim.reloj;
    const dt = t - this.tIntegrado;
    if (dt > 0) {
      for (const s of this.servicios) {
        s.usoIntegral += s.tasaCPU * dt;
        s.ocupIntegral += s.ocupadas * dt;
      }
      this.tIntegrado = t;
    }
  }

  /**
   * Reparte los núcleos del nodo entre las réplicas ocupadas.
   * Sin contención cada réplica usa min(1, limit). Si la suma supera los
   * núcleos, se reparte en proporción al request (como cpu.shares en Linux),
   * sin dar a nadie más de lo que pide. Al cambiar la velocidad de una réplica
   * se reprograma el fin de su petición en curso.
   */
  #repartirCPU() {
    const hayContencion = this.demandaTotal > this.nucleos + 1e-9;
    if (!hayContencion && !this.contencion) return; // caso normal: nada que recalcular
    this.contencion = hayContencion;
    const t = this.sim.reloj;
    const activas = [];
    for (const s of this.servicios) {
      s.tasaCPU = 0;
      for (const r of s.replicas) if (r.enServicio) activas.push(r);
    }
    const asignada = new Map();
    if (!hayContencion) {
      for (const r of activas) asignada.set(r, r.servicio.demanda);
    } else {
      let resto = this.nucleos;
      let grupo = activas.slice();
      for (;;) {
        const pesos = grupo.reduce((suma, r) => suma + r.servicio.peso, 0);
        const x = resto / pesos;
        const satisfechas = grupo.filter((r) => r.servicio.demanda <= r.servicio.peso * x + 1e-12);
        if (satisfechas.length === 0) {
          for (const r of grupo) asignada.set(r, r.servicio.peso * x);
          break;
        }
        for (const r of satisfechas) {
          asignada.set(r, r.servicio.demanda);
          resto -= r.servicio.demanda;
        }
        grupo = grupo.filter((r) => !asignada.has(r));
        if (grupo.length === 0) break;
      }
    }
    for (const r of activas) {
      const nueva = asignada.get(r);
      if (Math.abs(nueva - r.velocidad) > 1e-12) {
        const p = r.enServicio;
        p.restante = Math.max(0, p.restante - r.velocidad * (t - p.tVelocidad));
        p.tVelocidad = t;
        r.velocidad = nueva;
        this.sim.cancelar(r.finServicio);
        r.finServicio = this.sim.agendar(p.restante / nueva, 'fin-servicio', { replica: r }, ORDEN.FIN_SERVICIO);
      }
      r.servicio.tasaCPU += r.velocidad;
    }
  }

  // -------------------------------------------------------------------------
  // Orquestador: crear, ubicar y retirar pods
  // -------------------------------------------------------------------------

  /** ¿Cabe una réplica más de este servicio en el nodo? */
  cabe(s) {
    return this.nodo.cpuAsignada + s.def.cpuRequest <= this.nodo.cpu + 1e-9
      && this.nodo.ramAsignada + s.def.ramRequest <= this.nodo.ram + 1e-9;
  }

  /** Réplicas que el orquestador intenta mantener (sin contar las que se apagan). */
  deseadas(s) {
    let n = 0;
    for (const r of s.replicas) if (r.estado !== 'terminando') n++;
    return n + this.pendientes.filter((x) => x === s).length;
  }

  #crearReplica(s, yaLista = false) {
    if (!this.cabe(s)) {
      this.pendientes.push(s);
      const faltaCPU = this.nodo.cpuAsignada + s.def.cpuRequest > this.nodo.cpu + 1e-9;
      this.novedades.push({ tipo: 'pod-pendiente', i: s.i, falta: faltaCPU ? 'cpu' : 'ram' });
      return null;
    }
    this.nodo.cpuAsignada += s.def.cpuRequest;
    this.nodo.ramAsignada += s.def.ramRequest;
    const replica = {
      nombre: `${s.def.id}-${s.siguientePod++}`,
      servicio: s,
      estado: yaLista ? 'lista' : 'arrancando',
      cola: [],
      enServicio: null,
      velocidad: 0,
      finServicio: null,
      listo: null,
      tCreada: this.sim.reloj,
    };
    s.replicas.push(replica);
    if (yaLista) {
      s.listas.push(replica);
    } else {
      replica.listo = this.sim.agendar(this.esc.arranquePod, 'pod-listo', { replica }, ORDEN.POD_LISTO);
    }
    this.novedades.push({ tipo: 'pod-creado', i: s.i, pod: replica.nombre, lista: yaLista });
    this.#registrar(s);
    return replica;
  }

  #alQuedarListo(replica) {
    this.#integrar();
    const s = replica.servicio;
    replica.estado = 'lista';
    replica.listo = null;
    s.listas.push(replica);
    this.novedades.push({ tipo: 'pod-listo', i: s.i, pod: replica.nombre, arranque: this.sim.reloj - replica.tCreada });
    if (s.espera.length > 0) {
      s.enCola--;
      this.#iniciarServicio(replica, s.espera.shift());
    }
    this.#repartirCPU();
    this.#registrar(s);
  }

  #retirar(replica) {
    const s = replica.servicio;
    s.replicas.splice(s.replicas.indexOf(replica), 1);
    const k = s.listas.indexOf(replica);
    if (k >= 0) s.listas.splice(k, 1);
    this.nodo.cpuAsignada -= s.def.cpuRequest;
    this.nodo.ramAsignada -= s.def.ramRequest;
    this.novedades.push({ tipo: 'pod-eliminado', i: s.i, pod: replica.nombre });
    this.#registrar(s);
    this.#ubicarPendientes();
  }

  /** Al liberarse recursos, el planificador reintenta ubicar los pods Pending. */
  #ubicarPendientes() {
    const cola = this.pendientes;
    this.pendientes = [];
    for (const s of cola) {
      if (this.cabe(s)) this.#crearReplica(s);
      else this.pendientes.push(s);
    }
  }

  /** Lleva un servicio a n réplicas deseadas (lo llaman el HPA y la interfaz). */
  #escalar(s, n, origen) {
    const antes = this.deseadas(s);
    if (n === antes) return;
    this.novedades.push({ tipo: 'escala', i: s.i, de: antes, a: n, origen });
    if (n > antes) {
      for (let k = antes; k < n; k++) this.#crearReplica(s);
    } else {
      let sobran = antes - n;
      // 1) pods que nunca se ubicaron
      for (let k = this.pendientes.length - 1; k >= 0 && sobran > 0; k--) {
        if (this.pendientes[k] === s) { this.pendientes.splice(k, 1); sobran--; }
      }
      // 2) pods que aún están arrancando, del más nuevo al más viejo
      for (let k = s.replicas.length - 1; k >= 0 && sobran > 0; k--) {
        const r = s.replicas[k];
        if (r.estado === 'arrancando') {
          this.sim.cancelar(r.listo);
          this.#retirar(r);
          sobran--;
        }
      }
      // 3) pods listos: primero los que tienen menos trabajo; nunca el último
      while (sobran > 0 && s.listas.length > 1) {
        let elegido = s.listas[s.listas.length - 1];
        let carga = elegido.cola.length + (elegido.enServicio ? 1 : 0);
        for (let k = s.listas.length - 2; k >= 0; k--) {
          const c = s.listas[k].cola.length + (s.listas[k].enServicio ? 1 : 0);
          if (c < carga) { elegido = s.listas[k]; carga = c; }
        }
        elegido.estado = 'terminando';
        s.listas.splice(s.listas.indexOf(elegido), 1);
        this.novedades.push({ tipo: 'pod-terminando', i: s.i, pod: elegido.nombre, pendientes: carga });
        if (carga === 0) this.#retirar(elegido);
        sobran--;
      }
    }
    this.#registrar(s);
  }

  /**
   * Cambio manual de réplicas desde fuera del modelo, en el instante t.
   * Devuelve false si se pide subir y la réplica no cabe en el nodo.
   */
  escalarManual(indice, n, t = this.sim.reloj) {
    const s = this.servicios[indice];
    if (this.terminado || n < 1) return false;
    if (n > this.deseadas(s) && !this.cabe(s)) return false;
    this.sim.avanzarReloj(Math.max(t, this.sim.reloj));
    this.#integrar();
    this.novedades = [];
    this.#escalar(s, n, 'manual');
    this.intervenciones++;
    this.sim.anotar(`manual:${s.def.id}:${n}`);
    return true;
  }

  // -------------------------------------------------------------------------
  // HPA
  // -------------------------------------------------------------------------

  /** Cambia el modo del HPA durante la corrida (intervención manual). */
  cambiarModoHPA(modo, t = this.sim.reloj) {
    if (this.terminado || !Object.prototype.hasOwnProperty.call(MODOS_HPA, modo)) return false;
    this.sim.avanzarReloj(Math.max(t, this.sim.reloj));
    this.#integrar();
    this.novedades = [];
    this.esc.hpa.modo = modo;
    if (modo !== 'apagado' && !this.hpaAgendado) {
      for (const s of this.servicios) { s.hpaIntegral = s.usoIntegral; s.hpaT = this.sim.reloj; }
      this.sim.agendar(this.esc.hpa.periodo, 'hpa', {}, ORDEN.HPA);
      this.hpaAgendado = true;
    }
    this.intervenciones++;
    this.sim.anotar(`hpa:${modo}`);
    return true;
  }

  #alRevisarHPA() {
    this.#integrar();
    const t = this.sim.reloj;
    const h = this.esc.hpa;
    if (h.modo === 'apagado') {
      this.hpaAgendado = false; // se apagó en vivo: deja de revisar
      for (const s of this.servicios) s.hpa = null;
      return;
    }
    for (const s of this.servicios) {
      const ventana = t - s.hpaT;
      const nucleos = ventana > 0 ? (s.usoIntegral - s.hpaIntegral) / ventana : 0;
      s.hpaIntegral = s.usoIntegral;
      s.hpaT = t;
      const listas = s.listas.length;
      const uso = nucleos / (listas * s.peso); // fracción del request, promedio de la ventana
      const cruda = reglaHPA({ listas, uso, objetivo: h.objetivo, tolerancia: h.tolerancia, min: h.min, max: h.max });
      // Para reducir, Kubernetes usa la mayor recomendación de la ventana de estabilización.
      s.recomendaciones.push({ t, deseadas: cruda });
      while (s.recomendaciones.length > 1 && s.recomendaciones[0].t < t - h.estabilizacion) s.recomendaciones.shift();
      const estable = s.recomendaciones.reduce((m, r) => Math.max(m, r.deseadas), 0);
      const actuales = this.deseadas(s);
      const final = cruda > actuales ? cruda : Math.min(actuales, Math.max(cruda, estable));
      s.hpa = { t, nucleos, uso, listas, cruda, deseadas: final, actuales, extra: final - actuales, frenada: final > cruda };
      this.novedades.push({ tipo: 'hpa', i: s.i, uso, listas, cruda, deseadas: final, actuales });
      if (h.modo === 'aplicar' && final !== actuales) this.#escalar(s, final, 'hpa');
    }
    this.sim.agendar(h.periodo, 'hpa', {}, ORDEN.HPA);
  }

  // -------------------------------------------------------------------------
  // Métricas
  // -------------------------------------------------------------------------

  #nuevasEstadisticas(t) {
    return {
      desde: t,
      salidas: 0,
      espera: new Acumulador(),
      servicio: new Acumulador({ guardarMuestras: false }),
      enCola: new PromedioTemporal(t, 0),
      ocupadas: new PromedioTemporal(t, 0),
      listas: new PromedioTemporal(t, 0),
      replicas: new PromedioTemporal(t, 0),
      usoDesde: 0,
    };
  }

  #registrar(s) {
    const t = this.sim.reloj;
    s.obs.enCola.actualizar(t, s.enCola);
    s.obs.ocupadas.actualizar(t, s.ocupadas);
    s.obs.listas.actualizar(t, s.listas.length);
    s.obs.replicas.actualizar(t, s.replicas.length);
  }

  /** El "metrics-server": toma una muestra de cada servicio cada cierto intervalo. */
  #alMuestrear() {
    this.#integrar();
    const t = this.sim.reloj;
    const dt = this.esc.muestreo;
    const muestra = {
      t,
      enSistema: this.enSistema,
      completadas: this.ventana.completadas,
      latencia: this.ventana.completadas ? this.ventana.latencia / this.ventana.completadas : NaN,
      cpuAsignada: this.nodo.cpuAsignada,
      ramAsignada: this.nodo.ramAsignada,
      cpuNodo: 0,
      factor: this.factorTrafico(t),
      s: [],
    };
    this.ventana = { completadas: 0, latencia: 0 };
    for (const s of this.servicios) {
      const cpu = (s.usoIntegral - s.mIntegral) / dt; // núcleos, promedio del intervalo
      s.mIntegral = s.usoIntegral;
      muestra.cpuNodo += cpu;
      muestra.s.push({
        cpu,
        usoRequest: s.listas.length ? cpu / (s.listas.length * s.peso) : NaN,
        listas: s.listas.length,
        replicas: s.replicas.length,
        pendientes: this.pendientes.filter((x) => x === s).length,
        ocupadas: s.ocupadas,
        ocupacion: (s.ocupIntegral - s.mOcupacion) / dt, // réplicas ocupadas, promedio del intervalo
        cola: s.enCola,
        completadas: s.ventana.completadas,
        estancia: s.ventana.completadas ? s.ventana.estancia / s.ventana.completadas : NaN,
      });
      s.mOcupacion = s.ocupIntegral;
      s.ventana = { completadas: 0, estancia: 0 };
    }
    this.serie.push(muestra);
    this.sim.agendar(dt, 'muestreo', {}, ORDEN.MUESTREO);
  }

  #alTerminarCalentamiento() {
    this.#integrar();
    const t = this.sim.reloj;
    this.obs = { desde: t, llegadas: 0, completadas: 0, respuesta: new Acumulador() };
    for (const s of this.servicios) {
      s.obs = this.#nuevasEstadisticas(t);
      s.obs.usoDesde = s.usoIntegral;
      this.#registrar(s);
    }
    this.novedades.push({ tipo: 'calentamiento' });
  }

  /** ms de CPU ya entregados a las peticiones que siguen en servicio. */
  #trabajoEnCurso() {
    const t = this.sim.reloj;
    let suma = 0;
    for (const s of this.servicios) {
      for (const r of s.replicas) {
        if (r.enServicio) {
          const p = r.enServicio;
          suma += p.trabajo - Math.max(0, p.restante - r.velocidad * (t - p.tVelocidad));
        }
      }
    }
    return suma;
  }

  /** Indicadores del periodo de observación, evaluados en el reloj actual. */
  resultados() {
    this.#integrar();
    const t = this.sim.reloj;
    const duracion = t - this.obs.desde;
    const ordenadas = this.obs.respuesta.ordenadas();
    let entregado = 0;
    const servicios = this.servicios.map((s) => {
      entregado += s.usoIntegral;
      const o = s.obs;
      const listas = o.listas.media(t);
      const cpu = duracion > 0 ? (s.usoIntegral - o.usoDesde) / duracion : NaN;
      return {
        id: s.def.id,
        nombre: s.def.nombre,
        n: o.espera.n,
        rho: o.ocupadas.media(t) / listas,
        Wq: o.espera.n ? o.espera.media : NaN,
        S: o.servicio.n ? o.servicio.media : NaN,
        W: o.espera.n ? o.espera.media + o.servicio.media : NaN,
        Lq: o.enCola.media(t),
        cpu,
        usoRequest: cpu / (listas * s.peso),
        listasMedia: listas,
        listas: s.listas.length,
        replicas: s.replicas.length,
        deseadas: this.deseadas(s),
        pendientes: this.pendientes.filter((x) => x === s).length,
        enCola: s.enCola,
        ocupadas: s.ocupadas,
        replicaSegundos: (o.replicas.media(t) * (t - o.desde)) / 1000,
      };
    });
    return {
      reloj: t,
      duracionObservada: duracion,
      eventos: this.sim.eventosEjecutados,
      huella: this.sim.huella,
      intervenciones: this.intervenciones,
      llegadas: this.llegadas,
      completadas: this.completadas,
      enSistema: this.enSistema,
      conserva: this.llegadas === this.completadas + this.enSistema,
      n: this.obs.respuesta.n,
      W: this.obs.respuesta.n ? this.obs.respuesta.media : NaN,
      p50: percentil(ordenadas, 0.5),
      p95: percentil(ordenadas, 0.95),
      p99: percentil(ordenadas, 0.99),
      X: duracion > 0 ? this.obs.completadas / duracion : NaN,
      lambdaObservada: duracion > 0 ? this.obs.llegadas / duracion : NaN,
      nodo: { ...this.nodo, pendientes: this.pendientes.length },
      replicaSegundos: servicios.reduce((suma, s) => suma + s.replicaSegundos, 0),
      trabajo: { entregado, atendido: this.trabajoCompletado + this.#trabajoEnCurso() },
      servicios,
      respuestasOrdenadas: ordenadas,
    };
  }
}
