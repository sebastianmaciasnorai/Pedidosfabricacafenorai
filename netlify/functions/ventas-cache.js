// netlify/functions/ventas-cache.js
//
// Esto NO es una función de Netlify (no tiene exports.handler) -- es un
// módulo compartido que usan pedido-fabrica.js y productos-toteat.js para
// no tener que pedirle a Toteat el rango completo cada vez.
//
// IDEA: los días YA CERRADOS (todos menos hoy) no van a cambiar nunca más.
// Los guardamos una vez en Netlify Blobs (key "historial-ventas") y de ahí
// en adelante se leen de memoria, sin llamar a Toteat de nuevo. El único
// día que sí se vuelve a pedir siempre es HOY, porque sigue sumando ventas.
//
// También guardamos un "checkpoint" (key "checkpoint-sync") con la fecha/
// hora de la última sincronización y la boleta más reciente vista, para
// que la persona pueda ver qué tan al día está la información.
//
// ARREGLO DE ACENTOS: Toteat manda algunos nombres con acentos "rotos"
// (ej: "MaracuyÃ¡" en vez de "Maracuyá"). Ya se corrige al ingresar los
// datos en ventas-fabrica.js, pero el historial que quedó guardado en
// Blobs ANTES de ese arreglo sigue con los nombres rotos tal cual. Para no
// tener que reimportar nada, acá se vuelve a aplicar el mismo arreglo cada
// vez que se LEE un día (sea nuevo o ya cacheado) -- es una operación
// segura de repetir: si el texto ya está bien, no le hace nada.

const { getStore } = require('@netlify/blobs');
const { fetchToteatDia, resumirDia, listaFechasEntre, formatYYYYMMDD, esperar } = require('./ventas-fabrica');

const STORE_NAME = 'pedido-fabrica';
const KEY_HISTORIAL = 'historial-ventas';
const KEY_CHECKPOINT = 'checkpoint-sync';
const TAMANO_TANDA = 3;
const PAUSA_MS = 250;

function getBlobStore() {
  return getStore({
    name: STORE_NAME,
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });
}

function arreglarAcentos(str) {
  if (!str) return str;
  try {
    if (/Ã[\x80-\xBF]|Â[\x80-\xBF]/.test(str)) {
      return Buffer.from(str, 'latin1').toString('utf8');
    }
  } catch (e) {
    // si algo sale mal, mejor devolver el texto original que romper todo
  }
  return str;
}

// Aplica arreglarAcentos a todos los nombres de un día resumido (products,
// categories, productsByHour), sin importar si viene recién fetcheado o
// desde el historial guardado en Blobs.
function normalizarDia(dia) {
  if (!dia) return dia;
  const products = (dia.products || []).map((p) => ({
    ...p,
    name: arreglarAcentos(p.name),
    category: arreglarAcentos(p.category),
  }));
  const categories = (dia.categories || []).map((c) => ({
    ...c,
    name: arreglarAcentos(c.name),
  }));
  const productsByHour = {};
  Object.entries(dia.productsByHour || {}).forEach(([nombre, porHora]) => {
    productsByHour[arreglarAcentos(nombre)] = porHora;
  });
  return { ...dia, products, categories, productsByHour };
}

// Trae porDia para [iniYYYYMMDD, endYYYYMMDD], usando el historial guardado
// para todos los días salvo HOY (que siempre se vuelve a pedir a Toteat).
// Guarda en Blobs los días nuevos que se hayan tenido que pedir (menos hoy).
async function obtenerVentasConCache(iniYYYYMMDD, endYYYYMMDD, creds) {
  const store = getBlobStore();
  const hoy = formatYYYYMMDD(new Date());
  const fechas = listaFechasEntre(iniYYYYMMDD, endYYYYMMDD);

  const historialGuardado = (await store.get(KEY_HISTORIAL, { type: 'json' })) || [];
  const historialPorFecha = new Map(historialGuardado.map((d) => [d.fecha, d]));

  const faltantes = fechas.filter((f) => f === hoy || !historialPorFecha.has(yyyymmddToISO(f)));

  const nuevosPorFecha = new Map();
  for (let i = 0; i < faltantes.length; i += TAMANO_TANDA) {
    const tanda = faltantes.slice(i, i + TAMANO_TANDA);
    const resultados = await Promise.allSettled(tanda.map((f) => fetchToteatDia(f, creds)));
    resultados.forEach((r, idx) => {
      const f = tanda[idx];
      if (r.status === 'fulfilled') nuevosPorFecha.set(f, resumirDia(f, r.value));
    });
    if (i + TAMANO_TANDA < faltantes.length) await esperar(PAUSA_MS);
  }
  // segunda pasada para los que fallaron en la primera tanda
  for (const f of faltantes) {
    if (!nuevosPorFecha.has(f)) {
      try {
        const raw = await fetchToteatDia(f, creds);
        nuevosPorFecha.set(f, resumirDia(f, raw));
      } catch (e) {
        // si sigue fallando, se deja fuera -- el resumen tendrá menos días,
        // mejor eso que cortar toda la respuesta.
      }
    }
  }

  // Guarda en el historial permanente todo lo nuevo que NO sea hoy (hoy
  // puede seguir cambiando durante el día, así que no se cachea todavía).
  let huboCambios = false;
  nuevosPorFecha.forEach((dia, fechaYYYYMMDD) => {
    if (fechaYYYYMMDD !== hoy) {
      historialPorFecha.set(dia.fecha, dia);
      huboCambios = true;
    }
  });
  if (huboCambios) {
    await store.setJSON(KEY_HISTORIAL, [...historialPorFecha.values()]);
  }

  // Arma la respuesta final combinando historial + lo de hoy recién traído,
  // y arregla los acentos de TODO (nuevo o cacheado) antes de devolverlo.
  const porDia = fechas
    .map((f) => {
      if (f === hoy) return nuevosPorFecha.get(f) || null;
      return historialPorFecha.get(yyyymmddToISO(f)) || nuevosPorFecha.get(f) || null;
    })
    .filter(Boolean)
    .map(normalizarDia);

  // Actualiza el checkpoint con la boleta más reciente vista hoy.
  const diaDeHoy = nuevosPorFecha.get(hoy);
  let checkpoint = null;
  if (diaDeHoy) {
    const horas = (diaDeHoy.hourly || []).map((h) => Number(h.hour));
    const horaMax = horas.length ? Math.max(...horas) : null;
    checkpoint = {
      ultimaSincronizacion: new Date().toISOString(),
      fechaHoy: diaDeHoy.fecha,
      ultimaHoraConVentas: horaMax,
      ordenesHoy: diaDeHoy.totalOrders,
    };
    await store.setJSON(KEY_CHECKPOINT, checkpoint);
  } else {
    checkpoint = (await store.get(KEY_CHECKPOINT, { type: 'json' })) || null;
  }

  return { porDia, checkpoint };
}

function yyyymmddToISO(s) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

module.exports = { obtenerVentasConCache, leerHistorialGuardado };

async function leerHistorialGuardado() {
  const store = getBlobStore();
  const historial = (await store.get(KEY_HISTORIAL, { type: 'json' })) || [];
  return historial.map(normalizarDia);
}
