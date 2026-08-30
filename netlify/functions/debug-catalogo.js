// netlify/functions/debug-catalogo.js
//
// TEMPORAL -- solo para diagnóstico. Toteat tiene un endpoint /products
// para traer el CATÁLOGO COMPLETO de productos (activos e inactivos,
// se hayan vendido o no en estos días) -- a diferencia de /sales, que solo
// trae lo que efectivamente se vendió. Esto es lo que necesitamos para que
// productos de baja rotación (como "Bagel Huevo Queso") aparezcan en
// Recetas/Mermas aunque no se hayan vendido esta semana.
//
// No tengo confirmado el formato exacto de la respuesta (la documentación
// de Toteat no se pudo leer completa) -- esta función prueba la URL más
// probable, calcada de la de /sales, y devuelve la respuesta cruda tal
// cual para poder ver el formato real y ajustar el resto del sistema.
//
// Bórrala cuando ya no la necesites.
//
// GET /.netlify/functions/debug-catalogo

exports.handler = async () => {
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  // Probamos un par de variantes de URL, calcadas de la de /sales
  // (https://api.toteat.com/mw/or/1.0/sales), ya que no está confirmado
  // si /products vive en el mismo módulo "or" o en otro.
  const candidatas = [
    'https://api.toteat.com/mw/or/1.0/products',
    'https://api.toteat.com/mw/pr/1.0/products',
    'https://api.toteat.com/mw/1.0/products',
  ];

  const resultados = [];
  for (const base of candidatas) {
    const url = new URL(base);
    url.searchParams.set('xir', TOTEAT_XIR);
    url.searchParams.set('xil', TOTEAT_XIL);
    url.searchParams.set('xiu', TOTEAT_XIU);
    url.searchParams.set('xapitoken', TOTEAT_API_TOKEN);

    try {
      const res = await fetch(url.toString());
      const texto = await res.text();
      let cuerpo;
      try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = texto.slice(0, 500); }
      resultados.push({ url: base, status: res.status, ok: res.ok, cuerpo });
    } catch (e) {
      resultados.push({ url: base, error: String(e) });
    }
  }

  return jsonResponse(200, { ok: true, resultados });
};

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
