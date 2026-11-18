import { UnknownCurrencyError } from './money-errors';

function codes(list: string): string[] {
  return list.split(' ');
}

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

const ZERO_DECIMALS = codes('BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF');

const THREE_DECIMALS = codes('BHD IQD JOD KWD LYD OMR TND');

const FOUR_DECIMALS = codes('CLF UYW');

const TWO_DECIMALS = codes(
  'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BMD BND BOB BRL BSD BTN BWP BYN ' +
    'BZD CAD CDF CHF CNY COP CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP ' +
    'GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD ' +
    'KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN ' +
    'NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG ' +
    'SEK SGD SHP SLE SOS SRD SSP STN SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD ' +
    'UYU UZS VES WST XCD YER ZAR ZMW ZWG BOV CHE CHW COU MXV SVC USN VED XAD XCG',
);

const EXPONENTS: ReadonlyMap<string, number> = new Map([
  ...ZERO_DECIMALS.map((code) => [code, 0] as const),
  ...TWO_DECIMALS.map((code) => [code, 2] as const),
  ...THREE_DECIMALS.map((code) => [code, 3] as const),
  ...FOUR_DECIMALS.map((code) => [code, 4] as const),
]);

export function isCurrencyCode(code: string): code is CurrencyCode {
  return EXPONENTS.has(code);
}

export function parseCurrency(code: string): CurrencyCode {
  if (!isCurrencyCode(code)) {
    throw new UnknownCurrencyError(code);
  }
  return code;
}

export function currencyExponent(currency: CurrencyCode): number {
  const exponent = EXPONENTS.get(currency);
  if (exponent === undefined) {
    throw new UnknownCurrencyError(currency);
  }
  return exponent;
}
