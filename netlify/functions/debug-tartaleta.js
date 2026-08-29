// netlify/functions/debug-tartaleta.js
//
// TEMPORAL -- solo para diagnóstico. Revisa un rango de días y separa las
// ventas de un producto (por defecto "Tartaleta") en dos grupos:
//   - conSabor: el cliente sí eligió una variante (ej: "Manzana")
//   - sinSabor: la línea del producto quedó sola, sin ninguna línea de
//     variante apuntándole -- por eso aparece como "Tartaleta" genérica.
// Devuelve fecha y hora exactas de cada venta "sin sabor" para que puedas
// ir a buscar la boleta en Toteat y confirmar qué pasó.
//
// Bórrala cuando ya no la necesites.
//
// GET /.netlify/functions/debug-tartaleta?producto=Tartaleta&dias=7

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  const producto = (qs.producto || 'Tartaleta').trim().toLowerCase();
  const dias = Number(qs.dias) || 7;
  const end = formatYYYYMMDD(new Date());
  const fechas = ultimosNDias(end, dias);

  const conSabor = [];
  const sinSabor = [];
  const diasConError = [];

  for (const fecha of fechas) {
    let sales;
    try {
      sales = await fetchToteatDia(fecha, { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU });
      await esperar(300); // pequeña pausa entre días para no gatillar el rate limit de Toteat
    } catch (e) {
      diasConError.push(fecha);
      continue;
    }

    for (const sale of sales) {
      const productos = sale.products || [];
      // líneas principales (no son variante de otra) cuyo nombre calza con "producto"
      const lineasProducto = productos.filter(
        (p) => (p.lineReference == null || Number(p.lineReference) === 0) &&
               String(p.name || '').trim().toLowerCase() === producto
      );

      for (const linea of lineasProducto) {
        const variante = productos.find(
          (p) => p.lineReference != null && Number(p.lineReference) === Number(linea.lineId)
        );
        const entrada = {
          fecha: sale.dateClosed,
          precio: linea.payed,
        };
        if (variante) {
          entrada.sabor = variante.name;
          conSabor.push(entrada);
        } else {
          sinSabor.push(entrada);
        }
      }
    }
  }

  return jsonResponse(200, {
    ok: true,
    producto: qs.producto || 'Tartaleta',
    rangoDias: dias,
    totalConSabor: conSabor.length,
    totalSinSabor: sinSabor.length,
    ventasSinSabor: sinSabor,
    ejemploConSabor: conSabor.slice(0, 5),
    diasConError: diasConError.length ? diasConError : undefined,
  });
};

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
      if (!res.ok || data.ok === false) throw new Error('Toteat rechazó la consulta para ' + fechaYYYYMMDD);
      return (data && data.data) || [];
    } catch (e) {
      ultimoError = e;
      if (intento < intentos) await esperar(400 * intento);
    }
  }
  throw ultimoError;
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ultimosNDias(endYYYYMMDD, n) {
  const end = new Date(
    Number(endYYYYMMDD.slice(0, 4)),
    Number(endYYYYMMDD.slice(4, 6)) - 1,
    Number(endYYYYMMDD.slice(6, 8))
  );
  const fechas = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    fechas.push(formatYYYYMMDD(d));
  }
  return fechas;
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
    body: JSON.stringify(body, null, 2),
  };
}

