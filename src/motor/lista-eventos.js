// Lista de eventos futuros (FEL, future event list) como montículo binario.
//
// Orden de salida: primero el menor tiempo; si hay empate, la menor prioridad;
// si persiste, el que se agendó antes. El desempate es determinista a
// propósito: sin él, dos corridas con la misma semilla podrían diferir.

function antes(a, b) {
  if (a.t !== b.t) return a.t < b.t;
  if (a.prioridad !== b.prioridad) return a.prioridad < b.prioridad;
  return a.sec < b.sec;
}

export class ListaEventos {
  constructor() {
    this.monton = [];
    this.secuencia = 0;
  }

  get tamano() {
    return this.monton.length;
  }

  insertar(evento) {
    evento.sec = this.secuencia++;
    const h = this.monton;
    h.push(evento);
    let i = h.length - 1;
    while (i > 0) {
      const padre = (i - 1) >> 1;
      if (!antes(h[i], h[padre])) break;
      [h[i], h[padre]] = [h[padre], h[i]];
      i = padre;
    }
    return evento;
  }

  /** Mira el próximo evento sin sacarlo. */
  proximo() {
    return this.monton.length ? this.monton[0] : null;
  }

  /** Saca y devuelve el próximo evento. */
  extraer() {
    const h = this.monton;
    if (h.length === 0) return null;
    const primero = h[0];
    const ultimo = h.pop();
    if (h.length > 0) {
      h[0] = ultimo;
      let i = 0;
      for (;;) {
        const izq = 2 * i + 1;
        const der = izq + 1;
        let menor = i;
        if (izq < h.length && antes(h[izq], h[menor])) menor = izq;
        if (der < h.length && antes(h[der], h[menor])) menor = der;
        if (menor === i) break;
        [h[i], h[menor]] = [h[menor], h[i]];
        i = menor;
      }
    }
    return primero;
  }

  /** Copia ordenada, para mostrarla en pantalla. No modifica la lista. */
  ordenados() {
    return this.monton.filter((e) => !e.cancelado).sort((a, b) => (antes(a, b) ? -1 : 1));
  }
}
