import { describe, expect, it } from 'vitest';
import { convertOverpass, dietTagsFor, normalizeCuisine, normalizePhone } from './osm.js';

describe('osm conversion', () => {
  it('normalizes phones to E.164', () => {
    expect(normalizePhone('+1-919-489-5776')).toBe('+19194895776');
    expect(normalizePhone('+1 919 942 5161')).toBe('+19199425161');
    expect(normalizePhone('919-967-2678')).toBe('+19199672678');
    expect(normalizePhone('+1 917-767-2888;+1 555 000 0000')).toBe('+19177672888');
    expect(normalizePhone('555')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('folds cuisines into persona keys', () => {
    expect(normalizeCuisine('burger;breakfast', 'restaurant')).toBe('american');
    expect(normalizeCuisine('coffee_shop', 'cafe')).toBe('coffee');
    expect(normalizeCuisine(undefined, 'cafe')).toBe('coffee');
    expect(normalizeCuisine(undefined, 'restaurant')).toBe('other');
    expect(normalizeCuisine('greek', 'restaurant')).toBe('mediterranean');
    expect(normalizeCuisine('Thai', 'restaurant')).toBe('thai');
  });

  it('derives diet tags from OSM tags and cuisine rules', () => {
    expect(dietTagsFor({ 'diet:vegan': 'yes', 'diet:meat': 'yes' }, 'american')).toEqual([
      'vegan',
      'vegetarian',
    ]);
    expect(dietTagsFor({}, 'indian')).toEqual(['vegan', 'vegetarian']);
    expect(dietTagsFor({}, 'american')).toEqual([]);
    expect(dietTagsFor({ cuisine: 'turkish' }, 'mediterranean')).toContain('halal');
  });

  it('keeps only elements with phone, hours, name, and location', () => {
    const { venues, rejections } = convertOverpass({
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 35.9,
          lon: -79.0,
          tags: {
            name: 'A',
            phone: '+1 919 555 0001',
            opening_hours: 'Mo-Su 11:00-22:00',
            cuisine: 'pizza',
            wheelchair: 'yes',
            'addr:housenumber': '1',
            'addr:street': 'Main St',
          },
        },
        {
          type: 'way',
          id: 2,
          center: { lat: 35.9, lon: -79.0 },
          tags: { name: 'B', phone: '+1 919 555 0002' },
        },
        { type: 'node', id: 3, lat: 35.9, lon: -79.0, tags: { name: 'C', opening_hours: '24/7' } },
        {
          type: 'node',
          id: 4,
          lat: 35.9,
          lon: -79.0,
          tags: { name: 'D', phone: '+1 919 555 0004', opening_hours: 'dawn-dusk' },
        },
        {
          type: 'node',
          id: 5,
          lat: 35.9,
          lon: -79.0,
          tags: { phone: '+1 919 555 0005', opening_hours: '24/7' },
        },
      ],
    });
    expect(venues.map((v) => v.id)).toEqual(['venue_osm_n1']);
    expect(venues[0]).toMatchObject({
      cuisine: 'pizza',
      dietTags: ['vegetarian'],
      accessibilityTags: ['wheelchair', 'step_free'],
      address: '1 Main St',
      priceLevel: 2,
    });
    expect(rejections.map((r) => r.reason).sort()).toEqual([
      'no_hours',
      'no_name',
      'no_phone',
      'unparsable_hours',
    ]);
  });
});
