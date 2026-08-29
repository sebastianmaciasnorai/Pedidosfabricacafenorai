// netlify/functions/pronostico-fabricacion.js
//
// Responde "¿qué tengo que empezar a fabricar HOY para que esté listo a
// tiempo?" -- para insumos que se demoran varios días en elaborarse (ej:
// un brownie que se hace un día y se corta al día siguiente), avisar el
// mismo día que se agota es tarde. Acá se mira "hoy + días de elaboración"
// en vez de "hoy".
//
// Cómo proyecta la venta de un día FUTURO (no se puede usar la tendencia
// en vivo, porque ese día todavía no existe): toma el mismo día de la
// semana (ej: todos los "jueves" guardados en el historial) y promedia
// cuánto se vendió de cada producto esos días. Si no hay ningún día
// histórico con ese día de la semana, usa el promedio general del
// producto en todo el historial.
//
// GET /.netlify/functions/pronostico-fabricacion

const { leerHistorialGuardado } = require('./ventas-cache');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'pedido-fabrica';
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

exports.handler = async () => {
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

    const insumosConDiasElaboracion = (stock || []).filter((s) => Number(s.diasElaboracion) > 0);
    if (!insumosConDiasElaboracion.length) {
      return jsonResponse(200, {
        ok: true,
        items: [],
        nota: 'Ningún insumo tiene "días de elaboración" configurado todavía. Ve a la pestaña de Recetas y stock y agrégaselo a los insumos que tardan más de un día en fabricarse.',
      });
    }

    const historial = await leerHistorialGuardado();
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const items = [];

    for (const s of insumosConDiasElaboracion) {
      const dias = Number(s.diasElaboracion);
      const tamanoEnvase = s.tamanoEnvase > 0 ? s.tamanoEnvase : 1;

      const fechaObjetivo = new Date(hoy);
      fechaObjetivo.setDate(fechaObjetivo.getDate() + dias);
      const diaSemanaObjetivo = fechaObjetivo.getDay();
      const fechaObjetivoISO = fechaObjetivo.toISOString().slice(0, 10);

      const recetasDeEsteInsumo = (recetas || []).filter((r) => r.insumo === s.insumo);

      let necesidadProyectada = 0;
      for (const receta of recetasDeEsteInsumo) {
        const promedio = promedioVentaProducto(historial, receta.producto, diaSemanaObjetivo);
        necesidadProyectada += promedio * receta.cantidadPorUnidad;
      }

      const necesidadEnvases = necesidadProyectada / tamanoEnvase;
      const stockActual = s.stockActual || 0;
      const stockMinimo = s.stockMinimo || 0;
      // ¿Alcanza el stock actual para cubrir esa venta futura Y seguir
      // sobre el mínimo? Si no, hay que empezar a producir hoy.
      const faltante = necesidadEnvases - (stockActual - stockMinimo);
      const necesitaProducir = faltante > 0;

      items.push({
        insumo: s.insumo,
        diasElaboracion: dias,
        fechaObjetivo: fechaObjetivoISO,
        diaSemanaObjetivo: DIAS_SEMANA[diaSemanaObjetivo],
        ventaPromedioProyectada: round2(necesidadProyectada),
        necesidadEnvases: round2(necesidadEnvases),
        stockActual,
        stockMinimo,
        necesitaProducir,
        unidadesAProducir: necesitaProducir ? Math.ceil(faltante) : 0,
      });
    }

    items.sort((a, b) => (b.necesitaProducir - a.necesitaProducir) || (b.unidadesAProducir - a.unidadesAProducir));

    return jsonResponse(200, { ok: true, fechaHoy: hoy.toISOString().slice(0, 10), items });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo calcular el pronóstico de fabricación.', detail: String(e) });
  }
};

// Promedia cuánto se vendió de "producto" en los días guardados que caen en
// el mismo día de la semana (0=domingo...6=sábado). Si no hay ninguno,
// promedia con TODOS los días guardados (mejor una estimación gruesa que
// nada).
function promedioVentaProducto(historial, producto, diaSemanaObjetivo) {
  const cantidadesMismoDia = [];
  const cantidadesTodas = [];

  for (const dia of historial) {
    const p = (dia.products || []).find((x) => x.name === producto);
    const cantidad = p ? p.quantity : 0;
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
