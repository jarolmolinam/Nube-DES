// Arma cada applet en un solo archivo HTML que funciona con doble clic.
//
// Los módulos del motor usan import/export para poder probarse con Node, pero
// un navegador no carga módulos desde file://. Por eso aquí se les quitan las
// líneas import/export y se pegan, en orden, dentro de la plantilla del applet,
// junto con los estilos y el código de interfaz comunes.
//
//   node construir.mjs                     -> dist/<applet>.html y dist/index.html
//   node construir.mjs --fragmentos <dir>  -> además, cada applet sin <html>/<head>/<body>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(fileURLToPath(import.meta.url));
const leer = (ruta) => readFileSync(join(raiz, ruta), 'utf8');

const MOTOR = [
  'src/motor/aleatorio.js',
  'src/motor/distribuciones.js',
  'src/motor/lista-eventos.js',
  'src/motor/estadisticas.js',
  'src/motor/simulador.js',
  'src/modelos/teoria-colas.js',
];

const APPLETS = [
  { nombre: 'pod-unico', modulos: [...MOTOR, 'src/modelos/pod-unico.js'] },
  { nombre: 'cadena', modulos: [...MOTOR, 'src/modelos/cadena.js'] },
];

function sinModulos(codigo, ruta) {
  const salida = codigo
    .split('\n')
    .filter((linea) => !/^import\s.*from\s+['"].*['"];?\s*$/.test(linea))
    .map((linea) => linea.replace(/^export\s+/, ''))
    .join('\n');
  if (/^\s*(import|export)\s/m.test(salida)) {
    throw new Error(`${ruta}: quedó un import/export que el armado no sabe quitar (deben ir en una sola línea).`);
  }
  return `// ---- ${ruta} ----\n${salida}`;
}

function documento(cabeza, cuerpo) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${cabeza.trim()}
</head>
<body>
${cuerpo.trim()}
</body>
</html>
`;
}

const iFragmentos = process.argv.indexOf('--fragmentos');
const dirFragmentos = iFragmentos > -1 ? process.argv[iFragmentos + 1] : null;
mkdirSync(join(raiz, 'dist'), { recursive: true });
if (dirFragmentos) mkdirSync(dirFragmentos, { recursive: true });

for (const applet of APPLETS) {
  const plantilla = leer(`web/${applet.nombre}/plantilla.html`);
  const estilos = `${leer('web/comun/base.css')}\n${leer(`web/${applet.nombre}/estilos.css`)}`;
  const codigo = [
    ...applet.modulos.map((m) => sinModulos(leer(m), m)),
    `// ---- web/comun/base.js ----\n${leer('web/comun/base.js')}`,
    `// ---- web/${applet.nombre}/app.js ----\n${leer(`web/${applet.nombre}/app.js`)}`,
  ].join('\n\n');
  if (codigo.includes('</script')) throw new Error('El código contiene "</script", que rompería la página.');
  if (estilos.includes('</style')) throw new Error('Los estilos contienen "</style", que rompería la página.');

  const partes = plantilla.split('<!--CUERPO-->');
  if (partes.length !== 2) throw new Error(`web/${applet.nombre}/plantilla.html debe tener una marca <!--CUERPO-->.`);
  const cabeza = partes[0].replace('/*__ESTILOS__*/', () => estilos.trim());
  const cuerpo = partes[1].replace('/*__CODIGO__*/', () => `(() => {\n'use strict';\n${codigo}\n})();`);
  if (cabeza.includes('/*__ESTILOS__*/') || cuerpo.includes('/*__CODIGO__*/')) throw new Error('Quedó una marca sin reemplazar.');

  const pagina = documento(cabeza, cuerpo);
  writeFileSync(join(raiz, 'dist', `${applet.nombre}.html`), pagina);
  console.log(`dist/${applet.nombre}.html  (${(pagina.length / 1024).toFixed(0)} KB)`);
  if (dirFragmentos) writeFileSync(join(dirFragmentos, `${applet.nombre}.html`), `${cabeza.trim()}\n${cuerpo.trim()}\n`);
}

// Portada con el índice de applets
const portada = leer('web/index.html').split('<!--CUERPO-->');
writeFileSync(join(raiz, 'dist', 'index.html'), documento(portada[0].replace('/*__ESTILOS__*/', () => leer('web/comun/base.css').trim()), portada[1]));
console.log('dist/index.html');
