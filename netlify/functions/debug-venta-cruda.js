// netlify/functions/debug-venta-cruda.js
//
// TEMPORAL -- solo para diagnóstico. Trae las ventas de HOY y devuelve las
// últimas 3, mostrando TODOS los campos de nivel-venta (no solo
// "products"), para encontrar en qué campo viene el número de boleta/folio.
//
// Bórrala cuando ya no la necesites.
//
// GET /.netlify/functions/debug-venta-cruda

exports.handler = async () => {
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  const hoy = formatYYYYMMDD(new Date());
  const url = new URL('https://api.toteat.com/mw/or/1.0/sales');
  url.searchParams.set('xir', TOTEAT_XIR);
  url.searchParams.set('xil', TOTEAT_XIL);
  url.searchParams.set('xiu', TOTEAT_XIU);
  url.searchParams.set('xapitoken', TOTEAT_API_TOKEN);
  url.searchParams.set('ini', hoy);
  url.searchParams.set('end', hoy);
  url.searchParams.set('detail_cancel_order', 'true');

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    const sales = (data && data.data) || [];

    // Las últimas 3 ventas del día, con TODOS sus campos (sacamos
    // "products" para no saturar la respuesta -- eso ya lo conocemos).
    const ultimas = sales.slice(-3).map((s) => {
      const { products, ...resto } = s;
      return { ...resto, cantidadProductos: (products || []).length };
    });

    return jsonResponse(200, {
      ok: true,
      fecha: hoy,
      totalVentasHoy: sales.length,
      ultimasVentasCompletas: ultimas,
    });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo conectar con Toteat.', detail: String(e) });
  }
};

function formatYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body, null, 2),
  };
}
