// netlify/functions/importar-historial.js
//
// Recibe el JSON que exporta la otra app de Norai (formato:
// { dias: [ { fecha: "2026-08-18", data: { totalRevenue, totalOrders,
// categories, products, hourly, productsByHour, ... } }, ... ] }) y lo
// guarda en el mismo historial cacheado que usa ventas-cache.js, para no
// tener que volver a pedirle esos días a Toteat.
//
// OJO: el día de HOY (si viene incluido en el archivo) se ignora a
// propósito -- ese día se sigue pidiendo siempre en vivo a Toteat porque
// todavía puede sumar más ventas.
//
// POST /.netlify/functions/importar-historial   body: el JSON exportado

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'pedido-fabrica';
const KEY_HISTORIAL = 'historial-ventas';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Método no soportado, usa POST.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { ok: false, error: 'Body inválido, se esperaba JSON.' });
  }

  const dias = body.dias;
  if (!Array.isArray(dias)) {
    return jsonResponse(400, { ok: false, error: 'Se esperaba un objeto con { dias: [...] }.' });
  }

  const hoyISO = new Date().toISOString().slice(0, 10);
  const store = getStore({
    name: STORE_NAME,
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });

  const historialGuardado = (await store.get(KEY_HISTORIAL, { type: 'json' })) || [];
  const historialPorFecha = new Map(historialGuardado.map((d) => [d.fecha, d]));

  let importados = 0;
  let omitidosPorSerHoy = 0;
  let invalidos = 0;

  for (const dia of dias) {
    const fecha = dia.fecha;
    const data = dia.data;
    if (!fecha || !data) {
      invalidos++;
      continue;
    }
    if (fecha === hoyISO) {
      omitidosPorSerHoy++;
      continue;
    }

    historialPorFecha.set(fecha, {
      fecha,
      totalRevenue: data.totalRevenue || 0,
      totalOrders: data.totalOrders || 0,
      categories: data.categories || [],
      products: data.products || [],
      hourly: data.hourly || [],
      productsByHour: data.productsByHour || {},
    });
    importados++;
  }

  await store.setJSON(KEY_HISTORIAL, [...historialPorFecha.values()]);

  return jsonResponse(200, {
    ok: true,
    importados,
    omitidosPorSerHoy,
    invalidos,
    totalDiasEnHistorial: historialPorFecha.size,
  });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
