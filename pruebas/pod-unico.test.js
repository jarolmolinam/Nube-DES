// Pruebas del modelo de un pod: traza a mano, teoría de colas e invariantes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PodUnico, escenarioPorDefecto, validarEscenario } from '../src/modelos/pod-unico.js';
import { mm1, mm1k, mg1, teoriaPara } from '../src/modelos/teoria-colas.js';

const esc = (cambios) => ({ ...escenarioPorDefecto(), ...cambios });

const cerca = (real, esperado, tolRel, mensaje) => {
  const error = Math.abs(real - esperado) / Math.max(Math.abs(esperado), 1e-12);
  assert.ok(error <= tolRel, `${mensaje}: simulado ${real}, teórico ${esperado} (error ${(error * 100).toFixed(2)} %)`);
};

// ---------------------------------------------------------------------------
// 1. Trazas deterministas que se pueden seguir a mano
// ---------------------------------------------------------------------------

test('D/D/1 holgado: llegan cada 10, se atienden en 6, nadie espera', () => {
  const m = new PodUnico(esc({
    llegadas: { tipo: 'constante', valor: 10 },
    servicio: { tipo: 'constante', valor: 6 },
    horizonte: 1000,
  }));
  const r = m.correr();
  assert.equal(r.llegadas, 100); // t = 10, 20, ..., 1000
  assert.equal(r.atendidas, 99); // la número 100 queda en servicio
  assert.equal(r.Wq, 0);
  assert.equal(r.W, 6);
  // Ocupado 6 de cada 10 entre t=10 y t=1000: 99 * 6 / 1000
  assert.equal(r.rho, 0.594);
  assert.ok(r.conserva);
});

