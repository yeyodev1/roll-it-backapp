/**
 * Llave de comparación para nombres que llegan escritos de mil formas
 * (SmartMenu, Excel de recetas, facturas): minúsculas, sin tildes ni signos
 * y con un solo espacio.
 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
