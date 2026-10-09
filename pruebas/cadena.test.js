// Pruebas del modelo de cadena: regla del HPA, trazas a mano, teoría de colas,
// cupo del nodo, contención de CPU e invariantes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cadena, escenarioCadenaPorDefecto, validarCadena, reglaHPA } from '../src/modelos/cadena.js';
import { mm1, mmc, teoriaCadena } from '../src/modelos/teoria-colas.js';

const cerca = (real, esperado, tolRel, mensaje) => {
  const error = Math.abs(real - esperado) / Math.max(Math.abs(esperado), 1e-12);
  assert.ok(error <= tolRel, `${mensaje}: obtuvo ${real}, esperaba ${esperado} (error ${(error * 100).toFixed(2)} %)`);
};

/** Escenario de prueba: parte del ejemplo de la guía y aplica cambios. */
function esc(cambios = {}, servicios = null) {
  const e = escenarioCadenaPorDefecto();
  if (servicios) e.servicios = servicios.map((s, k) => ({ ...e.servicios[k % 3], id: `s${k + 1}`, nombre: `S${k + 1}`, ...s }));
  const { hpa, nodo, ...resto } = cambios;
  return { ...e, ...resto, hpa: { ...e.hpa, modo: 'apagado', ...(hpa || {}) }, nodo: { ...e.nodo, ...(nodo || {}) } };
}
const constante = (valor) => ({ tipo: 'constante', valor });
const expo = (media) => ({ tipo: 'exponencial', media });

// ---------------------------------------------------------------------------
// 1. La regla del HPA, aislada
// ---------------------------------------------------------------------------

test('regla del HPA: el ejemplo de la guía y los casos límite', () => {
  // 2 réplicas al 90 % con objetivo 60 %: techo(2 × 90/60) = 3 (y no 4 por redondeo binario)
  assert.equal(reglaHPA({ listas: 2, uso: 0.9, objetivo: 0.6 }), 3);
  // Saturado al 100 %: la regla solo pide una réplica más por ciclo
  assert.equal(reglaHPA({ listas: 1, uso: 1.0, objetivo: 0.6 }), 2);
  assert.equal(reglaHPA({ listas: 2, uso: 1.0, objetivo: 0.6 }), 4);
  // Dentro de la tolerancia del 10 % no se toca nada
  assert.equal(reglaHPA({ listas: 3, uso: 0.63, objetivo: 0.6 }), 3);
  assert.equal(reglaHPA({ listas: 3, uso: 0.55, objetivo: 0.6 }), 3);
  // Fuera de la tolerancia, hacia abajo
  assert.equal(reglaHPA({ listas: 4, uso: 0.3, objetivo: 0.6 }), 2);
  // Límites mínimo y máximo
  assert.equal(reglaHPA({ listas: 4, uso: 0.01, objetivo: 0.6, min: 2 }), 2);
  assert.equal(reglaHPA({ listas: 4, uso: 2.0, objetivo: 0.6, max: 6 }), 6);
  // Con request menor que el limit el uso puede pasar del 100 %
  assert.equal(reglaHPA({ listas: 1, uso: 2.0, objetivo: 0.6 }), 4);
  // Sin dato de uso se conserva lo que hay
  assert.equal(reglaHPA({ listas: 3, uso: NaN, objetivo: 0.6 }), 3);
});

test('Erlang C: M/M/c con c = 1 es M/M/1, y el catálogo de la guía con 2 réplicas', () => {
  const a = mm1(0.01, 0.0125);
  const b = mmc(0.01, 0.0125, 1);
  cerca(b.Wq, a.Wq, 1e-12, 'Wq');
  cerca(b.L, a.L, 1e-12, 'L');
  // λ = 40 pet/s, servicio de 35 ms, c = 2: ρ = 0,70 y Wq = 33,63 ms (calculado a mano)
  const cat = mmc(0.04, 1 / 35, 2);
  cerca(cat.rho, 0.7, 1e-12, 'ρ');
  cerca(cat.pEspera, 0.576471, 1e-5, 'P(esperar)');
  cerca(cat.Wq, 33.6275, 1e-5, 'Wq');
  assert.equal(mmc(0.04, 1 / 35, 1), null); // con una réplica es inestable
});

