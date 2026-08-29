// netlify/functions/pedido-fabrica.js
//
// Junta tres piezas para responder "¿qué le pedimos hoy a la fábrica?":
//
//   1. Tendencia de cierre POR PRODUCTO (ventas-fabrica.js) -- cuántas
//      unidades de cada producto vamos a vender hoy, proyectado.
//   2. La receta producto -> insumo (Netlify Blobs: recetas.json) -- cuánto
//      insumo de fábrica consume cada unidad vendida.
//   3. El stock actual y mínimo de cada insumo (Netlify Blobs: stock.json).
//
// Con eso arma, insumo por insumo: cuánto se va a necesitar hoy, cuánto va
// a quedar de stock al cierre, y si hay que pedir más (y cuánto).
//
// GET /.netlify/functions/pedido-fabrica?end=20260828&dias=14
//   end  -> día que se proyecta (default: hoy)
//   dias -> cuántos días hacia atrás pedirle a Toteat para tener buen
//           historial de tendencia, incluyendo "end" (default: 14)
//
// Respuesta:
// {
//   ok: true,
//   rangeIni, rangeEnd, fechaProyectada,
//   alertas: [ ...filas de "detalle" que quedaron bajo el mínimo... ],
//   detalle: [
//     { insumo, necesidadHoy, stockActual, stockMinimo,
//       stockProyectadoFinDia, bajoMinimo, sugeridoPedirAFabrica },
//     ...
//   ]
// }
//
// SIMPLIFICACIÓN CONSCIENTE: "sugeridoPedirAFabrica" solo devuelve al
// insumo exactamente al stockMinimo, no a un buffer arriba de eso. Si
// quieren siempre quedar con más colchón (ej. mínimo + 1 día extra de
// venta), ese es el único número a ajustar, en la línea que calcula
// `sugeridoPedir` más abajo.

const { getStore } = require('@netlify/blobs');
const { calcularTendenciaCierrePorProducto } = require('./ventas-fabrica');
const { obtenerVentasConCache } = require('./ventas-cache');

const STORE_NAME = 'pedido-fabrica';

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  const end = qs.end || formatYYYYMMDD(new Date());
  const dias = Number(qs.dias) || 14;
  const ini = sumarDiasYYYYMMDD(end, -(dias - 1));

  try {
    const store = getStore({
      name: STORE_NAME,
      siteID: process.env.BLOBS_SITE_ID,
      token: process.env.BLOBS_TOKEN,
    });
    const [recetas, stock] = await Promise.all([
      store.get('recetas', { type: 'json' }),
      store.get('stock', { type: 'json' }),
    ]);

    if (!recetas || !recetas.length) {
      return jsonResponse(200, {
        ok: true,
        alertas: [],
        detalle: [],
        nota: 'No hay recetas cargadas todavía. Ve a /admin-fabrica.html y arma el mapeo producto -> insumo.',
      });
    }

    const resumen = await obtenerVentasConCache(ini, end, { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU });
    const fechaAProyectarISO = yyyymmddToISO(end);
    const tendenciaProductos = calcularTendenciaCierrePorProducto(resumen.porDia, fechaAProyectarISO) || [];

    const proyeccionPorProducto = new Map(
      tendenciaProductos.map((t) => [t.producto, t.unidadesProyectadasCierre])
    );

    // Explota proyección de productos -> necesidad de insumos.
    const necesidadPorInsumo = new Map();
    for (const receta of recetas) {
      const proyeccionProducto = obtenerProyeccion(receta, proyeccionPorProducto);
      if (proyeccionProducto === 0) continue;
      const necesidad = proyeccionProducto * receta.cantidadPorUnidad;
      necesidadPorInsumo.set(receta.insumo, (necesidadPorInsumo.get(receta.insumo) || 0) + necesidad);
    }

    const stockPorInsumo = new Map((stock || []).map((s) => [s.insumo, s]));

    const detalle = [];
    for (const [insumo, necesidadUnidadReceta] of necesidadPorInsumo.entries()) {
      const s = stockPorInsumo.get(insumo);
      const tamanoEnvase = s && s.tamanoEnvase > 0 ? s.tamanoEnvase : 1;
      const necesidadEnvases = necesidadUnidadReceta / tamanoEnvase;

      const stockActual = s ? s.stockActual : 0;
      const stockMinimo = s ? s.stockMinimo : 0;
      const stockProyectado = round2(stockActual - necesidadEnvases);
      const bajoMinimo = stockProyectado < stockMinimo;
      const sugeridoPedir = bajoMinimo ? Math.ceil(stockMinimo - stockProyectado) : 0;

      detalle.push({
        insumo,
        tamanoEnvase,
        necesidadHoyUnidadReceta: round2(necesidadUnidadReceta),
        necesidadHoyEnvases: round2(necesidadEnvases),
        stockActual,
        stockMinimo,
        stockProyectadoFinDia: stockProyectado,
        bajoMinimo,
        sugeridoPedirAFabrica: sugeridoPedir,
      });
    }

    detalle.sort((a, b) => b.sugeridoPedirAFabrica - a.sugeridoPedirAFabrica);
    const alertas = detalle.filter((d) => d.bajoMinimo);

    return jsonResponse(200, {
      ok: true,
      rangeIni: ini,
      rangeEnd: end,
      fechaProyectada: fechaAProyectarISO,
      checkpoint: resumen.checkpoint,
      alertas,
      detalle,
    });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo calcular el pedido a fábrica.', detail: String(e) });
  }
};

// Si la receta tiene "patronToken" (viene de la pantalla de "sabores
// agrupados"), suma la proyección de TODOS los productos que empiecen con
// el nombre base de la receta Y contengan ese token en algún lado del
// nombre (ej: "Club Desayuno Muffin (Latte, M. Arándano)" contiene el
// token "M. Arándano"). Si no tiene patronToken, es una receta normal de
// nombre exacto.
function obtenerProyeccion(receta, proyeccionPorProducto) {
  if (!receta.patronToken) {
    return proyeccionPorProducto.get(receta.producto) || 0;
  }
  let total = 0;
  for (const [nombre, cantidad] of proyeccionPorProducto.entries()) {
    if (nombre.startsWith(receta.producto) && nombre.includes(receta.patronToken)) {
      total += cantidad;
    }
  }
  return total;
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

function yyyymmddToISO(s) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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
