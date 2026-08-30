// netlify/functions/stock-cafeteria.js
//
// Pestaña "Stock" + pestaña "Mermas". Muestra el stock calculado de cada
// insumo (ver stock-calculado.js) y deja registrar los 3 eventos manuales
// que hacen que ese cálculo siga sirviendo sin tener que contar todo cada
// día:
//
//   - "recepcion": llegó pedido de fábrica (normalmente se dispara desde
//     el botón "Confirmar recepción de hoy" en la pestaña "Pedido de hoy").
//   - "merma": se botó / se dañó / se venció algo. Puede ser:
//       * una merma de INSUMO directo (ej: se echó a perder medio kilo de
//         "Lomo vetado sous vide 250gr" que nunca se vendió) -- resta
//         directo de ese insumo.
//       * una merma de PRODUCTO vendido en Toteat (ej: se cayó un "Bagel
//         Huevo Queso") -- si ese producto tiene receta que lo liga a un
//         insumo de fábrica, se explota igual que una venta y también
//         descuenta ese insumo. Si no tiene receta, queda solo de registro.
//   - "conteo": alguien contó de verdad -- resetea el punto de partida
//     (botón "Recontar").
//
// GET  /.netlify/functions/stock-cafeteria
//   -> { ok, items: [...stock calculado por insumo...], mermasHoy: [...] }
//
// POST /.netlify/functions/stock-cafeteria
//   body: { accion: 'merma', tipo: 'insumo', insumo, cantidad, motivo? }
//   body: { accion: 'merma', tipo: 'producto', producto, codigoProducto?, cantidad, motivo? }
//   body: { accion: 'merma', tipo: 'producto-sabor', producto, patronToken, codigoBase?, patronCodigo?, cantidad, motivo? }
//   body: { accion: 'recepcion', items: [{ insumo, cantidad }, ...] }
//   body: { accion: 'conteo', insumo, valor }
//
// SIMPLIFICACIÓN CONSCIENTE: los logs de "mermas" y "recepciones" quedan
// creciendo indefinidamente en Blobs (nunca se podan). Para el volumen de
// una cafetería esto no es un problema en años, pero si algún día pesa
// mucho, lo más simple es archivar/borrar las entradas con fecha anterior
// al ultimoConteoFecha más antiguo entre todos los insumos (ya no aportan
// nada al cálculo de todas formas).

const { getStore } = require('@netlify/blobs');
const { obtenerVentasConCache } = require('./ventas-cache');
const { calcularStockPorInsumo, ahoraLocalTexto } = require('./stock-calculado');

const STORE_NAME = 'pedido-fabrica';

function getBlobStore() {
  return getStore({
    name: STORE_NAME,
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN,
  });
}