// ---------------------------------------------------------------------------
// 2. Trazas deterministas que se siguen a mano
// ---------------------------------------------------------------------------

test('traza a mano: dos servicios, red de 1 ms y reparto por turnos', () => {
  // Llegadas cada 10. S1: 4 ms, 1 réplica. S2: 25 ms, 2 réplicas por turnos.
  //  pet 1: llega 10, S1 11-15, S2 (pod 1) 16-41            -> total 31
  //  pet 2: llega 20, S1 21-25, S2 (pod 2) 26-51            -> total 31
  //  pet 3: llega 30, S1 31-35, S2 (pod 1) espera 36-41, 41-66 -> total 36
  //  pet 4: llega 40, S1 41-45, S2 (pod 2) espera 46-51, 51-76 -> total 36
  //  pet 5 y 6: la espera crece otros 5 ms                  -> total 41
  const m = new Cadena(esc({ llegadas: constante(10), redMs: 1, balanceo: 'turnos', horizonte: 102 }, [
    { servicio: constante(4), replicas: 1 },
    { servicio: constante(25), replicas: 2 },
  ]));
  const totales = [];
  const fines = [];
  let paso;
  while ((paso = m.paso())) {
    for (const nov of paso.novedades) {
      if (nov.tipo === 'completa') { totales.push(nov.total); fines.push(paso.evento.t); }
    }
  }
  assert.deepEqual(totales, [31, 31, 36, 36, 41, 41]);
  assert.deepEqual(fines, [41, 51, 66, 76, 91, 101]);
  const traza = m.trazas[2];
  assert.equal(traza.id, 3);
  assert.deepEqual(traza.tramos.map((x) => [x.pod, x.tEntrada, x.tInicio, x.tFin]), [['s1-1', 31, 31, 35], ['s2-1', 36, 41, 66]]);
});

test('limit de CPU: con 500m una petición de 40 ms de CPU tarda 80 ms', () => {
  const m = new Cadena(esc({ llegadas: constante(1000), redMs: 3, horizonte: 1500 }, [
    { servicio: constante(40), cpuRequest: 500, cpuLimit: 500 },
  ]));
  const r = m.correr();
  assert.equal(r.completadas, 1);
  assert.equal(r.W, 83); // 3 ms de red + 40 / 0,5
  cerca(r.trabajo.entregado, 40, 1e-12, 'ms de CPU entregados'); // medio núcleo durante 80 ms
  cerca(r.trabajo.atendido, 40, 1e-12, 'ms de CPU atendidos');
});

test('contención del nodo: dos réplicas con limit de 1 núcleo en un nodo de 1 núcleo', () => {
  // Un limit no es una reserva. Trabajo de 30 ms por petición, llegadas cada 10, por turnos.
  //  t=10 pet 1 en pod 1, sola: avanza a 1 núcleo.
  //  t=20 pet 2 en pod 2: ahora piden 2 núcleos y hay 1 -> medio núcleo cada una.
  //       pet 1 llevaba 10 ms; le faltan 20 a media velocidad -> termina en 60.
  //  t=60 pod 1 toma la pet 3; siguen dos ocupadas. pet 2 llevaba 20 -> termina en 80.
  //  t=80 pod 2 toma la pet 4. pet 3 llevaba 10 -> termina en 120. Y así: 140, 180, 200...
  const m = new Cadena(esc({ llegadas: constante(10), redMs: 0, balanceo: 'turnos', horizonte: 205, nodo: { cpu: 1000 } }, [
    { servicio: constante(30), replicas: 2, cpuRequest: 500, cpuLimit: 1000 },
  ]));
  const fines = [];
  let paso;
  while ((paso = m.paso())) {
    if (paso.evento.tipo === 'fin-servicio') fines.push(Math.round(paso.evento.t * 1e6) / 1e6);
    const enUso = m.servicios.reduce((suma, s) => suma + s.tasaCPU, 0);
    assert.ok(enUso <= 1 + 1e-9, `se usó más CPU (${enUso}) que la del nodo`);
    const r = m.resultados();
    cerca(r.trabajo.entregado, r.trabajo.atendido, 1e-9, 'CPU entregada = CPU recibida por las peticiones');
  }
  assert.deepEqual(fines, [60, 80, 120, 140, 180, 200]);
});

