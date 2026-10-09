// Pruebas del núcleo: generador aleatorio, distribuciones, lista de eventos.
// Ejecutar con:  npm test      (o: node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Aleatorio } from '../src/motor/aleatorio.js';
import { CATALOGO, crearDistribucion, especPorDefecto, gamma } from '../src/motor/distribuciones.js';
import { ListaEventos } from '../src/motor/lista-eventos.js';
import { Acumulador, PromedioTemporal, percentil } from '../src/motor/estadisticas.js';
import { Simulador } from '../src/motor/simulador.js';

const cerca = (real, esperado, tolRel, mensaje) => {
  const error = Math.abs(real - esperado) / Math.max(Math.abs(esperado), 1e-12);
  assert.ok(error <= tolRel, `${mensaje}: obtuvo ${real}, esperaba ${esperado} (error ${(error * 100).toFixed(2)} %)`);
};

test('aleatorio: la misma semilla repite la secuencia', () => {
  const a = new Aleatorio(42);
  const b = new Aleatorio(42);
  for (let i = 0; i < 1000; i++) assert.equal(a.uniforme(), b.uniforme());
});

test('aleatorio: semillas distintas dan secuencias distintas', () => {
  const a = new Aleatorio(1);
  const b = new Aleatorio(2);
  let iguales = 0;
  for (let i = 0; i < 1000; i++) if (a.uniforme() === b.uniforme()) iguales++;
  assert.ok(iguales < 5);
});

test('aleatorio: uniforme en (0,1) con media 1/2 y varianza 1/12', () => {
  const r = new Aleatorio(7);
  const ac = new Acumulador({ guardarMuestras: false });
  const cubetas = new Array(10).fill(0);
  const n = 400000;
  for (let i = 0; i < n; i++) {
    const u = r.uniforme();
    assert.ok(u > 0 && u < 1);
    ac.agregar(u);
    cubetas[Math.floor(u * 10)]++;
  }
  cerca(ac.media, 0.5, 0.005, 'media');
  cerca(ac.varianza, 1 / 12, 0.01, 'varianza');
  // Ji-cuadrado con 9 grados de libertad: el valor crítico al 0,1 % es 27,88.
  const esperado = n / 10;
  const ji2 = cubetas.reduce((s, c) => s + ((c - esperado) ** 2) / esperado, 0);
  assert.ok(ji2 < 27.88, `ji-cuadrado = ${ji2}`);
});

test('aleatorio: los flujos son reproducibles y distintos entre sí', () => {
  const raiz1 = new Aleatorio(99);
  const raiz2 = new Aleatorio(99);
  const a1 = raiz1.flujo('llegadas');
  const a2 = raiz2.flujo('llegadas');
  const s1 = raiz1.flujo('servicio');
  let coincidencias = 0;
  for (let i = 0; i < 500; i++) {
    const x = a1.uniforme();
    assert.equal(x, a2.uniforme());
    if (x === s1.uniforme()) coincidencias++;
  }
  assert.ok(coincidencias < 3);
});

test('aleatorio: sin correlación serial apreciable', () => {
  const r = new Aleatorio(5);
  const n = 200000;
  let previo = r.uniforme();
  let suma = 0;
  for (let i = 0; i < n; i++) {
    const u = r.uniforme();
    suma += (previo - 0.5) * (u - 0.5);
    previo = u;
  }
  const correlacion = suma / n / (1 / 12);
  assert.ok(Math.abs(correlacion) < 0.01, `correlación de orden 1 = ${correlacion}`);
});

test('gamma: valores conocidos', () => {
  cerca(gamma(1), 1, 1e-12, 'Γ(1)');
  cerca(gamma(5), 24, 1e-12, 'Γ(5)');
  cerca(gamma(0.5), Math.sqrt(Math.PI), 1e-12, 'Γ(1/2)');
});

// Cada distribución debe reproducir su media y su varianza teóricas.
const casos = [
  { tipo: 'exponencial', media: 100 },
  { tipo: 'constante', valor: 80 },
  { tipo: 'uniforme', min: 20, max: 140 },
  { tipo: 'triangular', min: 10, moda: 50, max: 200 },
  { tipo: 'triangular', min: 10, moda: 10, max: 200 },
  { tipo: 'erlang', k: 4, media: 80 },
  { tipo: 'lognormal', media: 80, cv: 1.5 },
  { tipo: 'weibull', forma: 1.5, escala: 90 },
  { tipo: 'weibull', forma: 0.8, escala: 90 },
  { tipo: 'empirica', valores: [10, 20, 20, 50, 400] },
];

for (const espec of casos) {
  test(`distribución ${JSON.stringify(espec)}: media y varianza muestrales`, () => {
    const d = crearDistribucion(espec);
    const rng = new Aleatorio(2026).flujo('prueba');
    const ac = new Acumulador({ guardarMuestras: false });
    const n = 600000;
    for (let i = 0; i < n; i++) {
      const x = d.muestrear(rng);
      assert.ok(x >= 0 && Number.isFinite(x), `muestra inválida: ${x}`);
      ac.agregar(x);
    }
    cerca(ac.media, d.media, 0.01, 'media');
    if (d.varianza === 0) assert.equal(ac.varianza, 0);
    else cerca(ac.varianza, d.varianza, 0.05, 'varianza');
  });
}

