import { expect, it } from 'vitest';
import {
  isExperienceDate,
  isExperienceDateRangeValid,
  normalizeExperienceDate,
} from '../src/shared/contracts';

it('normalises stated month precision without adding a day', () => {
  for (const month of [
    'Sept 2023',
    'sep 2023',
    'SEPT. 2023',
    'September 2023',
  ]) {
    expect(normalizeExperienceDate(month)).toBe('2023-09');
  }
  expect(normalizeExperienceDate('May 2021')).toBe('2021-05');
  expect(normalizeExperienceDate('2020')).toBe('2020');
  expect(normalizeExperienceDate('2020-02-29')).toBe('2020-02-29');
});

it('rejects ambiguous or impossible dates instead of guessing', () => {
  for (const value of [
    '05/06/2021',
    'May 2021 - Present',
    '2023-13',
    '2023-02-29',
    'Foo 2021',
    '0000',
  ]) {
    expect(normalizeExperienceDate(value)).toBeNull();
    expect(isExperienceDate(value)).toBe(false);
  }
});

it('rejects only date ranges that cannot overlap at the stated precision', () => {
  expect(isExperienceDateRangeValid('2021-05-20', '2021-05')).toBe(true);
  expect(isExperienceDateRangeValid('2021-12-31', '2021')).toBe(true);
  expect(isExperienceDateRangeValid('2022-01', '2021')).toBe(false);
  expect(isExperienceDateRangeValid('2021-06-01', '2021-05')).toBe(false);
});
