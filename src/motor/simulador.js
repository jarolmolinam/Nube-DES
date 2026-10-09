// Núcleo del simulador de eventos discretos.
//
// El ciclo es siempre el mismo, sea cual sea el modelo:
//   1. sacar de la lista el evento más próximo,
//   2. adelantar el reloj hasta su instante,
//   3. ejecutar su manejador, que cambia el estado y agenda eventos nuevos.
// El motor no sabe nada de pods ni de colas: eso lo aporta cada modelo.

import { Aleatorio, hashTexto } from './aleatorio.js';
import { ListaEventos } from './lista-eventos.js';

export class Simulador {
  constructor({ semilla = 1 } = {}) {
    this.semilla = semilla >>> 0;
    this.reloj = 0;
    this.lista = new ListaEventos();
    this.raiz = new Aleatorio(this.semilla);
    this.flujos = new Map();
    this.manejadores = new Map();
    this.eventosEjecutados = 0;
    this.huellaNum = 0x811c9dc5;
  }

  /** Flujo de números aleatorios propio de una fuente de azar del modelo. */
  flujo(nombre) {
    if (!this.flujos.has(nombre)) this.flujos.set(nombre, this.raiz.flujo(nombre));
    return this.flujos.get(nombre);
  }

  /** Registra la función que atiende un tipo de evento. */
  en(tipo, manejador) {
    this.manejadores.set(tipo, manejador);
  }

  /** Agenda un evento dentro de `retraso` unidades de tiempo. */
  agendar(retraso, tipo, datos = {}, prioridad = 0) {
    if (!(retraso >= 0) || !Number.isFinite(retraso)) {
      throw new Error(`No se puede agendar "${tipo}" con retraso ${retraso}.`);
    }
    if (!this.manejadores.has(tipo)) {
      throw new Error(`No hay manejador para el evento "${tipo}".`);
    }
    return this.lista.insertar({ t: this.reloj + retraso, tipo, datos, prioridad, cancelado: false });
  }

  /** Marca un evento para que se descarte cuando le llegue el turno. */
  cancelar(evento) {
    evento.cancelado = true;
  }

  /** Próximo evento vigente, sin ejecutarlo. */
  proximo() {
    let ev = this.lista.proximo();
    while (ev && ev.cancelado) {
      this.lista.extraer();
      ev = this.lista.proximo();
    }
    return ev;
  }

  /** Ejecuta un evento y lo devuelve; null si la lista está vacía. */
  paso() {
    const ev = this.proximo();
    if (!ev) return null;
    this.lista.extraer();
    if (ev.t < this.reloj) {
      throw new Error(`El reloj retrocedería de ${this.reloj} a ${ev.t}: hay un error en el modelo.`);
    }
    this.reloj = ev.t;
    this.manejadores.get(ev.tipo)(ev, this);
    this.eventosEjecutados++;
    this.#mezclarHuella(ev);
    return ev;
  }

  /** Adelanta el reloj sin ejecutar eventos (para cerrar una corrida). */
  avanzarReloj(t) {
    if (t < this.reloj) throw new Error('El reloj no puede retroceder.');
    this.reloj = t;
  }

  /**
   * Huella de la corrida: un resumen de la secuencia (tipo, instante) de todos
   * los eventos ejecutados. Dos corridas con la misma huella siguieron la misma
   * traza, así que sirve para comprobar que un resultado es reproducible.
   */
  get huella() {
    return (this.huellaNum >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Deja constancia en la huella de una intervención hecha desde fuera del
   * modelo (por ejemplo, cambiar réplicas a mano durante la corrida). Una
   * corrida intervenida ya no se repite solo con el escenario y la semilla.
   */
  anotar(etiqueta) {
    this.#mezclarHuella({ tipo: etiqueta, t: this.reloj });
  }

  #mezclarHuella(ev) {
    const micro = Math.round(ev.t * 1e6);
    const partes = [hashTexto(ev.tipo), micro % 4294967296, Math.floor(micro / 4294967296)];
    let h = this.huellaNum;
    for (const p of partes) {
      h ^= p >>> 0;
      h = Math.imul(h, 0x01000193);
    }
    this.huellaNum = h;
  }
}