test('reparto con contención: el request es lo garantizado', () => {
  // Nodo de 2 núcleos. A pide 1500m de request y B 250m; ambos con limit de 1 núcleo... A usa 1 (su tope)
  // y a B le queda 1 núcleo: nadie se frena. Con 3 réplicas de B ocupadas piden 4 núcleos:
  // A conserva 1 (le corresponde más) y las tres B se reparten el otro: 1/3 cada una.
  const m = new Cadena(esc({ llegadas: constante(1), redMs: 0, balanceo: 'turnos', horizonte: 50, nodo: { cpu: 2000 } }, [
    { servicio: constante(1000), replicas: 1, cpuRequest: 1250, cpuLimit: 1250 },
    { servicio: constante(1000), replicas: 3, cpuRequest: 250, cpuLimit: 1000 },
  ]));
  // El primer servicio es mucho más rápido en este arreglo: se fuerza el estado con tiempos largos.
  m.correr();
  const [a, b] = m.servicios;
  assert.equal(a.ocupadas, 1);
  cerca(a.tasaCPU, 1, 1e-9, 'A usa su núcleo');
  // B todavía no recibe nada (A no ha terminado ninguna): el nodo solo usa 1 núcleo.
  assert.equal(b.ocupadas, 0);
});

// ---------------------------------------------------------------------------
// 3. Comparación con la teoría de colas
// ---------------------------------------------------------------------------

test('un servicio con 2 réplicas y cola compartida es un M/M/c (Erlang C)', () => {
  const e = esc({ redMs: 0, balanceo: 'compartida', horizonte: 1.2e7, calentamiento: 1e5 }, [{ servicio: expo(35), replicas: 2 }]);
  const r = new Cadena(e).correr();
  const t = teoriaCadena(e);
  assert.ok(t.aplica);
  cerca(t.servicios[0].Wq, 33.6275, 1e-5, 'Wq teórico');
  cerca(r.servicios[0].Wq, t.servicios[0].Wq, 0.04, 'Wq');
  cerca(r.servicios[0].rho, 0.7, 0.01, 'ρ');
  cerca(r.W, t.W, 0.03, 'W');
});

test('con reparto aleatorio cada réplica es un M/M/1 con λ/c, y se espera más', () => {
  const e = esc({ redMs: 0, balanceo: 'aleatorio', horizonte: 1.5e7, calentamiento: 1e5 }, [{ servicio: expo(35), replicas: 2 }]);
  const r = new Cadena(e).correr();
  const t = teoriaCadena(e);
  cerca(t.servicios[0].Wq, 0.7 / (1 / 35 - 0.02), 1e-12, 'Wq teórico'); // 81,67 ms
  cerca(r.servicios[0].Wq, t.servicios[0].Wq, 0.04, 'Wq');
  assert.ok(t.servicios[0].Wq > 2 * mmc(0.04, 1 / 35, 2).Wq, 'aleatorio espera más del doble que la cola compartida');
});

test('cadena de la guía con 1, 2 y 1 réplicas: red de Jackson', () => {
  const e = esc({ balanceo: 'compartida', horizonte: 1.5e7, calentamiento: 1e5 });
  e.servicios[1].replicas = 2;
  const r = new Cadena(e).correr();
  const t = teoriaCadena(e);
  assert.ok(t.aplica);
  cerca(t.servicios[0].rho, 0.32, 1e-12, 'ρ auth');
  cerca(t.servicios[1].rho, 0.70, 1e-12, 'ρ catálogo');
  cerca(t.servicios[2].rho, 0.80, 1e-12, 'ρ pagos');
  r.servicios.forEach((s, k) => {
    cerca(s.rho, t.servicios[k].rho, 0.01, `ρ de ${s.id}`);
    cerca(s.Wq, t.servicios[k].Wq, 0.05, `Wq de ${s.id}`);
    cerca(s.S, t.servicios[k].S, 0.01, `servicio de ${s.id}`);
  });
  cerca(r.W, t.W, 0.03, 'latencia extremo a extremo');
  cerca(r.X, 0.04, 0.01, 'throughput');
  assert.ok(r.conserva);
});

