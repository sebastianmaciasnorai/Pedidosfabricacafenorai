// netlify/functions/ventas-fabrica.js
//
// Módulo standalone para la app de pedidos a fábrica. Junta y adapta dos
// piezas ya probadas en el dashboard de ventas de Norai:
//
//   1. La llamada en vivo a Toteat + el desglose por categoría/producto
//      (misma lógica de sales-analytics.js).
//   2. El cálculo de "tendencia de cierre" (misma lógica del index.html del
//      dashboard) -- acá se agrega en DOS versiones:
//        a) por ingreso total del día (igual que el dashboard)
//        b) por CANTIDAD de cada producto -- esta es la que en realidad te
//           sirve para pedidos a fábrica: "a este ritmo, hoy vas a vender
//           ~42 croissants", por ejemplo.
//
// DIFERENCIA IMPORTANTE con sales-analytics.js: ese archivo le pide a Toteat
// el rango completo de una sola pasada. Ya vimos que pedirle 7+ días de una
// sola vez puede perder datos en silencio (rate limit). Acá se pide DÍA POR
// DÍA -- en tandas de 3 en paralelo, con 250ms de pausa entre tandas, hasta
// 3 reintentos por día, y una segunda pasada secuencial al final para lo que
// haya quedado pendiente.
//
// Variables de entorno necesarias (las mismas que ya usa el dashboard):
//   TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU
//
// ---- Uso como función de Netlify ----
//   GET /.netlify/functions/ventas-fabrica?ini=20260801&end=20260828
//   El día que se proyecta (tendenciaCierre) es siempre "end" -- si quieres
//   la tendencia de HOY, deja end=hoy (o simplemente no mandes end/ini y por
//   defecto usa el día de hoy solo).
//
//   Respuesta:
//   {
//     ok: true,
//     rangeIni, rangeEnd,
//     totalRevenue, totalOrders, avgTicket,   <- acumulado de TODO el rango
//     categories, products,                   <- desglose acumulado de TODO el rango
//     daily, hourly,                          <- acumulado de todo el rango
//     porDia: [ { fecha, totalRevenue, totalOrders, hourly, products, categories, productsByHour }, ... ],
//     tendenciaCierre: { horaCorte, ventaHastaAhora, ordenesHastaAhora, proyeccionCierre, nota } | null,
//     tendenciaCierrePorProducto: [ { producto, categoria, unidadesVendidasHastaAhora, unidadesProyectadasCierre, nota }, ... ] | null,
//     diasConError: ['20260823', ...]  // solo si algún día falló incluso tras reintentar
//   }
//
// ---- Uso como módulo (si tu app de pedidos corre en el mismo runtime Node) ----
//   const { obtenerVentasEnVivo, calcularTendenciaCierre, calcularTendenciaCierrePorProducto } = require('./ventas-fabrica');
//
// NOTA DE SEGURIDAD: esta función, tal cual, NO exige login -- a diferencia
// de sales-analytics.js / dias-guardados.js en el dashboard, que ahora piden
// un token (ver netlify/functions/_auth.js). Si vas a exponer este endpoint
// igual que esos, agrégale el mismo chequeo al principio del handler:
//   const { verificarToken } = require('./_auth');
//   const auth = verificarToken(event.headers.authorization || event.headers.Authorization);
//   if (!auth.ok) return jsonResponse(401, { ok:false, error: auth.error });

const FUNCTION_VERSION = 'ventas-fabrica v1';

