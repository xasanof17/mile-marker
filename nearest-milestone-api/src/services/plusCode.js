import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const olc = require('open-location-code').OpenLocationCode;
const instance = new olc();

export class PlusCodeError extends Error {
  constructor(msg) { super(msg); this.code = 'PLUS_CODE_ERROR'; }
}

/**
 * Decode a full Plus Code to { lat, lng }.
 * @param {string} code
 * @returns {{ lat: number, lng: number }}
 */
export function decodePlusCode(code) {
  if (!instance.isValid(code) || !instance.isFull(code)) {
    throw new PlusCodeError(`Invalid or non-full Plus Code: ${code}`);
  }
  const area = instance.decode(code);
  return { lat: area.latitudeCenter, lng: area.longitudeCenter };
}

export const isFull = (str) => {
  try { return instance.isFull(str); } catch { return false; }
};

/**
 * Decode a short/compound Plus Code given a reference lat/lng.
 * @param {string} code  e.g. "PXRX+86"
 * @param {number} refLat
 * @param {number} refLng
 * @returns {{ lat: number, lng: number }}
 */
export function decodeShortCode(code, refLat, refLng) {
  const full = instance.recoverNearest(code, refLat, refLng);
  const area = instance.decode(full);
  return { lat: area.latitudeCenter, lng: area.longitudeCenter };
}
