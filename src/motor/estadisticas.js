// Acumuladores estadísticos del motor.
//
// Hay dos clases de promedio en una simulación de eventos discretos:
//  - por observación (un dato por petición): tiempo de respuesta, espera...
//  - ponderado por tiempo (una variable de estado que cambia a saltos):
//    número en el sistema, número en cola, servidor ocupado...
// Confundirlos es uno de los errores más comunes al depurar un modelo.

/** Percentil p (0..1) de un arreglo ya ordenado, con interpolación lineal. */
export function percentil(ordenado, p) {
  const n = ordenado.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * p;
  const i = Math.floor(pos);
  const frac = pos - i;
  return i + 1 < n ? ordenado[i] + frac * (ordenado[i + 1] - ordenado[i]) : ordenado[i];
}

/** Promedio por observación (algoritmo de Welford) con muestras guardadas. */
export class Acumulador {
  constructor({ guardarMuestras = true } = {}) {
    this.guardar = guardarMuestras;
    this.reiniciar();
  }

  reiniciar() {
    this.n = 0;
    this.media = 0;
    this.m2 = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.datos = this.guardar ? new Float64Array(1024) : null;
  }

  agregar(x) {
    if (this.guardar) {
      if (this.n === this.datos.length) {
        const mayor = new Float64Array(this.datos.length * 2);
        mayor.set(this.datos);
        this.datos = mayor;
      }
      this.datos[this.n] = x;
    }
    this.n++;
    const delta = x - this.media;
    this.media += delta / this.n;
    this.m2 += delta * (x - this.media);
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }

  get varianza() {
    return this.n > 1 ? this.m2 / (this.n - 1) : NaN;
  }

  get desviacion() {
    return Math.sqrt(this.varianza);
  }

  /** Copia ordenada de las muestras. */
  ordenadas() {
    return this.datos.slice(0, this.n).sort();
  }
}

/** Promedio ponderado por tiempo de una variable que cambia a saltos. */
export class PromedioTemporal {
  constructor(t0 = 0, valor = 0) {
    this.reiniciar(t0, valor);
  }

  reiniciar(t0, valor = this.valor) {
    this.t0 = t0;
    this.tUltimo = t0;
    this.valor = valor;
    this.area = 0;
    this.maximo = valor;
  }

  /** La variable pasa a valer `valor` en el instante t. */
  actualizar(t, valor) {
    this.area += this.valor * (t - this.tUltimo);
    this.tUltimo = t;
    this.valor = valor;
    if (valor > this.maximo) this.maximo = valor;
  }

  /** Promedio temporal entre t0 y t. */
  media(t) {
    const duracion = t - this.t0;
    if (duracion <= 0) return NaN;
    return (this.area + this.valor * (t - this.tUltimo)) / duracion;
  }
}
