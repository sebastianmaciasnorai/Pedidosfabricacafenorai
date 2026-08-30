// netlify/functions/productos-catalogo.js
//
// A diferencia de productos-toteat.js (que solo trae lo que se VENDIÓ en
// los últimos días), esto trae el CATÁLOGO COMPLETO de Toteat -- todos los
// productos activos, se hayan vendido o no. Es lo que permite configurar
// en Recetas productos de baja rotación (ej: "Bagel Huevo Queso") que
// todavía no aparecen en el listado normal porque no se han vendido esta
// semana.
//
// Estructura real del catálogo de Toteat (confirmada con ?debug=raw):
//   - Productos reales: isModifier=false. Su campo "modifiers" declara a
//     qué GRUPO de variantes pertenece (ej: { id:"BA.009", name:"Elige
//     tartaleta" }) -- no trae las opciones en sí.
//   - Opciones de variante: isModifier=true, con categoryId = el id del
//     grupo al que pertenecen (ej: "BA.009"), y su propio "id" es el
//     código de ESA opción puntual (ej: "tarta1" = "Pie de Limón").
//
// GET /.netlify/functions/productos-catalogo

exports.handler = async () => {
  const { TOTEAT_API_TOKEN, TOTEAT_XIR, TOTEAT_XIL, TOTEAT_XIU } = process.env;
  if (!TOTEAT_API_TOKEN || !TOTEAT_XIR || !TOTEAT_XIL || !TOTEAT_XIU) {
    return jsonResponse(500, { ok: false, error: 'Faltan variables de entorno de Toteat en el servidor.' });
  }

  const url = new URL('https://api.toteat.com/mw/or/1.0/products');
  url.searchParams.set('xir', TOTEAT_XIR);
  url.searchParams.set('xil', TOTEAT_XIL);
  url.searchParams.set('xiu', TOTEAT_XIU);
  url.searchParams.set('xapitoken', TOTEAT_API_TOKEN);

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error('Toteat rechazó la consulta: ' + JSON.stringify(data));
    const items = (data && data.data) || [];

    const productosBase = items.filter((p) => !p.isModifier);
    const opciones = items.filter((p) => p.isModifier);

    // Agrupa las opciones de variante por el grupo (categoryId) al que
    // pertenecen -- ej: todas las de categoryId "BA.009" son los sabores
    // de "Elige tartaleta".
    const opcionesPorGrupo = new Map();
    opciones.forEach((o) => {
      if (!opcionesPorGrupo.has(o.categoryId)) opcionesPorGrupo.set(o.categoryId, []);
      opcionesPorGrupo.get(o.categoryId).push({ codigo: o.id, nombre: arreglarAcentos(o.name) });
    });

    const porCategoria = new Map();
    productosBase.forEach((p) => {
      const cat = arreglarAcentos(p.category) || 'Sin categoría';
      if (!porCategoria.has(cat)) porCategoria.set(cat, []);

      // Solo interesan los grupos que efectivamente tienen más de una
      // opción real (si tiene 1 sola opción no vale la pena "agrupar").
      const gruposVariantes = (p.modifiers || [])
        .map((g) => ({ codigoGrupo: g.id, opciones: opcionesPorGrupo.get(g.id) || [] }))
        .filter((g) => g.opciones.length > 1);

      porCategoria.get(cat).push({
        producto: arreglarAcentos(p.name),
        codigo: p.id,
        precioBase: p.price || 0,
        gruposVariantes,
      });
    });

    const categorias = [...porCategoria.entries()]
      .map(([categoria, productos]) => ({
        categoria,
        productos: productos.sort((a, b) => a.producto.localeCompare(b.producto)),
      }))
      .sort((a, b) => a.categoria.localeCompare(b.categoria));

    return jsonResponse(200, { ok: true, categorias });
  } catch (e) {
    return jsonResponse(502, { ok: false, error: 'No se pudo obtener el catálogo desde Toteat.', detail: String(e) });
  }
};

// Mismo arreglo de acentos rotos que ventas-fabrica.js.
function arreglarAcentos(str) {
  if (!str) return str;
  try {
    if (/Ã[\x80-\xBF]|Â[\x80-\xBF]/.test(str)) {
      return Buffer.from(str, 'latin1').toString('utf8');
    }
  } catch (e) {
    // si algo sale mal, mejor devolver el texto original que romper todo
  }
  return str;
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