test('distribuciones: Erlang-1 y Weibull de forma 1 son exponenciales', () => {
  assert.equal(crearDistribucion({ tipo: 'erlang', k: 1, media: 50 }).kendall, 'M');
  assert.equal(crearDistribucion({ tipo: 'weibull', forma: 1, escala: 50 }).kendall, 'M');
  cerca(crearDistribucion({ tipo: 'weibull', forma: 1, escala: 50 }).cv2, 1, 1e-9, 'CV²');
});

test('distribuciones: los parámetros inválidos se rechazan con un mensaje', () => {
  const malos = [
    null,
    { tipo: 'normal', media: 1 },
    { tipo: 'exponencial', media: 0 },
    { tipo: 'exponencial', media: -5 },
    { tipo: 'exponencial', media: '100' },
    { tipo: 'constante', valor: 0 },
    { tipo: 'uniforme', min: 5, max: 5 },
    { tipo: 'uniforme', min: -1, max: 5 },
    { tipo: 'triangular', min: 1, moda: 9, max: 5 },
    { tipo: 'erlang', k: 2.5, media: 10 },
    { tipo: 'lognormal', media: 10, cv: 0 },
    { tipo: 'weibull', forma: 0, escala: 1 },
    { tipo: 'empirica', valores: [] },
    { tipo: 'empirica', valores: [1, -2] },
  ];
  for (const m of malos) assert.throws(() => crearDistribucion(m), Error, JSON.stringify(m));
});

test('distribuciones: la especificación por defecto conserva la media', () => {
  for (const tipo of Object.keys(CATALOGO)) {
    const d = crearDistribucion(especPorDefecto(tipo, 80));
    cerca(d.media, 80, 0.12, `media de ${tipo}`);
  }
});

test('lista de eventos: entrega en orden de tiempo, prioridad y llegada', () => {
  const lista = new ListaEventos();
  lista.insertar({ t: 5, prioridad: 1, n: 'c' });
  lista.insertar({ t: 3, prioridad: 2, n: 'a' });
  lista.insertar({ t: 5, prioridad: 0, n: 'b' });
  lista.insertar({ t: 5, prioridad: 1, n: 'd' });
  assert.equal(lista.proximo().n, 'a');
  assert.deepEqual(lista.ordenados().map((e) => e.n), ['a', 'b', 'c', 'd']);
  assert.equal(lista.tamano, 4);
  const salida = [];
  while (lista.tamano) salida.push(lista.extraer().n);
  assert.deepEqual(salida, ['a', 'b', 'c', 'd']);
  assert.equal(lista.extraer(), null);
});

test('lista de eventos: 20 000 eventos al azar salen ordenados', () => {
  const r = new Aleatorio(11);
  const lista = new ListaEventos();
  for (let i = 0; i < 20000; i++) lista.insertar({ t: Math.floor(r.uniforme() * 500), prioridad: 0 });
  let previo = { t: -1, sec: -1 };
  while (lista.tamano) {
    const ev = lista.extraer();
    assert.ok(ev.t > previo.t || (ev.t === previo.t && ev.sec > previo.sec));
    previo = ev;
  }
});

test('estadísticas: acumulador, percentiles y promedio temporal', () => {
  const ac = new Acumulador();
  for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) ac.agregar(x);
  assert.equal(ac.n, 8);
  assert.equal(ac.media, 5);
  cerca(ac.varianza, 32 / 7, 1e-12, 'varianza muestral');
  assert.equal(ac.min, 2);
  assert.equal(ac.max, 9);
  assert.equal(percentil(ac.ordenadas(), 0.5), 4.5);
  assert.equal(percentil(ac.ordenadas(), 0), 2);
  assert.equal(percentil(ac.ordenadas(), 1), 9);

  // Muchas muestras: comprueba que el arreglo crece sin perder datos.
  const grande = new Acumulador();
  for (let i = 1; i <= 5000; i++) grande.agregar(i);
  assert.equal(grande.ordenadas().length, 5000);
  assert.equal(grande.media, 2500.5);

  // N(t) vale 0 en [0,2), 1 en [2,5), 3 en [5,10): área = 0 + 3 + 15 = 18.
  const pt = new PromedioTemporal(0, 0);
  pt.actualizar(2, 1);
  pt.actualizar(5, 3);
  assert.equal(pt.media(10), 1.8);
  assert.equal(pt.maximo, 3);
});

test('simulador: ejecuta en orden, permite cancelar y no deja retroceder el reloj', () => {
  const sim = new Simulador({ semilla: 1 });
  const visto = [];
  sim.en('a', (ev) => visto.push(['a', ev.t]));
  sim.en('b', (ev) => {
    visto.push(['b', ev.t]);
    if (ev.t < 6) sim.agendar(2, 'b');
  });
  sim.agendar(3, 'a');
  sim.agendar(1, 'b');
  const cancelado = sim.agendar(4, 'a');
  sim.cancelar(cancelado);
  let previo = 0;
  while (sim.paso()) {
    assert.ok(sim.reloj >= previo);
    previo = sim.reloj;
  }
  assert.deepEqual(visto, [['b', 1], ['a', 3], ['b', 3], ['b', 5], ['b', 7]]);
  assert.equal(sim.eventosEjecutados, 5);
  assert.throws(() => sim.agendar(-1, 'a'), /retraso/);
  assert.throws(() => sim.agendar(1, 'inexistente'), /manejador/);
  assert.throws(() => sim.avanzarReloj(0), /retroceder/);
});