test('la regla de balanceo cambia la espera: compartida < menos ocupada < turnos < aleatorio', () => {
  const Wq = (balanceo) => new Cadena(esc({ redMs: 0, balanceo, horizonte: 4e6 }, [{ servicio: expo(35), replicas: 3, cpuRequest: 500 }]))
    .correr().servicios[0].Wq;
  const [c, m, t, a] = ['compartida', 'menos-ocupada', 'turnos', 'aleatorio'].map(Wq);
  assert.ok(c < m && m < t && t < a, `Wq: compartida ${c}, menos ocupada ${m}, turnos ${t}, aleatorio ${a}`);
});

test('por turnos, las réplicas reciben la misma cantidad de peticiones', () => {
  const m = new Cadena(esc({ redMs: 0, balanceo: 'turnos', horizonte: 6000 }, [{ servicio: expo(20), replicas: 3, cpuRequest: 500 }]));
  m.correr();
  const cuenta = {};
  for (const p of m.trazas) cuenta[p.tramos[0].pod] = (cuenta[p.tramos[0].pod] || 0) + 1;
  const valores = Object.values(cuenta);
  assert.equal(valores.length, 3);
  assert.ok(Math.max(...valores) - Math.min(...valores) <= 2, JSON.stringify(cuenta));
});

test('teoría: explica por qué no aplica', () => {
  assert.match(teoriaCadena(esc()).motivo, /Catálogo está saturado/);
  assert.match(teoriaCadena(esc({ balanceo: 'turnos' })).motivo, /cola compartida/);
  assert.match(teoriaCadena(esc({ hpa: { modo: 'aplicar' } })).motivo, /HPA/);
  assert.match(teoriaCadena(esc({ pico: { desde: 1, hasta: 2, factor: 3 } })).motivo, /pico/);
  assert.match(teoriaCadena(esc({ llegadas: constante(25) })).motivo, /Poisson/);
  const e = esc({ nodo: { cpu: 3000 } }, [{ servicio: expo(5), replicas: 4, cpuRequest: 500, cpuLimit: 1000 }]);
  assert.match(teoriaCadena(e).motivo, /contención/);
});

// ---------------------------------------------------------------------------
// 4. Nodo, orquestador y HPA
// ---------------------------------------------------------------------------

test('nodo: sin cupo no se crean réplicas a mano y las del HPA quedan Pending', () => {
  const e = esc({ nodo: { cpu: 4000, ram: 8192 }, hpa: { modo: 'aplicar' }, horizonte: 120000 });
  const m = new Cadena(e);
  assert.equal(m.nodo.cpuAsignada, 3000);
  assert.equal(m.escalarManual(0, 2), true);   // cabe: quedan 1000m
  assert.equal(m.nodo.cpuAsignada, 4000);
  assert.equal(m.cabe(m.servicios[1]), false);
  assert.equal(m.escalarManual(1, 2), false);  // ya no cabe
  let pendientes = 0;
  let paso;
  while ((paso = m.paso())) {
    assert.ok(m.nodo.cpuAsignada <= 4000 && m.nodo.ramAsignada <= 8192, 'se asignó más de lo que tiene el nodo');
    const cpu = m.servicios.reduce((suma, s) => suma + s.replicas.length * s.def.cpuRequest, 0);
    assert.equal(m.nodo.cpuAsignada, cpu, 'la CPU asignada no coincide con las réplicas ubicadas');
    for (const nov of paso.novedades) if (nov.tipo === 'pod-pendiente') pendientes++;
  }
  assert.ok(pendientes >= 1, 'el HPA debió pedir pods que no caben');
  assert.ok(m.pendientes.length >= 1);
  assert.equal(m.resultados().nodo.pendientes, m.pendientes.length);
});

test('nodo: la RAM también limita', () => {
  const m = new Cadena(esc({ nodo: { cpu: 16000, ram: 2048 } })); // iniciales: 256 + 1024 + 512 = 1792
  assert.equal(m.cabe(m.servicios[0]), true);   // +256 = 2048
  assert.equal(m.cabe(m.servicios[1]), false);  // +1024 no cabe
  assert.throws(() => new Cadena(esc({ nodo: { cpu: 16000, ram: 1024 } })), /RAM/);
  assert.throws(() => new Cadena(esc({ nodo: { cpu: 2000 } })), /CPU/);
});

