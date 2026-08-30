// netlify/functions/productos-toteat.js
//
// Devuelve el listado de productos vendidos en los últimos N días (default
// 7), agrupados por categoría -- exactamente como están ordenados en
// Toteat -- junto con cuántas unidades se vendieron de cada uno. Esto es
// lo que alimenta el selector de "qué producto usa insumo de fábrica" en
// la pestaña "Recetas", para no tener que escribir nombres a mano.
//
// CÓDIGO (nuevo): cada producto trae su "codigo" (el id interno de Toteat,
// ej: "TT001") y, si tiene sabores/variantes, cada una trae su propio
// "codigo" también (ej: "tarta1" para "Pie de Limón"). Eso es lo que usa
// el resto del sistema (pedido-fabrica.js, stock-calculado.js,
// pronostico-fabricacion.js) para hacer match robusto a acentos, mayúsculas
// y typos del Excel -- el texto queda solo para mostrarlo en pantalla.
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
        const e = byProduct.get(p.name) || { revenue: 0, quantity: 0, category: p.category, codigo: p.codigo || null, variantes: p.variantes || [] };
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
      porCategoria.get(cat).push({
        producto: name,
        unidadesVendidas: v.quantity,
        ventaTotal: v.revenue,
        precioUnitario,
        codigo: v.codigo,
        variantes: v.variantes,
      });
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
// variantes/sabores -- ej: "Club Desayuno Muffin (Cappuccino)" y "Club
// Desayuno Muffin (Latte, M. Arándano)" son ambos de la familia "Club
// Desayuno Muffin". Se agrupa por CÓDIGO (el id del producto base en
// Toteat), no por texto -- así no importa si el nombre viene con acentos
// rotos o mayúsculas distintas, el código no cambia nunca. Dentro de cada
// familia, cada sabor/variante también se identifica por SU código propio
// (ej: "tarta1" para "Pie de Limón"), tomado de sale.products directamente
// (ver mergeModifiers en ventas-fabrica.js) -- ya no se parsea el texto
// entre paréntesis.
//
// Esto es lo que permite en la pantalla de Recetas elegir "el sabor
// Arándano" una sola vez, y que el pedido a fábrica sume TODAS las ventas
// que incluyan ese sabor (por código), sin importar con qué otro
// modificador se combinó ni cómo esté escrito el texto.
function detectarFamilias(productos) {
  // codigoBase -> { base(texto para mostrar), codigoBase, tokens: Map(codigoToken -> {...}) }
  const familias = new Map();

  for (const p of productos) {
    if (!p.variantes || !p.variantes.length || !p.codigo) continue;

    if (!familias.has(p.codigo)) {
      const baseTexto = p.producto.split(' (')[0].trim();
      familias.set(p.codigo, { base: baseTexto, codigoBase: p.codigo, tokens: new Map() });
    }
    const fam = familias.get(p.codigo);

    p.variantes.forEach((v) => {
      const key = v.codigo || v.nombre; // por si algún día viene sin código, no se pierde el dato
      const e = fam.tokens.get(key) || { token: v.nombre, codigo: v.codigo || null, unidadesVendidas: 0, ventaTotal: 0 };
      e.unidadesVendidas += p.unidadesVendidas;
      e.ventaTotal += p.ventaTotal;
      fam.tokens.set(key, e);
    });
  }

  return [...familias.values()]
    .filter((fam) => fam.tokens.size > 1) // no vale la pena agrupar si hay un solo sabor
    .map((fam) => ({
      base: fam.base,
      codigoBase: fam.codigoBase,
      tokens: [...fam.tokens.values()].sort((a, b) => b.unidadesVendidas - a.unidadesVendidas),
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
