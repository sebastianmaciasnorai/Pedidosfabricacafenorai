// netlify/functions/fabrica-datos.js
//
// CRUD simple sobre Netlify Blobs para dos "documentos" JSON, sin base de
// datos externa ni cuentas de terceros:
//
//   - recetas: [{ producto, insumo, cantidadPorUnidad }]
//   - stock: [{ insumo, stockMinimo, tamanoEnvase, unidadEnvase,
//               diasElaboracion, ultimoConteo?, ultimoConteoFecha? }]
//
// GET  /.netlify/functions/fabrica-datos?key=recetas
// GET  /.netlify/functions/fabrica-datos?key=stock
// POST /.netlify/functions/fabrica-datos   body: { key: 'recetas'|'stock', data: [...] }
//
// OJO: desde que existe la pestaña "Stock y mermas" (ver stock-cafeteria.js
// y stock-calculado.js), "ultimoConteo"/"ultimoConteoFecha" son el número
// que de verdad se usa para calcular el stock -- y solo se actualizan con
// la acción "conteo" de stock-cafeteria.js (botón "Recontar"), NUNCA desde
// acá. Por eso este POST los deja pasar si vienen (para no perderlos
// cuando el frontend hace merge con lo que ya había), pero no los exige ni
// los valida -- la pestaña "Recetas" solo edita insumo/mínimo/tamaño de
// envase/días de elaboración.
//
// Requiere el paquete @netlify/blobs (npm install @netlify/blobs).
// Usa BLOBS_SITE_ID y BLOBS_TOKEN (variables de entorno) para autenticarse
// con Netlify Blobs de forma explícita.

const { getStore } = require('@netlify/blobs');

const CLAVES_VALIDAS = ['recetas', 'stock'];
const STORE_NAME = 'pedido-fabrica';

exports.handler = async (event) => {
  const store = getStore({
    name: STORE_NAME,
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });

  if (event.httpMethod === 'GET') {
    const key = (event.queryStringParameters || {}).key;
    if (!CLAVES_VALIDAS.includes(key)) {
      return jsonResponse(400, { ok: false, error: `key debe ser una de: ${CLAVES_VALIDAS.join(', ')}` });
    }
    const data = await store.get(key, { type: 'json' });
    return jsonResponse(200, { ok: true, key, data: data || [] });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return jsonResponse(400, { ok: false, error: 'Body inválido, se esperaba JSON.' });
    }

    const { key, data } = body;
    if (!CLAVES_VALIDAS.includes(key)) {
      return jsonResponse(400, { ok: false, error: `key debe ser una de: ${CLAVES_VALIDAS.join(', ')}` });
    }
    if (!Array.isArray(data)) {
      return jsonResponse(400, { ok: false, error: 'data debe ser un array.' });
    }

    const validacion = validar(key, data);
    if (!validacion.ok) return jsonResponse(400, validacion);

    await store.setJSON(key, data);
    return jsonResponse(200, { ok: true, key, guardado: data.length });
  }

  return jsonResponse(405, { ok: false, error: 'Método no soportado.' });
};

function validar(key, data) {
  if (key === 'recetas') {
    for (const [i, r] of data.entries()) {
      if (!r.producto || !r.insumo || typeof r.cantidadPorUnidad !== 'number' || r.cantidadPorUnidad < 0) {
        return { ok: false, error: `Fila ${i + 1} de recetas inválida: se espera { producto, insumo, cantidadPorUnidad (número >= 0) }` };
      }
    }
  }
  if (key === 'stock') {
    for (const [i, r] of data.entries()) {
      if (!r.insumo || typeof r.stockMinimo !== 'number') {
        return { ok: false, error: `Fila ${i + 1} de stock inválida: se espera { insumo, stockMinimo (número) }` };
      }
      if (r.ultimoConteo != null && typeof r.ultimoConteo !== 'number') {
        return { ok: false, error: `Fila ${i + 1} de stock inválida: ultimoConteo debe ser un número si viene.` };
      }
    }
  }
  return { ok: true };
}

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
