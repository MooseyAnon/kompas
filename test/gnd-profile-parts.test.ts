import { describe, expect, it } from 'vitest';
import {
  knownSkill,
  SKILLS,
  suggestSkills,
} from '../src/renderer/presentation/gnd/pages/applications/skillCatalogue';
import {
  mascotOf,
  randomMascot,
} from '../src/renderer/presentation/gnd/components/Avatar';
import { avatarSchema } from '../src/shared/contracts';

describe('skill search', () => {
  it('suggests skills as you type, starts-with first, skipping ones you have', () => {
    expect(suggestSkills('fig', [])).toEqual(['Figma', 'FigJam']);
    expect(suggestSkills('fig', ['Figma'])).toEqual(['FigJam']);
    expect(suggestSkills('research', [])[0]).toBe('Research');
    expect(suggestSkills('research', [])).toContain('User research');
    expect(suggestSkills('', [])).toEqual([]);
    expect(knownSkill('typescript')).toBe('TypeScript');
    expect(new Set(SKILLS).size).toBe(SKILLS.length);
  });
});

describe('profile pictures', () => {
  it('gives out one of the eight sprouts, which the contract accepts', () => {
    expect(randomMascot(() => 0)).toBe('mascot:sprout');
    expect(randomMascot(() => 0.99)).toBe('mascot:blob');
    expect(mascotOf('mascot:peek')).toBe('peek');
    expect(mascotOf('mascot:dragon')).toBeNull();
    expect(avatarSchema.safeParse(randomMascot()).success).toBe(true);
    expect(avatarSchema.safeParse('mascot:dragon').success).toBe(false);
  });
});
