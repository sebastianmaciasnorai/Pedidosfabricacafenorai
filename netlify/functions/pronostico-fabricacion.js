// netlify/functions/pronostico-fabricacion.js
//
// Responde "¿qué tengo que empezar a fabricar HOY para que esté listo a
// tiempo?" -- para insumos que se demoran varios días en elaborarse (ej:
// un brownie que se hace un día y se corta al día siguiente), avisar el
// mismo día que se agota es tarde. Acá se mira "cuándo se despacharía si
// empiezo a producir hoy" en vez de "hoy".
//
// CALENDARIO DE DESPACHO (confirmado con el dueño):
//   - La producción solo avanza en días HÁBILES (lunes a viernes); el fin
//     de semana no cuenta como día de producción.
//   - Si un insumo necesita N días de elaboración, se cuentan N días
//     hábiles a partir de HOY (hoy cuenta como día 1).
//   - El despacho ocurre el día hábil siguiente a que termine el último
//     día de producción.
//   Ejemplos ya validados:
//     - 2 días de elaboración, empieza viernes -> día 1 viernes, día 2
//       lunes (se salta el finde), despacho martes.
//     - 1 día de elaboración, empieza viernes -> día 1 viernes, despacho
//       lunes.
//
// STOCK: ya no se usa un "stockActual" tecleado a mano -- se usa el mismo
// stock CALCULADO que pedido-fabrica.js (stock-calculado.js), para que
// ambas pantallas trabajen con el mismo número real.
//
// Cómo proyecta la venta de un día FUTURO (no se puede usar la tendencia
// en vivo, porque ese día todavía no existe): toma el mismo día de la
// semana del despacho (ej: todos los "martes" guardados en el historial) y
// promedia cuánto se vendió de cada producto esos días. Si no hay ningún
// día histórico con ese día de la semana, usa el promedio general del
// producto en todo el historial.
//
// GET /.netlify/functions/pronostico-fabricacion?dias=30
//   dias -> mínimo de historial a pedirle a Toteat (default 30, se estira
//           solo si algún insumo tiene un último conteo más antiguo).

const { leerHistorialGuardado, obtenerVentasConCache } = require('./ventas-cache');
const { calcularStockPorInsumo } = require('./stock-calculado');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'pedido-fabrica';
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

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

    const stockConDias = (stock || []).filter((s) => Number(s.diasElaboracion) > 0);
    if (!stockConDias.length) {
      return jsonResponse(200, {
        ok: true,
        items: [],
        nota: 'Ningún insumo tiene "días de elaboración" configurado todavía. Ve a la pestaña de Recetas y agrégaselo a los insumos que tardan más de un día en fabricarse.',
      });
    }

    const end = formatYYYYMMDD(new Date());
    const diasDeseados = Number(qs.dias) || 30;
    const iniDeseada = sumarDiasYYYYMMDD(end, -(diasDeseados - 1));

    // Igual que pedido-fabrica.js: si algún insumo tiene un último conteo
    // más antiguo que la ventana pedida, estira el rango para no perder
    // ventas reales entre medio (si no, el stock calculado quedaría mal).
    const iniMasAntiguaPorConteo = stockConDias.reduce((min, s) => {
      const f = (s.ultimoConteoFecha || '').slice(0, 10).replace(/-/g, '');
      return f && f < min ? f : min;
    }, iniDeseada);
    const ini = iniMasAntiguaPorConteo < iniDeseada ? iniMasAntiguaPorConteo : iniDeseada;

    const [resumen, historialParaPromedio] = await Promise.all([
      obtenerVentasConCache(ini, end, { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU }),
      leerHistorialGuardado(),
    ]);

    const stockCalculadoCompleto = calcularStockPorInsumo({
      recetas: recetas || [],
      stock: stock || [],
      mermas: mermas || [],
      recepciones: recepciones || [],
      porDia: resumen.porDia,
    });
    const insumosConDiasElaboracion = stockCalculadoCompleto.filter((s) => s.diasElaboracion > 0);

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const items = [];

    for (const s of insumosConDiasElaboracion) {
      const dias = s.diasElaboracion;
      const tamanoEnvase = s.tamanoEnvase;

      const fechaDespacho = calcularFechaDespacho(hoy, dias);
      const diaSemanaObjetivo = fechaDespacho.getDay();
      const fechaObjetivoISO = fechaDespacho.toISOString().slice(0, 10);

      const recetasDeEsteInsumo = (recetas || []).filter((r) => r.insumo === s.insumo);

      let necesidadProyectada = 0;
      for (const receta of recetasDeEsteInsumo) {
        // OJO: el historial de referencia para promediar NO incluye hoy
        // (día parcial todavía) -- leerHistorialGuardado() solo trae días
        // ya cerrados, por diseño de ventas-cache.js.
        const promedio = promedioVentaProducto(historialParaPromedio, receta, diaSemanaObjetivo);
        necesidadProyectada += promedio * receta.cantidadPorUnidad;
      }

      const necesidadEnvases = necesidadProyectada / tamanoEnvase;
      const stockActual = s.stockCalculado;
      const stockMinimo = s.stockMinimo;
      // ¿Alcanza el stock actual para cubrir esa venta futura Y seguir
      // sobre el mínimo? Si no, hay que empezar a producir hoy.
      const faltante = necesidadEnvases - (stockActual - stockMinimo);
      const necesitaProducir = faltante > 0;

      items.push({
        insumo: s.insumo,
        diasElaboracion: dias,
        fechaDespacho: fechaObjetivoISO,
        diaSemanaDespacho: DIAS_SEMANA[diaSemanaObjetivo],
        ventaPromedioProyectada: round2(necesidadProyectada),
        necesidadEnvases: round2(necesidadEnvases),
        stockActual,
        stockMinimo,
        necesitaProducir,
        unidadesAProducir: necesitaProducir ? Math.ceil(faltante) : 0,
      });
    }

    items.sort((a, b) => (b.necesitaProducir - a.necesitaProducir) || (b.unidadesAProducir - a.unidadesAProducir));

    return jsonResponse(200, { ok: true, fechaHoy: hoy.toISOString().slice(0, 10), rangeIni: ini, rangeEnd: end, items });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo calcular el pronóstico de fabricación.', detail: String(e) });
  }
};

