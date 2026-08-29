// netlify/functions/productos-toteat.js
//
// Devuelve el listado de productos vendidos en los últimos N días (default
// 7), agrupados por categoría -- exactamente como están ordenados en
// Toteat -- junto con cuántas unidades se vendieron de cada uno. Esto es
// lo que alimenta el selector de "qué producto usa insumo de fábrica" en
// /admin-fabrica.html, para no tener que escribir nombres a mano.
//
// GET /.netlify/functions/productos-toteat?dias=7

const { obtenerVentasEnVivo } = require('./ventas-fabrica');

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  const dias = Number(qs.dias) || 7;
  const end = formatYYYYMMDD(new Date());
  const ini = sumarDiasYYYYMMDD(end, -(dias - 1));

  try {
    const resumen = await obtenerVentasEnVivo(ini, end, { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU });

    const porCategoria = new Map();
    for (const p of resumen.products || []) {
      const cat = p.category || 'Sin categoría';
      if (!porCategoria.has(cat)) porCategoria.set(cat, []);
      const precioUnitario = p.quantity > 0 ? Math.round(p.revenue / p.quantity) : 0;
      porCategoria.get(cat).push({ producto: p.name, unidadesVendidas: p.quantity, ventaTotal: p.revenue, precioUnitario });
    }

    const categorias = [...porCategoria.entries()]
      .map(([categoria, productos]) => ({
        categoria,
        productos: productos.sort((a, b) => b.ventaTotal - a.ventaTotal),
      }))
      .sort((a, b) => a.categoria.localeCompare(b.categoria));

    return jsonResponse(200, { ok: true, rangeIni: ini, rangeEnd: end, categorias });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo obtener el listado de productos desde Toteat.', detail: String(e) });
  }
};

function sumarDiasYYYYMMDD(yyyymmdd, dias) {
  const d = new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)));
  d.setDate(d.getDate() + dias);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

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
    body: JSON.stringify(body),
  };
}
