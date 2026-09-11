// node-postgres materialises a SQL `date` as local midnight, so toISOString() shifts it
// a day earlier wherever the server runs ahead of UTC (BST included). Read the local
// components instead — a `date` carries no time or zone and must not acquire one.
export const dateOnly = (value: Date | string) => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
  : String(value).slice(0, 10);

export const isoTimestamp = (value: Date | string) => value instanceof Date ? value.toISOString() : String(value);
