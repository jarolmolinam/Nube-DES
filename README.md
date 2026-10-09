# DES en la nube

Applets web para el módulo de simulación de eventos discretos (DES) del curso
Modelos y Simulación. Cada applet modela una pieza de una infraestructura nativa
de nube (pod, réplicas, nodos, HPA) y deja ver el motor por dentro: reloj, lista
de eventos futuros, bitácora, métricas y verificación contra la teoría.

No necesita nube, Docker ni servidor: cada applet es un archivo HTML que se abre
con doble clic.

## Qué hay hoy

| Paso | Contenido | Estado |
|---|---|---|
| 1 | Núcleo del motor: reloj, lista de eventos, azar con semilla, distribuciones, estadísticas | Hecho, con pruebas |
| 2 | Applet 1: un pod como cola de un servidor (M/M/1, M/G/1, G/G/1, cola limitada) | Hecho, verificado |
| 3 | Réplicas y Service: M/M/c, reglas de balanceo | Hecho en el applet 2 |
| 4 | Cadena de microservicios y trazas por petición | Hecho en el applet 2 |
| 5 | Nodo con cupo, requests y limits, contención de CPU, ciclo de vida del pod | Hecho en el applet 2 (un solo nodo) |
| 6 | HPA y pico de tráfico | Hecho en el applet 2 |
| 7 | Experimentos: réplicas de la corrida, intervalos de confianza, exportar CSV | Pendiente |
| 8 | Editor libre de bloques | Pendiente |
| 9 | Validación cruzada con SimPy en Colab leyendo el mismo JSON | Pendiente |
| 10 | Escenarios y retos de clase | Pendiente |

## Usar los applets

Abre `dist/index.html` en cualquier navegador y elige el applet, o abre
directamente `dist/pod-unico.html` o `dist/cadena.html`. Funcionan sin conexión;
con conexión cargan además la tipografía IBM Plex.

Para publicarlos, sube la carpeta `dist/` a GitHub Pages o a cualquier
alojamiento de archivos estáticos.

### Applet 2: una cadena de microservicios sobre un nodo

Sigue la guía de clase "Acoplamiento de modelos DES a infraestructuras nativas
de nube": la cadena auth → catálogo → pagos del ejemplo 3.6 (λ = 40 pet/s;
8, 35 y 20 ms), la regla del HPA de la sección 2.7 y el experimento de pico de
la sesión 3.

| Bloque | Qué muestra |
|---|---|
| Llegadas | Distribución del tiempo entre llegadas y, opcional, un pico de tráfico |
| Servicio (uno por microservicio) | Imagen, regla del balanceador, cola, pods con su estado, réplicas (se cambian en vivo) |
| Métricas (debajo de cada servicio) | Factor de utilización ρ, CPU frente al request, estancia y peticiones atendidas |
| Nodo | CPU y RAM reservadas por los requests; se pone rojo y bloquea nuevas réplicas cuando no hay cupo |
| HPA | El cálculo ⌈réplicas × uso / objetivo⌉ con los números del momento y cuántas réplicas faltan |

Los seis escenarios de ejemplo están pensados como una secuencia de clase:
catálogo saturado, dimensionado a mano (se verifica contra Jackson), HPA
aplicando, pico de tráfico, nodo sin cupo y contención por limits sin respaldo.

## Estructura

```
src/motor/            el motor, sin nada de interfaz ni de Kubernetes
  aleatorio.js          generador con semilla y flujos por nombre
  distribuciones.js     exponencial, constante, uniforme, triangular, Erlang,
                        lognormal, Weibull y empírica
  lista-eventos.js      lista de eventos futuros (montículo binario)
  estadisticas.js       promedios por observación y ponderados por tiempo
  simulador.js          reloj, agenda y ciclo de ejecución
src/modelos/
  pod-unico.js          el modelo del applet 1
  cadena.js             el modelo del applet 2
  teoria-colas.js       M/M/1, M/M/1/K, M/M/c (Erlang C), Pollaczek-Khinchine,
                        Kingman y red de Jackson
pruebas/              pruebas automáticas (node --test)
web/comun/            estilos y piezas de interfaz que comparten los applets
web/pod-unico/        plantilla, estilos y código del applet 1
web/cadena/           plantilla, estilos y código del applet 2
web/index.html        portada
construir.mjs         arma cada applet de dist/ en un solo archivo
dist/                 lo que se entrega a los estudiantes
```

El motor no conoce la interfaz. Por eso se puede probar solo, en Node, y el
mismo código corre después dentro del navegador.

## Probar y armar

Se necesita Node.js 20 o posterior. No hay dependencias que instalar.

```
npm test         corre las 61 pruebas (unos 20 segundos)
npm run build    regenera dist/
```

Después de cambiar algo en `src/` o en `web/`, corre las dos órdenes en ese
orden: primero las pruebas, luego el armado.

