// netlify/functions/stock-calculado.js
//
// Módulo compartido (sin handler, igual que ventas-cache.js) que calcula
// el stock "real" de cada insumo en la cafetería SIN tener que contarlo a
// mano todos los días:
//
//   stockCalculado = últimoConteo
//                   + recepciones registradas desde ese conteo
//                   - ventas REALES de Toteat desde ese conteo (no
//                     proyectadas -- explotadas a insumo vía receta)
//                   - mermas registradas desde ese conteo
//
// Lo usan tanto stock-cafeteria.js (pestaña "Stock y mermas", tabla
// completa) como pedido-fabrica.js (pestaña "Pedido de hoy", que además le
// resta lo que falta vender HOY para proyectar el cierre del día).
//
// IMPORTANTE -- esto no reemplaza el conteo físico, solo evita tener que
// hacerlo todos los días. Mermas no registradas, robos chicos o
// recepciones anotadas con una cantidad distinta a la real generan un
// desvío que se va acumulando con el tiempo. Por eso existe la acción
// "conteo" (botón "Recontar" en la pantalla): cada vez que alguien cuenta
// de verdad, ese número se vuelve el nuevo punto de partida y el desvío
// acumulado hasta ahí queda "perdonado". Se recomienda recontar cada
// cierto tiempo (ej. semanal), no como reemplazo del cálculo diario.
//
// Todas las fechas se guardan como texto "YYYY-MM-DD HH:MM:SS" en hora de
// Chile (America/Santiago) -- el MISMO formato que trae dateClosed de
// Toteat -- para poder compararlas como strings sin líos de huso horario
// (ver ahoraLocalTexto()).

// Explota cantidades de PRODUCTO (vendido u otro) a cantidades de INSUMO,
// usando las mismas reglas de "patronToken" (familias de sabores/variantes
// agrupadas) que ya usa pedido-fabrica.js.
function explotarARecetas(recetas, cantidadPorProducto) {
  const porInsumo = new Map();
  for (const receta of recetas || []) {
    let cantidadProducto = 0;
    if (receta.patronToken) {
      for (const [nombre, cantidad] of cantidadPorProducto.entries()) {
        if (nombre.startsWith(receta.producto) && nombre.includes(receta.patronToken)) {
          cantidadProducto += cantidad;
        }
      }
    } else {
      cantidadProducto = cantidadPorProducto.get(receta.producto) || 0;
    }
    if (cantidadProducto === 0) continue;
    const necesidad = cantidadProducto * receta.cantidadPorUnidad;
    porInsumo.set(receta.insumo, (porInsumo.get(receta.insumo) || 0) + necesidad);
  }
  return porInsumo;
}

// Suma, por producto, las unidades REALMENTE vendidas (no proyectadas) en
// porDia desde fechaDesdeTexto ("YYYY-MM-DD HH:MM:SS") hasta ahora.
// El día completo del conteo se filtra por HORA (usando productsByHour)
// para no contar de nuevo lo que ya se vendió antes del conteo ese mismo
// día; los días posteriores se cuentan completos.
function ventasRealesPorProductoDesde(porDia, fechaDesdeTexto) {
  const fechaCorte = fechaDesdeTexto.slice(0, 10); // YYYY-MM-DD
  const horaCorte = Number(fechaDesdeTexto.slice(11, 13));
  const porProducto = new Map();

  for (const dia of porDia || []) {
    if (dia.fecha < fechaCorte) continue;

    (dia.products || []).forEach((p) => {
      let cantidad = p.quantity;
      if (dia.fecha === fechaCorte) {
        const porHora = (dia.productsByHour && dia.productsByHour[p.name]) || {};
        cantidad = Object.entries(porHora).reduce(
          (acc, [hora, qty]) => (Number(hora) >= horaCorte ? acc + qty : acc),
          0
        );
      }
      if (cantidad > 0) porProducto.set(p.name, (porProducto.get(p.name) || 0) + cantidad);
    });
  }
  return porProducto;
}

// Arma la tabla de stock calculado, un objeto por insumo configurado en
// `stock`. Acepta recetas/mermas/recepciones vacíos o undefined.
function calcularStockPorInsumo({ recetas, stock, mermas, recepciones, porDia }) {
  return (stock || []).map((s) => {
    // Compatibilidad con filas viejas que solo tenían "stockActual" (número
    // tecleado a mano): la primera vez que se calcula, ese número se toma
    // como si fuera el conteo real hecho "ahora".
    const ultimoConteo = Number(s.ultimoConteo ?? s.stockActual ?? 0);
    const ultimoConteoFecha = s.ultimoConteoFecha || ahoraLocalTexto();

    const ventasPorProducto = ventasRealesPorProductoDesde(porDia, ultimoConteoFecha);
    const vendidoPorInsumo = explotarARecetas(recetas, ventasPorProducto);
    const vendido = round2(vendidoPorInsumo.get(s.insumo) || 0);

    const recibido = round2((recepciones || [])
      .filter((r) => r.insumo === s.insumo && r.fecha > ultimoConteoFecha)
      .reduce((acc, r) => acc + (Number(r.cantidad) || 0), 0));

    const merma = round2((mermas || [])
      .filter((m) => m.insumo === s.insumo && m.fecha > ultimoConteoFecha)
      .reduce((acc, m) => acc + (Number(m.cantidad) || 0), 0));

    const stockCalculado = round2(ultimoConteo + recibido - vendido - merma);
    const stockMinimo = Number(s.stockMinimo || 0);

    return {
      insumo: s.insumo,
      unidadEnvase: s.unidadEnvase || 'un',
      tamanoEnvase: s.tamanoEnvase > 0 ? s.tamanoEnvase : 1,
      diasElaboracion: Number(s.diasElaboracion || 0),
      ultimoConteo,
      ultimoConteoFecha,
      recibido,
      vendido,
      merma,
      stockCalculado,
      stockMinimo,
      bajoMinimo: stockCalculado < stockMinimo,
    };
  });
}

// "YYYY-MM-DD HH:MM:SS" en hora de Chile -- mismo formato que dateClosed
// de Toteat, para poder comparar fechas como texto sin convertir husos.
function ahoraLocalTexto(fecha = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(fecha).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = {
  calcularStockPorInsumo,
  explotarARecetas,
  ventasRealesPorProductoDesde,
  ahoraLocalTexto,
};