// Umbral de confianza: recién a partir de esta cantidad de boletas hoy se
// confía 100% en el "ritmo" calculado contra la semana pasada. Antes de eso,
// se mezcla con el promedio de días anteriores (ver calcularTendenciaCierre).
const UMBRAL_ORDENES_CONFIANZA = 15;

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  if (qs.debug === 'ping') {
    return jsonResponse(200, { ok: true, version: FUNCTION_VERSION, receivedAt: new Date().toISOString() });
  }

  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  const today = formatYYYYMMDD(new Date());
  const ini = qs.ini || today;
  const end = qs.end || today;

  try {
    const resumen = await obtenerVentasEnVivo(ini, end, { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU });
    const fechaAProyectarISO = yyyymmddToISO(end); // se proyecta el último día del rango pedido
    resumen.tendenciaCierre = calcularTendenciaCierre(resumen.porDia, fechaAProyectarISO);
    resumen.tendenciaCierrePorProducto = calcularTendenciaCierrePorProducto(resumen.porDia, fechaAProyectarISO);
    return jsonResponse(200, resumen);
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo conectar con Toteat o se rechazó la consulta.', detail: String(e) });
  }
};

// ============================================================
// LLAMADA EN VIVO A TOTEAT (día por día, con reintentos)
// ============================================================

async function fetchToteatDia(fechaYYYYMMDD, creds, intentos = 3) {
  const url = new URL('https://api.toteat.com/mw/or/1.0/sales');
  url.searchParams.set('xir', creds.TOTEAT_XIR);
  url.searchParams.set('xil', creds.TOTEAT_XIL);
  url.searchParams.set('xiu', creds.TOTEAT_XIU);
  url.searchParams.set('xapitoken', creds.TOTEAT_API_TOKEN);
  url.searchParams.set('ini', fechaYYYYMMDD);
  url.searchParams.set('end', fechaYYYYMMDD);
  url.searchParams.set('detail_cancel_order', 'true');

  let ultimoError;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error('Toteat rechazó la consulta: ' + JSON.stringify(data));
      return (data && data.data) || [];
    } catch (e) {
      ultimoError = e;
      if (intento < intentos) await esperar(300 * intento);
    }
  }
  throw ultimoError;
}

