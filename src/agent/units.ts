// convert_units: offline unit conversion. Each unit is a factor to its
// category's base unit; temperature is handled separately (offsets).

type Category = 'length' | 'mass' | 'volume' | 'speed' | 'area' | 'data' | 'time';

const UNITS: Record<Category, Record<string, number>> = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318 },
  volume: { l: 1, ml: 0.001, cl: 0.01, dl: 0.1, m3: 1000, cm3: 0.001, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625, tbsp: 0.01478676478125, tsp: 0.00492892159375, ukgal: 4.54609 },
  speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 0.514444, 'ft/s': 0.3048 },
  area: { m2: 1, km2: 1e6, cm2: 1e-4, ha: 1e4, acre: 4046.8564224, ft2: 0.09290304, mi2: 2589988.110336, in2: 0.00064516 },
  data: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, bit: 1 / 8 },
  time: { s: 1, ms: 0.001, min: 60, h: 3600, day: 86400, week: 604800, month: 2629746, year: 31556952 },
};

const ALIASES: Record<string, string> = {
  meter: 'm', meters: 'm', metre: 'm', metres: 'm', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
  centimeter: 'cm', centimeters: 'cm', millimeter: 'mm', millimeters: 'mm', micrometer: 'um', 'µm': 'um',
  mile: 'mi', miles: 'mi', yard: 'yd', yards: 'yd', foot: 'ft', feet: 'ft', inch: 'in', inches: 'in', '"': 'in', "'": 'ft',
  nauticalmile: 'nmi', nauticalmiles: 'nmi',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg', gram: 'g', grams: 'g', milligram: 'mg', milligrams: 'mg',
  tonne: 't', tonnes: 't', ton: 't', tons: 't', pound: 'lb', pounds: 'lb', lbs: 'lb', ounce: 'oz', ounces: 'oz', stone: 'st',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml',
  gallon: 'gal', gallons: 'gal', usgal: 'gal', quart: 'qt', quarts: 'qt', pint: 'pt', pints: 'pt', cups: 'cup',
  fluidounce: 'floz', fluidounces: 'floz', 'fl.oz': 'floz', tablespoon: 'tbsp', tablespoons: 'tbsp', teaspoon: 'tsp', teaspoons: 'tsp',
  'm³': 'm3', 'cm³': 'cm3', cc: 'cm3', impgal: 'ukgal',
  kmh: 'km/h', kph: 'km/h', 'km/hr': 'km/h', mps: 'm/s', knot: 'kn', knots: 'kn', fps: 'ft/s',
  'm²': 'm2', sqm: 'm2', 'km²': 'km2', sqkm: 'km2', hectare: 'ha', hectares: 'ha', acres: 'acre', 'ft²': 'ft2', sqft: 'ft2', 'mi²': 'mi2', 'in²': 'in2',
  byte: 'b', bytes: 'b', kilobyte: 'kb', kilobytes: 'kb', megabyte: 'mb', megabytes: 'mb', gigabyte: 'gb', gigabytes: 'gb',
  terabyte: 'tb', terabytes: 'tb', bits: 'bit',
  sec: 's', secs: 's', second: 's', seconds: 's', millisecond: 'ms', milliseconds: 'ms', minute: 'min', minutes: 'min', mins: 'min',
  hour: 'h', hours: 'h', hr: 'h', hrs: 'h', days: 'day', d: 'day', weeks: 'week', wk: 'week', months: 'month', years: 'year', yr: 'year', yrs: 'year',
};

const TEMPS: Record<string, 'c' | 'f' | 'k'> = {
  c: 'c', '°c': 'c', celsius: 'c', centigrade: 'c', f: 'f', '°f': 'f', fahrenheit: 'f', k: 'k', kelvin: 'k', kelvins: 'k',
};

function norm(u: string): string {
  const s = u.trim().toLowerCase().replace(/\s+/g, '').replace(/^sq(uare)?/, 'sq').replace(/per/g, '/');
  // "square meters" → "sqmeters" → try the m2 form too
  return ALIASES[s] ?? (s.startsWith('sq') && ALIASES[s.slice(2)] ? ALIASES[s.slice(2)] + '2' : s);
}

function lookup(u: string): { cat: Category; factor: number; name: string } | null {
  const n = norm(u);
  for (const [cat, table] of Object.entries(UNITS) as [Category, Record<string, number>][]) {
    if (n in table) return { cat, factor: table[n], name: n };
  }
  return null;
}

function fmt(n: number): string {
  if (n !== 0 && (Math.abs(n) >= 1e12 || Math.abs(n) < 1e-4)) return n.toExponential(4);
  return String(parseFloat(n.toPrecision(8)));
}

export function convertUnits(value: string, from: string, to: string): string {
  const v = parseFloat(value.replace(/[, ]/g, ''));
  if (!Number.isFinite(v)) throw new Error(`"${value}" is not a number`);

  const tf = TEMPS[from.trim().toLowerCase().replace(/^degrees?/, '')], tt = TEMPS[to.trim().toLowerCase().replace(/^degrees?/, '')];
  if (tf || tt) {
    if (!tf || !tt) throw new Error(`Can't convert between "${from}" and "${to}"`);
    const k = tf === 'c' ? v + 273.15 : tf === 'f' ? (v - 32) * 5 / 9 + 273.15 : v;
    const out = tt === 'c' ? k - 273.15 : tt === 'f' ? (k - 273.15) * 9 / 5 + 32 : k;
    const sym = { c: '°C', f: '°F', k: 'K' };
    return `${fmt(v)} ${sym[tf]} = ${fmt(out)} ${sym[tt]}`;
  }

  const a = lookup(from), b = lookup(to);
  if (!a) throw new Error(`Unknown unit "${from}"`);
  if (!b) throw new Error(`Unknown unit "${to}"`);
  if (a.cat !== b.cat) throw new Error(`Can't convert ${a.cat} (${from}) to ${b.cat} (${to})`);
  return `${fmt(v)} ${a.name} = ${fmt((v * a.factor) / b.factor)} ${b.name}`;
}