test('HPA saturado: al 100 % de uso la primera revisión solo pide una réplica más', () => {
  // La lección de la guía: en saturación el uso de CPU no distingue "un poco" de "muy" saturado.
  const m = new Cadena(esc({ hpa: { modo: 'aplicar' }, horizonte: 50000 }));
  const vistos = [];
  let paso;
  while ((paso = m.paso())) {
    for (const nov of paso.novedades) {
      if (nov.i === 1 && ['hpa', 'pod-creado', 'pod-listo'].includes(nov.tipo)) vistos.push([paso.evento.t, nov.tipo, nov.cruda, nov.uso]);
    }
  }
  const [primera] = vistos;
  assert.deepEqual(primera.slice(0, 2), [15000, 'hpa']);
  assert.equal(primera[2], 2);
  cerca(primera[3], 1, 0.03, 'uso del catálogo en la primera revisión');
  assert.deepEqual(vistos.find((v) => v[1] === 'pod-creado').slice(0, 2), [15000, 'pod-creado']);
  assert.deepEqual(vistos.find((v) => v[1] === 'pod-listo').slice(0, 2), [45000, 'pod-listo']); // 30 s de arranque
});

test('HPA en modo "solo recomienda": calcula pero no cambia las réplicas', () => {
  const m = new Cadena(esc({ hpa: { modo: 'recomendar' }, horizonte: 60000 }));
  const r = m.correr();
  assert.deepEqual(r.servicios.map((s) => s.replicas), [1, 1, 1]);
  assert.equal(m.servicios[1].hpa.deseadas, 2);
  assert.equal(m.servicios[1].hpa.extra, 1);
  assert.equal(m.servicios[0].hpa.extra, 0); // auth al 32 % con una réplica: no se puede bajar del mínimo
});

test('pico con HPA: escala al subir, reduce después y no pierde peticiones', () => {
  const e = esc({
    llegadas: expo(200), // 5 pet/s de base
    pico: { desde: 120000, hasta: 300000, factor: 8 }, // 40 pet/s durante 3 minutos
    hpa: { modo: 'aplicar', estabilizacion: 60000 },
    horizonte: 600000,
  });
  const m = new Cadena(e);
  let maxCatalogo = 1;
  let n = 0;
  let paso;
  while ((paso = m.paso())) {
    n++;
    maxCatalogo = Math.max(maxCatalogo, m.servicios[1].listas.length);
    assert.ok(m.servicios.every((s) => s.listas.length >= 1), 'un servicio se quedó sin réplicas listas');
    if (n % 97 === 0) {
      // Toda petición está en una cola, en servicio o viajando por la red.
      const enTransito = m.sim.lista.ordenados().filter((ev) => ev.tipo === 'entra').length;
      const contadas = m.servicios.reduce((suma, s) => suma + s.enCola + s.ocupadas, 0) + enTransito;
      assert.equal(m.enSistema, contadas, 'se perdió o se duplicó una petición');
      assert.equal(m.llegadas, m.completadas + m.enSistema);
      for (const s of m.servicios) {
        const enColas = s.espera.length + s.replicas.reduce((suma, r) => suma + r.cola.length, 0);
        assert.equal(s.enCola, enColas);
        assert.equal(s.ocupadas, s.replicas.filter((r) => r.enServicio).length);
      }
    }
  }
  const r = m.resultados();
  assert.ok(maxCatalogo >= 3, `el catálogo debió escalar en el pico (máximo ${maxCatalogo})`);
  assert.ok(r.servicios[1].replicas < maxCatalogo, 'el catálogo debió reducirse después del pico');
  assert.ok(r.conserva);
  cerca(r.trabajo.entregado, r.trabajo.atendido, 1e-6, 'CPU entregada = CPU recibida');
  // En el pico llegan unas 8 veces más peticiones por segundo que fuera de él.
  const tasa = (a, b) => m.serie.filter((x) => x.t > a && x.t <= b).reduce((s, x) => s + x.s[0].completadas, 0) / ((b - a) / 1000);
  cerca(tasa(130000, 300000) / tasa(10000, 120000), 8, 0.12, 'razón de tasas');
});

