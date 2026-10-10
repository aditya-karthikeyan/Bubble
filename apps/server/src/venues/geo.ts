import type { GeoPoint } from '@bubbleworks/shared';

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters. */
export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Walking minutes at about 80 m/min. */
export function walkMinutes(meters: number): number {
  return Math.round(meters / 80);
}