// ============================================================
// CALENDARIO DE DESPACHO (lunes a viernes, saltando fines de semana)
// ============================================================

function esFinDeSemana(fecha) {
  const d = fecha.getDay();
  return d === 0 || d === 6; // domingo=0, sábado=6
}

function siguienteDiaHabil(fecha) {
  const d = new Date(fecha);
  d.setDate(d.getDate() + 1);
  while (esFinDeSemana(d)) d.setDate(d.getDate() + 1);
  return d;
}

// Si HOY se empieza a producir un insumo que necesita "diasElaboracion"
// días hábiles, calcula en qué fecha se despacha (día hábil siguiente al
// último día de producción).
function calcularFechaDespacho(fechaInicio, diasElaboracion) {
  let cursor = new Date(fechaInicio);
  while (esFinDeSemana(cursor)) cursor = siguienteDiaHabil(cursor); // por si "hoy" cae en finde

  for (let i = 1; i < diasElaboracion; i++) {
    cursor = siguienteDiaHabil(cursor);
  }
  return siguienteDiaHabil(cursor);
}

// ============================================================
// PROMEDIO HISTÓRICO POR DÍA DE LA SEMANA
// ============================================================

// Promedia cuánto se vendió de la receta en los días guardados que caen en
// el mismo día de la semana (0=domingo...6=sábado). Si no hay ninguno,
// promedia con TODOS los días guardados (mejor una estimación gruesa que
// nada).
function promedioVentaProducto(historial, receta, diaSemanaObjetivo) {
  const cantidadesMismoDia = [];
  const cantidadesTodas = [];

  for (const dia of historial) {
    const cantidad = cantidadDelDia(dia, receta);
    cantidadesTodas.push(cantidad);

    const fecha = new Date(dia.fecha + 'T00:00:00');
    if (fecha.getDay() === diaSemanaObjetivo) {
      cantidadesMismoDia.push(cantidad);
    }
  }

  const conVentaMismoDia = cantidadesMismoDia.filter((c) => c > 0);
  if (conVentaMismoDia.length) {
    return conVentaMismoDia.reduce((s, c) => s + c, 0) / conVentaMismoDia.length;
  }
  const conVentaTodas = cantidadesTodas.filter((c) => c > 0);
  if (conVentaTodas.length) {
    return conVentaTodas.reduce((s, c) => s + c, 0) / conVentaTodas.length;
  }
  return 0;
}

// Cuánto se vendió de la receta en ESE día. Si la receta tiene código
// (codigoProducto, o codigoBase+patronCodigo), hace match por código
// -- robusto a acentos/mayúsculas/typos del Excel. Si no, cae al match
// por texto de siempre (recetas viejas sin código guardado todavía).
function cantidadDelDia(dia, receta) {
  const productos = dia.products || [];

  if (!receta.patronToken && !receta.patronCodigo) {
    if (receta.codigoProducto) {
      return productos
        .filter((p) => p.codigo === receta.codigoProducto)
        .reduce((s, p) => s + p.quantity, 0);
    }
    const p = productos.find((x) => x.name === receta.producto);
    return p ? p.quantity : 0;
  }

  if (receta.patronCodigo) {
    return productos
      .filter((p) => {
        const coincideBase = receta.codigoBase ? p.codigo === receta.codigoBase : p.name.startsWith(receta.producto);
        const coincideVariante = (p.variantes || []).some((v) => v.codigo === receta.patronCodigo);
        return coincideBase && coincideVariante;
      })
      .reduce((s, p) => s + p.quantity, 0);
  }

  return productos
    .filter((p) => p.name.startsWith(receta.producto) && p.name.includes(receta.patronToken))
    .reduce((s, p) => s + p.quantity, 0);
}

// ============================================================
// HELPERS
// ============================================================

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
