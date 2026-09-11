import { DdbForm, DdbType } from 'dolphindb/browser.js';
const types = new Map(Object.entries(DdbType).filter(([, n]) => typeof n === 'number').map(([name, n]) => [Number(n), name.toUpperCase()]));
const forms = new Map(Object.entries(DdbForm).filter(([, n]) => typeof n === 'number').map(([name, n]) => [Number(n), name.toUpperCase()]));
export function ddbTypeName(type: number): string { return types.get(type) ?? (type >= 64 && type < 128 ? `${types.get(type - 64) ?? type - 64}[]` : `TYPE ${type}`); }
export function ddbFormName(form: number): string { return forms.get(form) ?? `FORM ${form}`; }
