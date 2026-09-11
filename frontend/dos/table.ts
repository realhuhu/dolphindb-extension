import { convert, DdbType, formati, is_decimal_null_value, number_nulls, type DdbDecimalVectorValue, type DdbVectorObj } from 'dolphindb/browser.js';

type SortValue = string | number | bigint | boolean | null;

/** Keep ordering next to the typed data, before formatting or JSON transport.
 * SQL table widgets likewise sort data in the query/data layer, not its HTML.
 */
export function columnSortRanks(column: DdbVectorObj, count: number, offset = 0): number[] {
  const values: SortValue[] = Array.from({ length: count }, (_, position) => {
    const index = position + offset;
    const { type, value, le } = column;
    if (type === DdbType.decimal32 || type === DdbType.decimal64 || type === DdbType.decimal128) {
      const data = (value as DdbDecimalVectorValue).data;
      const number = data.at(index)!;
      // Every value in a decimal column has the same scale; compare its exact integer.
      return is_decimal_null_value(type, number) ? null : number;
    }
    if (number_nulls.has(type) || type === DdbType.bool) {
      return convert(type, (value as ArrayLike<number | bigint>)[index], le) as SortValue;
    }
    return formati(column, index, { quote: false, grouping: false });
  });
  const compare = (a: SortValue, b: SortValue): number => a === b ? 0 : a === null ? 1 : b === null ? -1
    : typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : a < b ? -1 : 1;
  const order = values.map((_, index) => index).sort((a, b) => compare(values[a], values[b]));
  const ranks = new Array<number>(count);
  let rank = 0;
  order.forEach((index, position) => {
    if (position && compare(values[index], values[order[position - 1]])) { rank++; }
    ranks[index] = rank;
  });
  return ranks;
}
