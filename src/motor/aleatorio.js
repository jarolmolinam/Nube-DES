// Generador pseudoaleatorio con semilla y flujos independientes por nombre.
//
// Por qué no Math.random(): no admite semilla, así que una corrida no se puede
// repetir. Aquí la misma semilla produce siempre la misma secuencia, y cada
// fuente de azar del modelo (llegadas, servicio, ...) usa su propio flujo.
// Con flujos separados, cambiar la distribución del servicio no altera los
// instantes de llegada: es la técnica de números aleatorios comunes.

/** Hash FNV-1a de 32 bits para convertir un nombre de flujo en un entero. */
export function hashTexto(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mezclador de 32 bits (finalizador de splitmix32). */
export function mezclar32(x) {
  x = (x + 0x9e3779b9) | 0;
  let t = x ^ (x >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  return (t ^ (t >>> 15)) >>> 0;
}

/** Generador sfc32 (Small Fast Counting, 32 bits). */
export class Aleatorio {
  constructor(semilla = 1) {
    this.semilla = semilla >>> 0;
    this.a = mezclar32(this.semilla);
    this.b = mezclar32(this.a);
    this.c = mezclar32(this.b);
    this.d = 1;
    for (let i = 0; i < 15; i++) this.entero(); // descarta el arranque
  }

  /** Entero uniforme en [0, 2^32). */
  entero() {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniforme en el intervalo abierto (0, 1): nunca devuelve 0 ni 1. */
  uniforme() {
    return (this.entero() + 0.5) / 4294967296;
  }

  /** Flujo independiente y reproducible, identificado por nombre. */
  flujo(nombre) {
    return new Aleatorio(mezclar32(this.semilla ^ hashTexto(nombre)));
  }
}
