// netlify/functions/cache-datos.js
//
// Cache genérico EN LA NUBE (Netlify Blobs) para que cualquier pestaña
// muestre de inmediato lo último calculado -- sin esperar a Toteat -- y
// se actualice en segundo plano. A diferencia de un cache en localStorage
// (que vive solo en el dispositivo que lo generó), esto se guarda en
// Blobs: se comparte entre TODOS los dispositivos (el iPad, el PC de la
// fábrica, etc.) -- si se actualiza desde uno, los demás lo ven apenas
// vuelvan a abrir esa pestaña.
//
// No hay una lista fija de "tab" -- cualquier string sirve como
// namespace de la key en Blobs. Por orden se usan: 'pedido', 'fabricar',
// 'stock', 'mermas'.
//
// GET  /.netlify/functions/cache-datos?tab=mermas
//   -> { ok:true, datos: <lo último guardado> | null, guardadoEn }
// POST /.netlify/functions/cache-datos
//   body: { tab: 'mermas', datos: {...} }
//   Sobrescribe el cache de esa pestaña con datos frescos.

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'pedido-fabrica';

function getBlobStore() {
  return getStore({
    name: STORE_NAME,
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });
}

exports.handler = async (event) => {
  const store = getBlobStore();

  if (event.httpMethod === 'GET') {
    const tab = (event.queryStringParameters || {}).tab;
    if (!tab) return jsonResponse(400, { ok: false, error: 'Falta el parámetro "tab".' });
    try {
      const cache = await store.get(`cache-${tab}`, { type: 'json' });
      return jsonResponse(200, { ok: true, datos: cache ? cache.datos : null, guardadoEn: cache ? cache.guardadoEn : null });
    } catch (e) {
      // si falla la lectura, se comporta como "no hay cache todavía" -- no
      // es un error grave, el frontend simplemente hace la carga en vivo
      return jsonResponse(200, { ok: true, datos: null });
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return jsonResponse(400, { ok: false, error: 'Body inválido, se esperaba JSON.' });
    }
    if (!body.tab) return jsonResponse(400, { ok: false, error: 'Falta "tab".' });
    try {
      await store.setJSON(`cache-${body.tab}`, { datos: body.datos, guardadoEn: Date.now() });
      return jsonResponse(200, { ok: true });
    } catch (e) {
      return jsonResponse(502, { ok: false, error: 'No se pudo guardar el cache.', detail: String(e) });
    }
  }

  return jsonResponse(405, { ok: false, error: 'Método no soportado.' });
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