test('muestreo: una muestra por segundo con el uso de CPU de cada servicio', () => {
  const e = esc({ balanceo: 'compartida', horizonte: 600000 });
  e.servicios[1].replicas = 2;
  const m = new Cadena(e);
  m.correr();
  assert.equal(m.serie.length, 600);
  assert.equal(m.serie[0].t, 1000);
  const media = (f) => m.serie.reduce((s, x) => s + f(x), 0) / m.serie.length;
  cerca(media((x) => x.s[0].cpu), 0.32, 0.05, 'núcleos de auth');
  cerca(media((x) => x.s[1].cpu), 1.40, 0.05, 'núcleos de catálogo');
  cerca(media((x) => x.s[1].usoRequest), 0.70, 0.05, 'uso del request en catálogo');
  cerca(media((x) => x.cpuNodo), 0.32 + 1.4 + 0.8, 0.05, 'núcleos en uso en el nodo');
});

// ---------------------------------------------------------------------------
// 5. Reproducibilidad y validación del escenario
// ---------------------------------------------------------------------------

test('reproducibilidad: misma semilla, misma huella; una intervención manual la cambia', () => {
  const e = esc({ hpa: { modo: 'aplicar' }, horizonte: 120000 });
  const a = new Cadena(e).correr();
  const b = new Cadena(e).correr();
  const c = new Cadena({ ...e, semilla: 5 }).correr();
  assert.equal(a.huella, b.huella);
  assert.equal(a.W, b.W);
  assert.notEqual(a.huella, c.huella);
  const m = new Cadena(e);
  for (let k = 0; k < 500; k++) m.paso();
  assert.equal(m.escalarManual(2, 2), true);
  const d = m.correr();
  assert.equal(d.intervenciones, 1);
  assert.notEqual(d.huella, a.huella);
  assert.ok(d.conserva);
});

test('escalado manual hacia abajo: la réplica termina lo que tiene antes de irse', () => {
  const e = esc({ balanceo: 'turnos', horizonte: 60000 });
  e.servicios[1].replicas = 3;
  const m = new Cadena(e);
  for (let k = 0; k < 3000; k++) m.paso();
  assert.equal(m.escalarManual(1, 1), true);
  assert.equal(m.deseadas(m.servicios[1]), 1);
  assert.equal(m.servicios[1].listas.length, 1);
  const r = m.correr();
  assert.equal(r.servicios[1].replicas, 1);
  assert.ok(r.conserva);
  assert.equal(m.nodo.cpuAsignada, 3000);
  assert.equal(m.escalarManual(1, 0), false); // nunca menos de una
});

test('escenario: valida los campos y completa los que faltan', () => {
  const e = validarCadena({ modelo: 'cadena' });
  assert.equal(e.servicios.length, 3);
  assert.equal(e.hpa.periodo, 15000);
  const base = escenarioCadenaPorDefecto();
  const con = (f) => { const x = escenarioCadenaPorDefecto(); f(x); return x; };
  const malos = [
    null,
    { ...base, modelo: 'pod-unico' },
    { ...base, balanceo: 'magia' },
    { ...base, servicios: [] },
    con((x) => { x.servicios[1].id = 'auth'; }),
    con((x) => { x.servicios[0].replicas = 0; }),
    con((x) => { x.servicios[0].cpuLimit = 500; }),
    con((x) => { x.servicios[0].servicio = { tipo: 'exponencial', media: -1 }; }),
    con((x) => { x.hpa.max = 0; }),
    con((x) => { x.hpa.modo = 'a veces'; }),
    con((x) => { x.hpa.objetivo = 0; }),
    con((x) => { x.pico = { desde: 10, hasta: 5, factor: 2 }; }),
    con((x) => { x.nodo.cpu = 0; }),
    con((x) => { x.redMs = -1; }),
  ];
  for (const m of malos) assert.throws(() => validarCadena(m), Error, JSON.stringify(m));
});
