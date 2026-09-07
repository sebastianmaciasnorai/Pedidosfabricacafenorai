// netlify/functions/fabrica-datos.js
//
// CRUD simple sobre Netlify Blobs para los "documentos" JSON de la pestaña
// Recetas, sin base de datos externa ni cuentas de terceros:
//
//   - recetas: [{ producto, insumo, cantidadPorUnidad, unidad?, patronToken?,
//                 codigoProducto?, codigoBase?, patronCodigo? }]
//       "1 unidad de <producto> vendido en Toteat consume
//        <cantidadPorUnidad> de <insumo>"
//
//   - stock: [{ insumo, codigo?, diasElaboracion?, tamanoEnvase?, unidadEnvase?,
//               stockMinimo, ultimoConteo?, ultimoConteoFecha? }]
//       Desde la Ronda 2, "stockActual" ya NO es obligatorio ni lo toca el
//       guardado de Recetas -- el conteo real (ultimoConteo/ultimoConteoFecha)
//       lo edita únicamente stock-cafeteria.js vía la acción "conteo"
//       (botón "Recontar"). Si una fila vieja todavía trae "stockActual",
//       se deja pasar tal cual -- stock-calculado.js sabe usarlo como
//       fallback la primera vez que corre.
//
// GET  /.netlify/functions/fabrica-datos?key=recetas
// GET  /.netlify/functions/fabrica-datos?key=stock
// POST /.netlify/functions/fabrica-datos   body: { key: 'recetas'|'stock', data: [...] }
//   (el POST reemplaza la lista completa -- la pantalla Recetas manda
//   siempre el arreglo entero editado, no updates parciales)
//
// Requiere el paquete @netlify/blobs (npm install @netlify/blobs).
// Sin siteID/token a mano: Netlify los inyecta solo cuando la función corre
// en su propia infraestructura -- evita que un token guardado manualmente
// (BLOBS_TOKEN) se venza algún día y tumbe todo con un 401.
//
// NOTA DE SEGURIDAD: esta función tal cual NO exige login. Si tu app va a
// tener usuarios, agrégale el mismo chequeo de token que usa el resto del
// dashboard antes de exponerla en producción.

const { getStore, connectLambda } = require('@netlify/blobs');

const CLAVES_VALIDAS = ['recetas', 'stock'];
const STORE_NAME = 'pedido-fabrica';

exports.handler = async (event) => {
  // Necesario en el modo "Lambda" (exports.handler clásico): sin esto,
  // Netlify NO rellena solo la conexión a Blobs y getStore() falla.
  connectLambda(event);
  const store = getStore({
    name: STORE_NAME,
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

    // Al guardar "stock" desde Recetas, preserva ultimoConteo/ultimoConteoFecha
    // de lo que ya estaba guardado -- Recetas no los edita, pero tampoco debe
    // borrarlos si el frontend no los reenvía por algún motivo.
    if (key === 'stock') {
      const stockActualGuardado = (await store.get('stock', { type: 'json' })) || [];
      const porInsumo = new Map(stockActualGuardado.map((s) => [s.insumo, s]));
      data.forEach((fila) => {
        const previa = porInsumo.get(fila.insumo);
        if (previa) {
          if (fila.ultimoConteo === undefined) fila.ultimoConteo = previa.ultimoConteo;
          if (fila.ultimoConteoFecha === undefined) fila.ultimoConteoFecha = previa.ultimoConteoFecha;
        }
      });
    }

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
        return { ok: false, error: `Fila ${i + 1} de stock inválida: se espera al menos { insumo, stockMinimo (número) }` };
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
