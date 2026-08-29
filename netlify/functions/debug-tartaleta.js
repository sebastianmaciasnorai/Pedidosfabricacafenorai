// netlify/functions/debug-tartaleta.js
//
// TEMPORAL -- solo para diagnóstico. Busca en un día de ventas las líneas
// que mencionen "tartaleta" (sin importar mayúsculas) y devuelve el
// objeto CRUDO tal cual lo manda Toteat, para ver exactamente en qué
// campo viene el sabor (nombre, modificador, "options", etc.).
//
// Bórrala cuando ya no la necesites.
//
// GET /.netlify/functions/debug-tartaleta?fecha=20260828

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  const fecha = qs.fecha || formatYYYYMMDD(new Date());
  const buscar = (qs.buscar || 'tartaleta').toLowerCase();

  const url = new URL('https://api.toteat.com/mw/or/1.0/sales');
  url.searchParams.set('xir', TOTEAT_XIR);
  url.searchParams.set('xil', TOTEAT_XIL);
  url.searchParams.set('xiu', TOTEAT_XIU);
  url.searchParams.set('xapitoken', TOTEAT_API_TOKEN);
  url.searchParams.set('ini', fecha);
  url.searchParams.set('end', fecha);
  url.searchParams.set('detail_cancel_order', 'true');

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    const sales = (data && data.data) || [];

    const encontrados = [];
    for (const sale of sales) {
      const productos = sale.products || [];
      const hayCoincidencia = productos.some((p) => String(p.name || '').toLowerCase().includes(buscar));
      if (hayCoincidencia) {
        encontrados.push({
          saleId: sale.id || sale.saleId || '(sin id)',
          dateClosed: sale.dateClosed,
          products: productos,
        });
      }
      if (encontrados.length >= 5) break; // no hace falta más de 5 ejemplos
    }

    return jsonResponse(200, { ok: true, fecha, buscar, encontrados: encontrados.length, ventas: encontrados });
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