## Cómo está verificado

Las pruebas siguen la misma escalera que conviene enseñar para depurar un
modelo:

1. **Las piezas por separado.** Cada distribución reproduce su media y su
   varianza teóricas; el generador pasa una prueba ji-cuadrado; la lista de
   eventos entrega en orden.
2. **Trazas que se siguen a mano.** Tres casos deterministas (D/D/1) cuyo
   resultado se calcula en el tablero, incluido uno con rechazos donde importa
   el orden de desempate entre eventos simultáneos.
3. **Teoría de colas.** M/M/1, M/D/1, M/G/1 y M/M/1/K contra sus fórmulas
   exactas. Con dos millones de peticiones el error queda por debajo del 1 %.
4. **Invariantes en cada evento.** Conservación de peticiones, reloj que nunca
   retrocede, cola dentro de su capacidad, ley de Little.
5. **Reproducibilidad.** La misma semilla produce la misma huella de corrida,
   en Node y en el navegador.

En el applet 2 la escalera es la misma, con sus propios peldaños:

- **A mano:** una cadena de dos servicios con red y reparto por turnos; un limit
  de 500m que duplica el tiempo de servicio; dos réplicas que se reparten un
  núcleo cuando el nodo no da abasto.
- **Teoría:** una réplica doble con cola compartida contra Erlang C, reparto
  aleatorio contra M/M/1 por réplica, y la cadena completa contra la red de
  Jackson.
- **Invariantes:** toda petición está en una cola, en servicio o en la red; el
  nodo nunca se sobreasigna; la CPU entregada es igual a la que recibieron las
  peticiones; ningún servicio se queda sin réplicas listas.
- **HPA:** la regla aislada con el ejemplo de la guía (2 réplicas al 90 % con
  objetivo 60 % dan 3) y la lección de la sesión 3: saturado al 100 %, la
  primera revisión solo pide una réplica más.

## El escenario es un JSON

```json
{
  "version": 1,
  "modelo": "pod-unico",
  "nombre": "M/M/1 estable (ρ = 0,8)",
  "unidadTiempo": "ms",
  "semilla": 2026,
  "llegadas": { "tipo": "exponencial", "media": 100 },
  "servicio": { "tipo": "exponencial", "media": 80 },
  "capacidadCola": null,
  "calentamiento": 0,
  "horizonte": 3600000
}
```

Un estudiante entrega este texto y la huella que le dio su corrida. Al pegarlo
en el applet y pulsar "Hasta el final" debe salir la misma huella: con este
escenario, `5050237c` tras 71.901 eventos.

La huella resume la secuencia de eventos con seis decimales de precisión. Se
comprobó igual en Node y en Chromium; otro motor de JavaScript podría diferir en
el último decimal de un logaritmo y cambiarla.

El applet 2 usa el mismo esquema con `"modelo": "cadena"`: una lista de
`servicios` (cada uno con su distribución, réplicas, `cpuRequest`, `cpuLimit` y
`ramRequest`), el `nodo`, el `hpa`, el `balanceo` y un `pico` opcional. Basta
escribir lo que cambia; lo demás toma los valores del ejemplo de la guía.

Cambiar réplicas o el modo del HPA desde los bloques durante la corrida es una
intervención manual: queda anotada en la huella y el applet avisa que esa
corrida ya no se repite solo con el JSON.

## Simplificaciones declaradas del applet 2

- Un solo nodo. La memoria decide si una réplica cabe, pero no cambia su
  rendimiento (la misma simplificación de PerfSim).
- Cada réplica atiende una petición a la vez. El limit de CPU alarga el
  servicio: tiempo = trabajo / min(1, limit).
- Si el uso real supera los núcleos del nodo, la CPU se reparte en proporción a
  los requests sin dar a nadie más de lo que pide. Es una versión simplificada
  de los `cpu.shares` de Linux; no modela el periodo de 100 ms del planificador.
- El HPA usa el promedio de CPU del periodo, la tolerancia del 10 % y la ventana
  de estabilización para reducir. No modela las reglas finas de Kubernetes para
  pods recién creados.
- La red es un retardo fijo por salto. El pico cambia la tasa de golpe y el
  intervalo se muestrea con la tasa vigente al agendarlo.
- El applet se verifica contra teoría, pero no se valida contra un sistema
  real: eso sigue siendo el laboratorio con Docker de la guía, o trazas ya
  medidas cargadas como distribución empírica.

## Simplificaciones declaradas del applet 1

- Un pod atiende una petición a la vez. La concurrencia dentro del contenedor
  llega con las réplicas y los limits de CPU.
- La cola es FIFO y el rechazo es inmediato cuando está llena.
- No hay red: el tiempo de respuesta es espera más servicio.
- Si dos eventos caen en el mismo instante, primero se ejecuta el fin de
  servicio y luego la llegada.