// Trae el rango [iniYYYYMMDD, endYYYYMMDD] pidiendo día por día (tandas de 3
// en paralelo + pausa + segunda pasada secuencial para reintentos), y arma
// tanto el resumen acumulado del rango como el detalle por día (porDia),
// necesario para calcular la tendencia de cierre.
async function obtenerVentasEnVivo(iniYYYYMMDD, endYYYYMMDD, creds) {
  const fechas = listaFechasEntre(iniYYYYMMDD, endYYYYMMDD);
  const porDiaMap = new Map(); // fechaYYYYMMDD -> resumen del día | null (pendiente)
  const TAMANO_TANDA = 3;
  const PAUSA_MS = 250;

  for (let i = 0; i < fechas.length; i += TAMANO_TANDA) {
    const tanda = fechas.slice(i, i + TAMANO_TANDA);
    const resultados = await Promise.allSettled(tanda.map((f) => fetchToteatDia(f, creds)));
    resultados.forEach((r, idx) => {
      const f = tanda[idx];
      porDiaMap.set(f, r.status === 'fulfilled' ? resumirDia(f, r.value) : null);
    });
    if (i + TAMANO_TANDA < fechas.length) await esperar(PAUSA_MS);
  }

  // Segunda pasada secuencial para los días que fallaron en la primera tanda.
  const diasConError = [];
  for (const f of fechas) {
    if (porDiaMap.get(f) == null) {
      try {
        const raw = await fetchToteatDia(f, creds);
        porDiaMap.set(f, resumirDia(f, raw));
      } catch (e) {
        diasConError.push(f);
      }
    }
  }

  const porDia = fechas.filter((f) => porDiaMap.get(f)).map((f) => porDiaMap.get(f));

  // Mezcla todos los días del rango en un solo resumen acumulado (equivalente
  // a lo que hacía sales-analytics.js pidiendo el rango de una sola vez).
  const byCategory = new Map(), byProduct = new Map(), byHourGlobal = new Map();
  let totalRevenue = 0, totalOrders = 0;
  const daily = [];

  for (const dia of porDia) {
    totalRevenue += dia.totalRevenue;
    totalOrders += dia.totalOrders;
    daily.push({
      date: dia.fecha,
      revenue: dia.totalRevenue,
      orders: dia.totalOrders,
      avgTicket: dia.totalOrders > 0 ? round2(dia.totalRevenue / dia.totalOrders) : 0,
    });
    dia.categories.forEach((c) => {
      const e = byCategory.get(c.name) || { revenue: 0, quantity: 0 };
      e.revenue += c.revenue; e.quantity += c.quantity;
      byCategory.set(c.name, e);
    });
    dia.products.forEach((p) => {
      const e = byProduct.get(p.name) || { revenue: 0, quantity: 0, category: p.category };
      e.revenue += p.revenue; e.quantity += p.quantity;
      byProduct.set(p.name, e);
    });
    dia.hourly.forEach((h) => {
      const e = byHourGlobal.get(h.hour) || { revenue: 0, orders: 0 };
      e.revenue += h.revenue; e.orders += h.orders;
      byHourGlobal.set(h.hour, e);
    });
  }

  const categories = [...byCategory.entries()]
    .map(([name, v]) => ({ name, revenue: round2(v.revenue), quantity: v.quantity, pct: totalRevenue > 0 ? round2((v.revenue / totalRevenue) * 100) : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
  const products = [...byProduct.entries()]
    .map(([name, v]) => ({ name, revenue: round2(v.revenue), quantity: v.quantity, category: v.category }))
    .sort((a, b) => b.revenue - a.revenue);
  const hourly = [...byHourGlobal.entries()]
    .map(([hour, v]) => ({ hour, revenue: round2(v.revenue), orders: v.orders }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  return {
    ok: true,
    rangeIni: iniYYYYMMDD,
    rangeEnd: endYYYYMMDD,
    totalRevenue: round2(totalRevenue),
    totalOrders,
    avgTicket: totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0,
    categories, products, daily, hourly,
    porDia,
    diasConError: diasConError.length ? diasConError : undefined,
  };
}

// Resume un solo día de ventas crudas de Toteat: totales, por categoría, por
// producto, por hora, y por producto-y-hora (esto último es lo que permite
// calcular después la tendencia de cierre POR PRODUCTO).
function resumirDia(fechaYYYYMMDD, rawSalesAll) {
  const sales = (rawSalesAll || []).filter((s) => s.fiscalType !== 'NC');

  const byCategory = new Map();
  const byProduct = new Map();
  const byHour = new Map();
  const byProductHour = new Map(); // nombre producto -> Map(hora -> cantidad)
  let totalRevenue = 0;
  let totalOrders = 0;

  for (const sale of sales) {
    totalOrders += 1;
    const monto = getConsumoAmount(sale);
    totalRevenue += monto;

    const { hourStr } = splitDateHour(sale.dateClosed);
    if (hourStr) {
      const h = byHour.get(hourStr) || { revenue: 0, orders: 0 };
      h.revenue += monto; h.orders += 1;
      byHour.set(hourStr, h);
    }

    const rawProducts = mergeModifiers(sale.products || []);
    for (const p of rawProducts) {
      const isModifierLine = Number(p.payed) === 0 && Number(p.quantity || 1) >= 1 && String(p.name || '').trim() === '';
      if (isModifierLine) continue;

      const catName = getCategoryName(p);
      const cat = byCategory.get(catName) || { revenue: 0, quantity: 0 };
      cat.revenue += Number(p.payed) || 0; cat.quantity += Number(p.quantity) || 0;
      byCategory.set(catName, cat);

      const prodKey = p.name || '(sin nombre)';
      const prod = byProduct.get(prodKey) || { revenue: 0, quantity: 0, category: catName };
      prod.revenue += Number(p.payed) || 0; prod.quantity += Number(p.quantity) || 0;
      byProduct.set(prodKey, prod);

      if (hourStr) {
        const porHora = byProductHour.get(prodKey) || new Map();
        porHora.set(hourStr, (porHora.get(hourStr) || 0) + (Number(p.quantity) || 0));
        byProductHour.set(prodKey, porHora);
      }
    }
  }

  const categories = [...byCategory.entries()]
    .map(([name, v]) => ({ name, revenue: round2(v.revenue), quantity: v.quantity }))
    .sort((a, b) => b.revenue - a.revenue);
  const products = [...byProduct.entries()]
    .map(([name, v]) => ({ name, revenue: round2(v.revenue), quantity: v.quantity, category: v.category }))
    .sort((a, b) => b.revenue - a.revenue);
  const hourly = [...byHour.entries()]
    .map(([hour, v]) => ({ hour, revenue: round2(v.revenue), orders: v.orders }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  const productsByHour = {};
  for (const [nombre, porHora] of byProductHour.entries()) {
    productsByHour[nombre] = {};
    for (const [hora, qty] of porHora.entries()) productsByHour[nombre][hora] = qty;
  }

  return {
    fecha: yyyymmddToISO(fechaYYYYMMDD),
    totalRevenue: round2(totalRevenue),
    totalOrders,
    categories, products, hourly, productsByHour,
  };
}

// ============================================================
// TENDENCIA DE CIERRE (misma lógica del dashboard, portada a Node puro)
// ============================================================

function acumHasta(dia, hastaHora) {
  return (dia.hourly || [])
    .filter((h) => Number(h.hour) <= hastaHora)
    .reduce((acc, h) => ({ revenue: acc.revenue + h.revenue, orders: acc.orders + h.orders }), { revenue: 0, orders: 0 });
}

// Proyección de INGRESO de cierre para el día "fechaHoyISO" (formato
// YYYY-MM-DD), usando el ritmo del mismo día de la semana pasada, mezclado
// con el promedio de los demás días presentes en porDia (mientras haya pocas
// boletas hoy, para no dar proyecciones inestables a primera hora -- ver
// explicación completa en los comentarios de index.html del dashboard).
function calcularTendenciaCierre(porDia, fechaHoyISO) {
  const hoy = porDia.find((d) => d.fecha === fechaHoyISO);
  if (!hoy || hoy.totalOrders === 0) return null;

  const horasConVenta = (hoy.hourly || []).filter((h) => h.orders > 0).map((h) => Number(h.hour));
  const horaCorte = horasConVenta.length ? Math.max(...horasConVenta) : new Date().getHours();
  const rHoy = acumHasta(hoy, horaCorte);

  const fechaSemanaPasada = sumarDiasISO(fechaHoyISO, -7);
  const semanaPasada = porDia.find((d) => d.fecha === fechaSemanaPasada);

  const diasAnteriores = porDia.filter((d) => d.fecha !== fechaHoyISO && d.totalRevenue > 0);
  const promedioDiasAnteriores = diasAnteriores.length
    ? diasAnteriores.reduce((s, d) => s + d.totalRevenue, 0) / diasAnteriores.length
    : null;

  const pesoRitmo = Math.min(1, rHoy.orders / UMBRAL_ORDENES_CONFIANZA);

  let proyeccion = null, nota = '';

  if (semanaPasada && semanaPasada.totalRevenue > 0) {
    const proporcionYaVendida = acumHasta(semanaPasada, horaCorte).revenue / semanaPasada.totalRevenue;
    if (proporcionYaVendida > 0.02) { // evita proyecciones disparatadas con muy poca info
      const proyeccionRitmo = rHoy.revenue / proporcionYaVendida;
      if (promedioDiasAnteriores != null && pesoRitmo < 1) {
        proyeccion = Math.round(pesoRitmo * proyeccionRitmo + (1 - pesoRitmo) * promedioDiasAnteriores);
        nota = `${rHoy.orders} boleta(s) hoy · ${Math.round(pesoRitmo * 100)}% ritmo semana pasada + ${Math.round((1 - pesoRitmo) * 100)}% promedio días anteriores`;
      } else {
        proyeccion = Math.round(proyeccionRitmo);
        nota = 'ritmo de la semana pasada';
      }
    }
  }
  if (proyeccion == null && promedioDiasAnteriores != null) {
    proyeccion = Math.round(promedioDiasAnteriores);
    nota = 'sin dato del mismo día la semana pasada -- se usó el promedio de días anteriores';
  }

  return {
    horaCorte,
    ventaHastaAhora: round2(rHoy.revenue),
    ordenesHastaAhora: rHoy.orders,
    proyeccionCierre: proyeccion,
    nota,
  };
}

// Igual que calcularTendenciaCierre, pero por UNIDADES de cada producto en
// vez de ingreso total -- esto es lo útil para decidir cuánto pedir a la
// fábrica ("a este ritmo hoy vendemos ~42 croissants").
//
// OJO / simplificación consciente: el "peso de confianza" (pesoRitmo) se
// calcula una sola vez con el total de boletas del día, no por producto --
// muchos productos individuales nunca juntan boletas propias suficientes
// como para tener su propia curva de confianza. Si con el tiempo ves que
// algún producto puntual da proyecciones raras, este es el primer lugar
// donde ajustar (por ejemplo, ponderando también por cantidad de unidades
// vendidas del producto en sí, no solo boletas totales).
function calcularTendenciaCierrePorProducto(porDia, fechaHoyISO) {
  const hoy = porDia.find((d) => d.fecha === fechaHoyISO);
  if (!hoy || hoy.totalOrders === 0) return null;

  const horasConVenta = (hoy.hourly || []).filter((h) => h.orders > 0).map((h) => Number(h.hour));
  const horaCorte = horasConVenta.length ? Math.max(...horasConVenta) : new Date().getHours();
  const pesoRitmo = Math.min(1, acumHasta(hoy, horaCorte).orders / UMBRAL_ORDENES_CONFIANZA);

  const fechaSemanaPasada = sumarDiasISO(fechaHoyISO, -7);
  const semanaPasada = porDia.find((d) => d.fecha === fechaSemanaPasada);
  const diasAnteriores = porDia.filter((d) => d.fecha !== fechaHoyISO);

  return (hoy.products || []).map((prodHoy) => {
    const nombre = prodHoy.name;
    const qtyHoyHastaHora = qtyProductoHasta(hoy, nombre, horaCorte);

    const cantidadesAnteriores = diasAnteriores.map((d) => qtyProductoTotalDia(d, nombre)).filter((q) => q > 0);
    const promedioAnteriores = cantidadesAnteriores.length
      ? cantidadesAnteriores.reduce((s, q) => s + q, 0) / cantidadesAnteriores.length
      : null;

    let proyeccion = null, nota = '';

    if (semanaPasada) {
      const totalSemanaPasada = qtyProductoTotalDia(semanaPasada, nombre);
      const hastaHoraSemanaPasada = qtyProductoHasta(semanaPasada, nombre, horaCorte);
      if (totalSemanaPasada > 0) {
        const proporcion = hastaHoraSemanaPasada / totalSemanaPasada;
        if (proporcion > 0.02) {
          const proyeccionRitmo = qtyHoyHastaHora / proporcion;
          if (promedioAnteriores != null && pesoRitmo < 1) {
            proyeccion = Math.round(pesoRitmo * proyeccionRitmo + (1 - pesoRitmo) * promedioAnteriores);
            nota = `${Math.round(pesoRitmo * 100)}% ritmo semana pasada + ${Math.round((1 - pesoRitmo) * 100)}% promedio días anteriores`;
          } else {
            proyeccion = Math.round(proyeccionRitmo);
            nota = 'ritmo de la semana pasada';
          }
        }
      }
    }
    if (proyeccion == null && promedioAnteriores != null) {
      proyeccion = Math.round(promedioAnteriores);
      nota = 'sin ritmo de la semana pasada para este producto -- se usó el promedio de días anteriores';
    }
    if (proyeccion == null) {
      proyeccion = qtyHoyHastaHora;
      nota = 'sin historial suficiente para proyectar -- se muestra solo lo vendido hasta ahora';
    }

    return {
      producto: nombre,
      categoria: prodHoy.category,
      unidadesVendidasHastaAhora: qtyHoyHastaHora,
      unidadesProyectadasCierre: proyeccion,
      nota,
    };
  }).sort((a, b) => b.unidadesProyectadasCierre - a.unidadesProyectadasCierre);
}

function qtyProductoHasta(dia, nombreProducto, hastaHora) {
  const porHora = dia.productsByHour && dia.productsByHour[nombreProducto];
  if (!porHora) return 0;
  return Object.entries(porHora).reduce((suma, [hora, qty]) => (Number(hora) <= hastaHora ? suma + qty : suma), 0);
}

function qtyProductoTotalDia(dia, nombreProducto) {
  const p = (dia.products || []).find((x) => x.name === nombreProducto);
  return p ? p.quantity : 0;
}

// ============================================================
// HELPERS (idénticos a sales-analytics.js / lookup-receipt.js)
// ============================================================

// Junta cada modificador/variante (ej: sabor de tartaleta, "Sin Lactosa" de
// un café) con su producto padre. Toteat NO manda el modificador con un
// guion "-" al principio del nombre (como se asumía antes) -- lo manda como
// una línea aparte cuyo campo "lineReference" apunta al "lineId" de la
// línea del producto principal. Ejemplo real de Toteat:
//   { lineId: 111, lineReference: 0,   name: "Tartaleta" }       <- producto
//   { lineId: 112, lineReference: 111, name: "Pie de Limon" }    <- variante
// Un producto puede tener más de un modificador (ej: un jugo con "SIN
// Azucar" + sabor "Frutilla"), y en ese caso se van concatenando todos.
function mergeModifiers(rawProducts) {
  const merged = [];
  const indexPorLineId = new Map();

  for (const p of rawProducts) {
    const esModificador = p.lineReference != null && Number(p.lineReference) !== 0;

    if (esModificador) {
      const idxPadre = indexPorLineId.get(p.lineReference);
      const modText = String(p.name || '').trim();
      if (idxPadre != null && modText) {
        merged[idxPadre].name = merged[idxPadre].name + ' (' + modText + ')';
      }
      continue;
    }

    const rawName = String(p.name || '').trim();
    merged.push(Object.assign({}, p, { name: rawName }));
    if (p.lineId != null) indexPorLineId.set(p.lineId, merged.length - 1);
  }
  return merged;
}

// Nombre de categoría de un producto. Mismos candidatos que sales-analytics.js
// -- pendiente de confirmar el campo exacto con ?debug=raw contra una venta real.
function getCategoryName(p) {
  const candidate = p.hierarchyName || p.hierarchy || p.categoryName || p.category || p.familyName || p.groupName;
  return candidate ? String(candidate) : 'Sin categoría';
}

// El monto que cuenta es el consumo, sin propina.
function getConsumoAmount(sale) {
  const directCandidates = [sale.total, sale.subtotal, sale.consumo, sale.amountConsumo, sale.saleTotal];
  for (const c of directCandidates) {
    if (c != null && !isNaN(Number(c))) return Number(c);
  }
  const tip = Number(sale.tip || sale.propina || sale.gratuity || sale.tips || 0);
  return Number(sale.payed || 0) - tip;
}

// Separa dateClosed (ej: "2026-08-26 14:03:37") en fecha y hora (2 dígitos).
function splitDateHour(dateClosed) {
  if (!dateClosed) return { dateStr: null, hourStr: null };
  const str = String(dateClosed);
  const match = str.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (match) return { dateStr: match[1], hourStr: match[2] };
  const dateOnly = str.match(/(\d{4}-\d{2}-\d{2})/);
  return { dateStr: dateOnly ? dateOnly[1] : null, hourStr: null };
}

function listaFechasEntre(iniYYYYMMDD, endYYYYMMDD) {
  const ini = parseYYYYMMDD(iniYYYYMMDD);
  const end = parseYYYYMMDD(endYYYYMMDD);
  const fechas = [];
  const cursor = new Date(ini);
  while (cursor <= end) {
    fechas.push(formatYYYYMMDD(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return fechas;
}

function parseYYYYMMDD(s) {
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
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

function sumarDiasISO(iso, dias) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

module.exports = {
  obtenerVentasEnVivo,
  calcularTendenciaCierre,
  calcularTendenciaCierrePorProducto,
};
