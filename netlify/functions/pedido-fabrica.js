// netlify/functions/pedido-fabrica.js
//
// Junta estas piezas para responder "¿qué le pedimos hoy a la fábrica?":
//
//   1. Tendencia de cierre POR PRODUCTO (ventas-fabrica.js) -- cuántas
//      unidades de cada producto vamos a vender HOY en total, proyectado,
//      y cuántas van ya vendidas hasta ahora.
//   2. La receta producto -> insumo (Netlify Blobs: recetas.json).
//   3. El STOCK CALCULADO de cada insumo (stock-calculado.js) -- último
//      conteo real + recepciones - ventas REALES - mermas, desde el último
//      conteo. Este stock YA tiene descontado todo lo vendido hasta ahora,
//      así que aquí solo hace falta sumarle lo que falta por vender HOY
//      (proyección de cierre menos lo ya vendido hoy) para proyectar cómo
//      va a quedar el stock al cierre del día.
//
// CAMBIO IMPORTANTE (antes vs. ahora): antes "stockActual" era un número
// tecleado a mano en la pestaña "Recetas y stock", y acá se restaba la
// proyección COMPLETA del día. Eso funcionaba porque ese número recién
// tecleado no tenía descontada ninguna venta todavía. Ahora que el stock
// se calcula solo (pestaña "Stock y mermas"), YA viene con las ventas de
// hoy hasta el momento descontadas -- si acá restáramos la proyección
// completa del día estaríamos descontando esas ventas DOS VECES. Por eso
// la resta es solo "lo que falta por vender hoy", no el total proyectado.
//
// GET /.netlify/functions/pedido-fabrica?end=20260828&dias=14
//   end  -> día que se proyecta (default: hoy)
//   dias -> cuántos días hacia atrás pedirle a Toteat para tener buen
//           historial de tendencia, incluyendo "end" (default: 14). Si
//           algún insumo tiene un último conteo más antiguo que eso, el
//           rango se estira solo hasta cubrirlo (para no perder ventas
//           reales entre el conteo y hoy).
//
// Respuesta:
// {
//   ok: true,
//   rangeIni, rangeEnd, fechaProyectada,
//   alertas: [ ...filas de "detalle" que quedaron bajo el mínimo... ],
//   detalle: [
//     { insumo, necesidadHoyUnidadReceta, necesidadHoyEnvases, tamanoEnvase,
//       stockActual, stockMinimo, stockProyectadoFinDia, bajoMinimo,
//       sugeridoPedirAFabrica, ultimoConteoFecha },
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
const { calcularStockPorInsumo, explotarARecetas } = require('./stock-calculado');

const STORE_NAME = 'pedido-fabrica';

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  const end = qs.end || formatYYYYMMDD(new Date());
  const dias = Number(qs.dias) || 14;
  const iniDeseada = sumarDiasYYYYMMDD(end, -(dias - 1));

  try {
    const store = getStore({
      name: STORE_NAME,
      siteID: process.env.BLOBS_SITE_ID,
      token: process.env.BLOBS_TOKEN,
    });
    const [recetas, stock, mermas, recepciones] = await Promise.all([
      store.get('recetas', { type: 'json' }),
      store.get('stock', { type: 'json' }),
      store.get('mermas', { type: 'json' }),
      store.get('recepciones', { type: 'json' }),
    ]);

    if (!recetas || !recetas.length) {
      return jsonResponse(200, {
        ok: true,
        alertas: [],
        detalle: [],
        nota: 'No hay recetas cargadas todavía. Ve a la pestaña "Recetas" y arma el mapeo producto -> insumo.',
      });
    }

    // Si algún insumo tiene un último conteo más antiguo que la ventana de
    // "dias", estira el ini para no perder ventas reales entre medio (si
    // no, calcularStockPorInsumo subestimaría "vendido" y el stock
    // calculado quedaría inflado).
    const iniMasAntiguaPorConteo = (stock || []).reduce((min, s) => {
      const f = (s.ultimoConteoFecha || '').slice(0, 10).replace(/-/g, '');
      return f && f < min ? f : min;
    }, iniDeseada);
    const ini = iniMasAntiguaPorConteo < iniDeseada ? iniMasAntiguaPorConteo : iniDeseada;

    const resumen = await obtenerVentasConCache(ini, end, { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU });
    const fechaAProyectarISO = yyyymmddToISO(end);
    const tendenciaProductos = calcularTendenciaCierrePorProducto(resumen.porDia, fechaAProyectarISO) || [];

    // Lo que falta por vender HOY (no el total proyectado -- ver nota
    // arriba): proyección de cierre menos lo ya vendido hasta ahora.
    const restantePorProducto = new Map(
      tendenciaProductos.map((t) => [t.producto, Math.max(0, t.unidadesProyectadasCierre - t.unidadesVendidasHastaAhora)])
    );
    const necesidadRestantePorInsumo = explotarARecetas(recetas, restantePorProducto);

    const stockCalculado = calcularStockPorInsumo({ recetas, stock: stock || [], mermas: mermas || [], recepciones: recepciones || [], porDia: resumen.porDia });
    const stockPorInsumo = new Map(stockCalculado.map((s) => [s.insumo, s]));

    const detalle = [];
    for (const [insumo, necesidadUnidadReceta] of necesidadRestantePorInsumo.entries()) {
      if (necesidadUnidadReceta === 0) continue;
      const s = stockPorInsumo.get(insumo);
      const tamanoEnvase = s && s.tamanoEnvase > 0 ? s.tamanoEnvase : 1;
      const necesidadEnvases = necesidadUnidadReceta / tamanoEnvase;

      const stockActual = s ? s.stockCalculado : 0;
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
        ultimoConteoFecha: s ? s.ultimoConteoFecha : null,
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
