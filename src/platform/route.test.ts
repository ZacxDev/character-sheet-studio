import { describe, expect, it } from 'vitest';

import {
  builderRoute,
  characterEditRoute,
  characterRoute,
  normalizeRoutePath,
  parseAppRoute,
  sheetRoute,
  sheetsRoute,
} from './route.js';

describe('parseAppRoute', () => {
  it('maps the app index and section roots to their list pages', () => {
    expect(parseAppRoute('')).toEqual({ name: 'characters' });
    expect(parseAppRoute('characters')).toEqual({ name: 'characters' });
    expect(parseAppRoute('stacks')).toEqual({ name: 'stacks' });
    expect(parseAppRoute('sheets')).toEqual({ name: 'sheets' });
    expect(parseAppRoute('builder')).toEqual({ name: 'builder' });
  });

  it('maps create/edit pages and preserves their ids', () => {
    expect(parseAppRoute('characters/new')).toEqual({ name: 'character-create' });
    expect(parseAppRoute('characters/char-1')).toEqual({
      name: 'character',
      characterId: 'char-1',
    });
    expect(parseAppRoute('characters/char-1/edit')).toEqual({
      name: 'character-edit',
      characterId: 'char-1',
    });
    expect(parseAppRoute('stacks/new')).toEqual({ name: 'stack-create' });
    expect(parseAppRoute('stacks/stack-1/edit')).toEqual({
      name: 'stack-edit',
      stackId: 'stack-1',
    });
  });

  it('keeps a filtered sheets page distinct from a sheet detail page', () => {
    expect(parseAppRoute('sheets/character/char-1')).toEqual({
      name: 'sheets',
      characterId: 'char-1',
    });
    expect(parseAppRoute('sheets/sheet-1')).toEqual({
      name: 'sheet',
      sheetId: 'sheet-1',
    });
  });

  it('carries a preselected character into the Builder page', () => {
    expect(parseAppRoute('builder/char-1')).toEqual({
      name: 'builder',
      characterId: 'char-1',
    });
  });

  it('falls back to Characters for an unknown route', () => {
    expect(parseAppRoute('not-a-page')).toEqual({ name: 'characters' });
    expect(parseAppRoute('characters/char-1/unknown')).toEqual({
      name: 'characters',
    });
  });
});

describe('route builders', () => {
  it('round-trip the ids used by detail pages', () => {
    expect(parseAppRoute(characterRoute('char 1'))).toEqual({
      name: 'character',
      characterId: 'char 1',
    });
    expect(parseAppRoute(characterEditRoute('char 1'))).toEqual({
      name: 'character-edit',
      characterId: 'char 1',
    });
    expect(parseAppRoute(sheetRoute('sheet/1'))).toEqual({
      name: 'sheet',
      sheetId: 'sheet/1',
    });
    expect(parseAppRoute(sheetsRoute('char-1'))).toEqual({
      name: 'sheets',
      characterId: 'char-1',
    });
    expect(parseAppRoute(builderRoute('char-1'))).toEqual({
      name: 'builder',
      characterId: 'char-1',
    });
  });

  it('normalizes leading and trailing slashes away', () => {
    expect(normalizeRoutePath('/characters/new/')).toBe('characters/new');
    expect(normalizeRoutePath('/')).toBe('');
  });
});
