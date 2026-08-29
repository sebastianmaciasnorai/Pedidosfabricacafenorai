// netlify/functions/pedido-fabrica.js
//
// Junta tres piezas para responder "¿qué le pedimos hoy a la fábrica?":
//   1. Tendencia de cierre POR PRODUCTO (ventas-fabrica.js)
//   2. La receta producto -> insumo (Netlify Blobs: recetas.json)
//   3. El stock actual y mínimo de cada insumo (Netlify Blobs: stock.json)
//
// GET /.netlify/functions/pedido-fabrica?end=20260828&dias=14
//
// Usa BLOBS_SITE_ID y BLOBS_TOKEN (variables de entorno) para autenticarse
// con Netlify Blobs de forma explícita.

const { getStore } = require('@netlify/blobs');
const { obtenerVentasEnVivo, calcularTendenciaCierrePorProducto } = require('./ventas-fabrica');

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

    const resumen = await obtenerVentasEnVivo(ini, end, { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU });
    const fechaAProyectarISO = yyyymmddToISO(end);
    const tendenciaProductos = calcularTendenciaCierrePorProducto(resumen.porDia, fechaAProyectarISO) || [];

    const proyeccionPorProducto = new Map(
      tendenciaProductos.map((t) => [t.producto, t.unidadesProyectadasCierre])
    );

    const necesidadPorInsumo = new Map();
    for (const receta of recetas) {
      const proyeccionProducto = proyeccionPorProducto.get(receta.producto) || 0;
      if (proyeccionProducto === 0) continue;
      const necesidad = proyeccionProducto * receta.cantidadPorUnidad;
      necesidadPorInsumo.set(receta.insumo, (necesidadPorInsumo.get(receta.insumo) || 0) + necesidad);
    }

    const stockPorInsumo = new Map((stock || []).map((s) => [s.insumo, s]));

    const detalle = [];
    for (const [insumo, necesidad] of necesidadPorInsumo.entries()) {
      const s = stockPorInsumo.get(insumo);
      const stockActual = s ? s.stockActual : 0;
      const stockMinimo = s ? s.stockMinimo : 0;
      const stockProyectado = round2(stockActual - necesidad);
      const bajoMinimo = stockProyectado < stockMinimo;
      const sugeridoPedir = bajoMinimo ? Math.ceil(stockMinimo - stockProyectado) : 0;

      detalle.push({
        insumo,
        necesidadHoy: round2(necesidad),
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
      alertas,
      detalle,
    });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo calcular el pedido a fábrica.', detail: String(e) });
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