test('D/D/1 saturado: llegan cada 2, se atienden en 3, la espera crece de a 1', () => {
  // A mano: la petición n llega en 2n, empieza en 3n - 1 y termina en 3n + 2.
  const m = new PodUnico(esc({
    llegadas: { tipo: 'constante', valor: 2 },
    servicio: { tipo: 'constante', valor: 3 },
    horizonte: 32,
  }));
  const esperas = [];
  let paso;
  while ((paso = m.paso())) {
    if (paso.evento.tipo === 'fin-servicio') {
      const k = esperas.length + 1;
      assert.equal(paso.evento.t, 3 * k + 2);
      esperas.push(m.obs.espera.datos[k - 1]);
    }
  }
  assert.deepEqual(esperas, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('D/D/1 con cola de 1 puesto: se rechazan las peticiones 5, 8, 11, ...', () => {
  // A mano (llegadas cada 2, servicio 3, cabe 1 en espera):
  //  t=2  llega 1, entra a servicio (termina en 5)
  //  t=4  llega 2, espera
  //  t=5  sale 1; 2 entra a servicio (termina en 8)
  //  t=6  llega 3, espera
  //  t=8  sale 2 y 3 entra a servicio (termina en 11); llega 4 y espera
  //  t=10 llega 5: la cola está llena -> rechazada
  //  ... y el patrón se repite cada 6 unidades.
  const m = new PodUnico(esc({
    llegadas: { tipo: 'constante', valor: 2 },
    servicio: { tipo: 'constante', valor: 3 },
    capacidadCola: 1,
    horizonte: 30,
  }));
  const rechazadas = [];
  const bitacora = [];
  let paso;
  while ((paso = m.paso())) {
    for (const nov of paso.novedades) {
      bitacora.push(`${paso.evento.t}:${nov.tipo}:${nov.id}`);
      if (nov.tipo === 'rechazo') rechazadas.push(nov.id);
    }
  }
  assert.deepEqual(rechazadas, [5, 8, 11, 14]);
  assert.deepEqual(bitacora.slice(0, 9), [
    '2:inicia:1', '4:encola:2', '5:sale:1', '5:inicia:2', '6:encola:3',
    '8:sale:2', '8:inicia:3', '8:encola:4', '10:rechazo:5',
  ]);
  assert.ok(m.resultados().conserva);
});

// ---------------------------------------------------------------------------
// 2. Comparación con la teoría de colas
// ---------------------------------------------------------------------------

test('fórmulas: M/M/1 con λ = 0,01 y μ = 0,0125', () => {
  const t = mm1(0.01, 0.0125);
  cerca(t.rho, 0.8, 1e-12, 'ρ');
  cerca(t.L, 4, 1e-12, 'L');
  cerca(t.Lq, 3.2, 1e-12, 'Lq');
  cerca(t.W, 400, 1e-12, 'W');
  cerca(t.Wq, 320, 1e-12, 'Wq');
  cerca(t.percentilW(0.95), -Math.log(0.05) * 400, 1e-12, 'p95');
  assert.equal(mm1(0.02, 0.0125), null);
});

test('fórmulas: M/M/1/K tiende a M/M/1 cuando K es grande, y M/G/1 exponencial es M/M/1', () => {
  const a = mm1(0.01, 0.0125);
  const b = mm1k(0.01, 0.0125, 400);
  cerca(b.L, a.L, 1e-9, 'L');
  cerca(b.W, a.W, 1e-9, 'W');
  const c = mg1(0.01, 80, 1);
  cerca(c.Wq, a.Wq, 1e-12, 'Wq');
  // M/M/1/1 (sin cola): fórmula de pérdida de Erlang B con un servidor, a/(1+a).
  cerca(mm1k(0.01, 0.008, 1).pRechazo, 1.25 / 2.25, 1e-12, 'bloqueo');
  // Carga ofrecida exactamente 1: todos los estados son igual de probables.
  cerca(mm1k(0.01, 0.01, 4).pRechazo, 0.2, 1e-12, 'bloqueo con a = 1');
  // No se desborda con carga alta y K grande.
  assert.ok(Number.isFinite(mm1k(3, 1, 2000).L));
});

test('M/M/1 (ρ = 0,8): la simulación coincide con la teoría', () => {
  const e = esc({ horizonte: 2e8, calentamiento: 1e5 });
  const r = new PodUnico(e).correr();
  const t = teoriaPara(e);
  assert.equal(t.kendall, 'M/M/1');
  assert.equal(t.metodo, 'exacta');
  assert.ok(r.n > 1.9e6);
  cerca(r.rho, t.rho, 0.01, 'ρ');
  cerca(r.L, t.L, 0.03, 'L');
  cerca(r.Lq, t.Lq, 0.03, 'Lq');
  cerca(r.W, t.W, 0.03, 'W');
  cerca(r.Wq, t.Wq, 0.03, 'Wq');
  cerca(r.X, t.X, 0.01, 'X');
  cerca(r.p50, t.percentilW(0.5), 0.03, 'p50');
  cerca(r.p95, t.percentilW(0.95), 0.04, 'p95');
  cerca(r.p99, t.percentilW(0.99), 0.05, 'p99');
});

test('M/D/1: servicio constante, la espera es la mitad que en M/M/1 (Pollaczek-Khinchine)', () => {
  const e = esc({ servicio: { tipo: 'constante', valor: 80 }, horizonte: 1e8, calentamiento: 1e5 });
  const r = new PodUnico(e).correr();
  const t = teoriaPara(e);
  assert.equal(t.kendall, 'M/D/1');
  cerca(t.Wq, 160, 1e-12, 'Wq teórico');
  cerca(r.Wq, t.Wq, 0.03, 'Wq');
  cerca(r.L, t.L, 0.03, 'L');
});

test('M/G/1 con servicio Erlang-4 y con lognormal de CV 1,5', () => {
  for (const servicio of [{ tipo: 'erlang', k: 4, media: 80 }, { tipo: 'lognormal', media: 70, cv: 1.5 }]) {
    const e = esc({ servicio, horizonte: 3e8, calentamiento: 1e5 });
    const r = new PodUnico(e).correr();
    const t = teoriaPara(e);
    assert.equal(t.metodo, 'exacta');
    cerca(r.Wq, t.Wq, 0.04, `Wq con ${servicio.tipo}`);
    cerca(r.rho, t.rho, 0.01, `ρ con ${servicio.tipo}`);
  }
});

test('M/M/1/5 sobrecargado: probabilidad de rechazo y tiempos', () => {
  const e = esc({ servicio: { tipo: 'exponencial', media: 125 }, capacidadCola: 4, horizonte: 1e8 });
  const r = new PodUnico(e).correr();
  const t = teoriaPara(e);
  assert.equal(t.kendall, 'M/M/1/5');
  cerca(r.pRechazo, t.pRechazo, 0.02, 'P(rechazo)');
  cerca(r.L, t.L, 0.02, 'L');
  cerca(r.W, t.W, 0.02, 'W');
  cerca(r.rho, t.rho, 0.01, 'ρ');
  cerca(r.X, t.X, 0.01, 'X');
  assert.ok(r.maxEnSistema <= 5);
});

test('G/G/1: Kingman se usa como aproximación y queda cerca con carga alta', () => {
  const e = esc({
    llegadas: { tipo: 'erlang', k: 2, media: 100 },
    servicio: { tipo: 'uniforme', min: 60, max: 120 },
    horizonte: 1e8,
    calentamiento: 1e5,
  });
  const t = teoriaPara(e);
  assert.equal(t.metodo, 'aproximada');
  const r = new PodUnico(e).correr();
  cerca(r.Wq, t.Wq, 0.15, 'Wq (aproximado)');
});

test('teoría: reconoce los casos sin estado estable o sin fórmula', () => {
  assert.equal(teoriaPara(esc({ servicio: { tipo: 'exponencial', media: 125 } })).metodo, 'inestable');
  assert.equal(teoriaPara(esc({ servicio: { tipo: 'exponencial', media: 100 } })).metodo, 'inestable');
  assert.equal(teoriaPara(esc({ servicio: { tipo: 'uniforme', min: 10, max: 90 }, capacidadCola: 3 })).metodo, 'ninguna');
  const dd1 = teoriaPara(esc({ llegadas: { tipo: 'constante', valor: 10 }, servicio: { tipo: 'constante', valor: 10 } }));
  assert.equal(dd1.metodo, 'exacta');
  assert.equal(dd1.Wq, 0);
});

// ---------------------------------------------------------------------------
// 3. Invariantes y reproducibilidad
// ---------------------------------------------------------------------------

test('invariantes en cada evento: conservación, reloj monótono y estado coherente', () => {
  const m = new PodUnico(esc({ servicio: { tipo: 'lognormal', media: 90, cv: 2 }, capacidadCola: 6, horizonte: 2e6 }));
  let previo = 0;
  let pasos = 0;
  let paso;
  while ((paso = m.paso())) {
    pasos++;
    assert.ok(m.reloj >= previo, 'el reloj retrocedió');
    previo = m.reloj;
    assert.equal(m.llegadas, m.atendidas + m.rechazadas + m.enSistema, 'se perdió o se duplicó una petición');
    assert.ok(m.cola.length <= 6, 'la cola superó su capacidad');
    if (m.cola.length > 0) assert.ok(m.enServicio, 'hay cola con el pod libre');
    // En la lista siempre hay una próxima llegada, y un fin de servicio solo si el pod está ocupado.
    const tipos = m.sim.lista.ordenados().map((e) => e.tipo);
    assert.equal(tipos.filter((x) => x === 'llegada').length, 1);
    assert.equal(tipos.filter((x) => x === 'fin-servicio').length, m.enServicio ? 1 : 0);
  }
  assert.ok(pasos > 30000);
  assert.equal(m.reloj, 2e6);
  assert.equal(m.paso(), null);
});

test('ley de Little: L = λ·W y Lq = λ·Wq con los valores simulados', () => {
  const r = new PodUnico(esc({ servicio: { tipo: 'triangular', min: 20, moda: 60, max: 160 }, horizonte: 5e7 })).correr();
  cerca(r.L, r.lambdaEfectiva * r.W, 0.005, 'L = λW');
  cerca(r.Lq, r.lambdaEfectiva * r.Wq, 0.005, 'Lq = λWq');
  cerca(r.rho, r.lambdaEfectiva * r.S, 0.005, 'ρ = λ·E[S]');
});

test('reproducibilidad: misma semilla, misma huella; otra semilla, otra huella', () => {
  const a = new PodUnico(esc({ horizonte: 1e6 })).correr();
  const b = new PodUnico(esc({ horizonte: 1e6 })).correr();
  const c = new PodUnico(esc({ horizonte: 1e6, semilla: 7 })).correr();
  assert.equal(a.huella, b.huella);
  assert.equal(a.W, b.W);
  assert.equal(a.eventos, b.eventos);
  assert.notEqual(a.huella, c.huella);
  assert.notEqual(a.W, c.W);
});

test('números aleatorios comunes: cambiar el servicio no cambia las llegadas', () => {
  const instantes = (servicio) => {
    const m = new PodUnico(esc({ servicio, horizonte: 50000 }));
    const t = [];
    let paso;
    while ((paso = m.paso())) if (paso.evento.tipo === 'llegada') t.push(paso.evento.t);
    return t;
  };
  const a = instantes({ tipo: 'exponencial', media: 80 });
  const b = instantes({ tipo: 'lognormal', media: 60, cv: 2 });
  assert.ok(a.length > 400);
  assert.deepEqual(a, b);
});

test('calentamiento: descarta las observaciones del arranque', () => {
  const sin = new PodUnico(esc({ horizonte: 1e6 })).correr();
  const con = new PodUnico(esc({ horizonte: 1e6, calentamiento: 2e5 })).correr();
  assert.equal(con.duracionObservada, 8e5);
  assert.ok(con.n < sin.n);
  assert.equal(con.llegadas, sin.llegadas); // la traza es la misma; cambia qué se mide
  assert.ok(con.conserva);
});

test('escenario: valida los campos y completa los que faltan', () => {
  const e = validarEscenario({ modelo: 'pod-unico', llegadas: { tipo: 'constante', valor: 5 } });
  assert.equal(e.servicio.tipo, 'exponencial');
  assert.equal(e.capacidadCola, null);
  const malos = [
    null,
    { modelo: 'otro' },
    { semilla: 1.5 },
    { semilla: -1 },
    { horizonte: 0 },
    { calentamiento: 3600000 },
    { capacidadCola: -1 },
    { capacidadCola: 2.5 },
    { llegadas: { tipo: 'exponencial', media: -1 } },
  ];
  for (const m of malos) assert.throws(() => validarEscenario(m && { ...escenarioPorDefecto(), ...m }), Error, JSON.stringify(m));
});
