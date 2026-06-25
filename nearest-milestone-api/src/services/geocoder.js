import axios from 'axios';

export class GeocoderError extends Error {
  constructor(msg) { super(msg); this.code = 'GEOCODER_ERROR'; }
}

/**
 * Geocode a free-text address via Nominatim.
 * @param {string} address
 * @returns {{ lat: number, lng: number }}
 */
export async function geocodeAddress(address) {
  const params = { q: address, format: 'json', limit: 1 };
  const cc = process.env.NOMINATIM_COUNTRY_CODE;
  if (cc) params.countrycodes = cc;

  const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
    params,
    headers: { 'User-Agent': 'nearest-milestone-api/1.0' },
    timeout: 8000,
  });

  if (!data?.length) throw new GeocoderError(`No results for: ${address}`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), _raw: data[0] };
}
