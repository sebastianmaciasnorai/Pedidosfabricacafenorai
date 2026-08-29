// netlify/functions/productos-toteat.js
//
// Devuelve el listado de productos vendidos en los últimos N días (default
// 7), agrupados por categoría -- exactamente como están ordenados en
// Toteat -- junto con cuántas unidades se vendieron de cada uno. Esto es
// lo que alimenta el selector de "qué producto usa insumo de fábrica" en
// /admin-fabrica.html, para no tener que escribir nombres a mano.
//
// GET /.netlify/functions/productos-toteat?dias=7

const { obtenerVentasConCache } = require('./ventas-cache');

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
    const { porDia } = await obtenerVentasConCache(ini, end, { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU });

    // Suma productos de todos los días del rango (mismo criterio que
    // obtenerVentasEnVivo, pero acá partiendo de porDia ya cacheado).
    const byProduct = new Map();
    for (const dia of porDia) {
      (dia.products || []).forEach((p) => {
        const e = byProduct.get(p.name) || { revenue: 0, quantity: 0, category: p.category };
        e.revenue += p.revenue;
        e.quantity += p.quantity;
        byProduct.set(p.name, e);
      });
    }

    const porCategoria = new Map();
    for (const [name, v] of byProduct.entries()) {
      const cat = v.category || 'Sin categoría';
      if (!porCategoria.has(cat)) porCategoria.set(cat, []);
      const precioUnitario = v.quantity > 0 ? Math.round(v.revenue / v.quantity) : 0;
      porCategoria.get(cat).push({ producto: name, unidadesVendidas: v.quantity, ventaTotal: v.revenue, precioUnitario });
    }

    const categorias = [...porCategoria.entries()]
      .map(([categoria, productos]) => ({
        categoria,
        productos: productos.sort((a, b) => b.ventaTotal - a.ventaTotal),
        familias: detectarFamilias(productos),
      }))
      .sort((a, b) => a.categoria.localeCompare(b.categoria));

    return jsonResponse(200, { ok: true, rangeIni: ini, rangeEnd: end, categorias });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo obtener el listado de productos desde Toteat.', detail: String(e) });
  }
};

// Detecta grupos de productos que son la MISMA base con distintas
// variantes/sabores entre paréntesis -- ej: "Club Desayuno Muffin
// (Cappuccino)" y "Club Desayuno Muffin (Latte, M. Arándano)" son ambos
// de la familia "Club Desayuno Muffin". Además, separa cada "token" dentro
// del paréntesis (separados por coma) y suma cuánto se vendió de CADA
// token en total dentro de esa familia -- así "M. Arándano" suma tanto el
// combo con café Latte como el combo con Cappuccino, por ejemplo.
//
// Esto es lo que permite en la pantalla de recetas elegir "el sabor
// Arándano" una sola vez, y que el pedido a fábrica sume TODAS las ventas
// que incluyan ese sabor, sin importar con qué otro modificador se
// combinó.
function detectarFamilias(productos) {
  const familias = new Map(); // base -> Map(token -> {unidadesVendidas, ventaTotal})

  for (const p of productos) {
    const match = p.producto.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!match) continue;
    const base = match[1].trim();
    const tokens = match[2].split(',').map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) continue;

    if (!familias.has(base)) familias.set(base, new Map());
    const mapaTokens = familias.get(base);
    tokens.forEach((token) => {
      const e = mapaTokens.get(token) || { unidadesVendidas: 0, ventaTotal: 0 };
      e.unidadesVendidas += p.unidadesVendidas;
      e.ventaTotal += p.ventaTotal;
      mapaTokens.set(token, e);
    });
  }

  return [...familias.entries()]
    .filter(([, mapaTokens]) => mapaTokens.size > 1) // no vale la pena agrupar si hay un solo sabor
    .map(([base, mapaTokens]) => ({
      base,
      tokens: [...mapaTokens.entries()]
        .map(([token, v]) => ({ token, unidadesVendidas: v.unidadesVendidas, ventaTotal: v.ventaTotal }))
        .sort((a, b) => b.unidadesVendidas - a.unidadesVendidas),
    }))
    .sort((a, b) => a.base.localeCompare(b.base));
}

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