exports.handler = async (event) => {
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }
  const store = getBlobStore();

  if (event.httpMethod === 'GET') {
    try {
      const [recetas, stock, mermas, recepciones] = await Promise.all([
        store.get('recetas', { type: 'json' }),
        store.get('stock', { type: 'json' }),
        store.get('mermas', { type: 'json' }),
        store.get('recepciones', { type: 'json' }),
      ]);

      if (!stock || !stock.length) {
        return jsonResponse(200, {
          ok: true,
          items: [],
          mermasHoy: [],
          nota: 'No hay insumos configurados todavía. Ve a la pestaña "Recetas" y agrega el stock inicial.',
        });
      }

      const hoyYYYYMMDD = formatYYYYMMDD(new Date());
      const fechaMasAntiguaYYYYMMDD = (stock || []).reduce((min, s) => {
        const f = (s.ultimoConteoFecha || '').slice(0, 10).replace(/-/g, '');
        return f && f < min ? f : min;
      }, hoyYYYYMMDD);

      const { porDia } = await obtenerVentasConCache(fechaMasAntiguaYYYYMMDD, hoyYYYYMMDD, {
        TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU,
      });

      const items = calcularStockPorInsumo({ recetas: recetas || [], stock, mermas: mermas || [], recepciones: recepciones || [], porDia })
        .sort((a, b) => Number(b.bajoMinimo) - Number(a.bajoMinimo) || a.insumo.localeCompare(b.insumo, 'es'));

      const hoyLocal = ahoraLocalTexto().slice(0, 10);
      const mermasHoy = (mermas || [])
        .filter((m) => (m.fecha || '').slice(0, 10) === hoyLocal)
        .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
        .map((m) => ({ ...m, nombreVisible: nombreVisibleMerma(m) }));

      return jsonResponse(200, { ok: true, items, mermasHoy, mermas: (mermas || []).map((m) => ({ ...m, nombreVisible: nombreVisibleMerma(m) })) });
    } catch (e) {
      return jsonResponse(502, { ok: false, error: 'No se pudo calcular el stock.', detail: String(e) });
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return jsonResponse(400, { ok: false, error: 'Body inválido, se esperaba JSON.' });
    }

    if (body.accion === 'merma') {
      if (!(Number(body.cantidad) > 0)) {
        return jsonResponse(400, { ok: false, error: 'Se espera cantidad > 0.' });
      }

      const tipo = body.tipo === 'producto' || body.tipo === 'producto-sabor' ? body.tipo : 'insumo';
      let entrada = { tipo, cantidad: Number(body.cantidad), motivo: String(body.motivo || '').trim(), fecha: ahoraLocalTexto() };

      if (tipo === 'insumo') {
        if (!body.insumo) return jsonResponse(400, { ok: false, error: 'Se espera { insumo } para merma de tipo "insumo".' });
        entrada.insumo = String(body.insumo).trim();
      } else if (tipo === 'producto') {
        if (!body.producto) return jsonResponse(400, { ok: false, error: 'Se espera { producto } para merma de tipo "producto".' });
        entrada.producto = String(body.producto).trim();
        if (body.codigoProducto) entrada.codigoProducto = String(body.codigoProducto).trim();
      } else if (tipo === 'producto-sabor') {
        if (!body.producto || !body.patronToken) {
          return jsonResponse(400, { ok: false, error: 'Se espera { producto, patronToken } para merma de tipo "producto-sabor".' });
        }
        entrada.producto = String(body.producto).trim();
        entrada.patronToken = String(body.patronToken).trim();
        if (body.codigoBase) entrada.codigoBase = String(body.codigoBase).trim();
        if (body.patronCodigo) entrada.patronCodigo = String(body.patronCodigo).trim();
      }

      const mermas = (await store.get('mermas', { type: 'json' })) || [];
      mermas.push(entrada);
      await store.setJSON('mermas', mermas);
      return jsonResponse(200, { ok: true });
    }

    if (body.accion === 'recepcion') {
      const items = Array.isArray(body.items) ? body.items : [];
      const validos = items.filter((it) => it && it.insumo && Number(it.cantidad) > 0);
      if (!validos.length) {
        return jsonResponse(400, { ok: false, error: 'Se espera { items: [{ insumo, cantidad }, ...] } con al menos un ítem válido.' });
      }
      const recepciones = (await store.get('recepciones', { type: 'json' })) || [];
      const fecha = ahoraLocalTexto();
      validos.forEach((it) => recepciones.push({ insumo: String(it.insumo).trim(), cantidad: Number(it.cantidad), fecha }));
      await store.setJSON('recepciones', recepciones);
      return jsonResponse(200, { ok: true, guardado: validos.length });
    }

    if (body.accion === 'conteo') {
      if (!body.insumo || typeof body.valor !== 'number' || isNaN(body.valor) || body.valor < 0) {
        return jsonResponse(400, { ok: false, error: 'Se espera { insumo, valor (número >= 0) }.' });
      }
      const stock = (await store.get('stock', { type: 'json' })) || [];
      const fila = stock.find((s) => s.insumo === body.insumo);
      if (!fila) {
        return jsonResponse(404, { ok: false, error: `El insumo "${body.insumo}" no está configurado en la pestaña "Recetas".` });
      }
      fila.ultimoConteo = Number(body.valor);
      fila.ultimoConteoFecha = ahoraLocalTexto();
      await store.setJSON('stock', stock);
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(400, { ok: false, error: 'accion debe ser una de: merma, recepcion, conteo.' });
  }

  return jsonResponse(405, { ok: false, error: 'Método no soportado.' });
};

// Texto para mostrar en el historial: el insumo directo, o el producto
// (+ sabor si corresponde) cuando la merma fue de un producto vendido.
function nombreVisibleMerma(m) {
  if (m.tipo === 'producto-sabor') return `${m.producto} (${m.patronToken})`;
  if (m.tipo === 'producto') return m.producto;
  return m.insumo;
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
