import { refNameMatches } from '../src/checks/branch';

describe('refNameMatches', () => {
  test('~ALL matches every branch', () => {
    expect(refNameMatches(['~ALL'], [], 'main', 'main')).toBe(true);
    expect(refNameMatches(['~ALL'], [], 'feature/x', 'main')).toBe(true);
  });

  test('~DEFAULT_BRANCH matches only the default branch', () => {
    expect(refNameMatches(['~DEFAULT_BRANCH'], [], 'main', 'main')).toBe(true);
    expect(refNameMatches(['~DEFAULT_BRANCH'], [], 'develop', 'main')).toBe(false);
  });

  test('exact refs/heads/<branch> match', () => {
    expect(refNameMatches(['refs/heads/main'], [], 'main', 'main')).toBe(true);
    expect(refNameMatches(['refs/heads/main'], [], 'develop', 'main')).toBe(false);
  });

  test('glob patterns', () => {
    expect(refNameMatches(['refs/heads/release/*'], [], 'release/v1', 'main')).toBe(true);
    expect(refNameMatches(['refs/heads/release/*'], [], 'main', 'main')).toBe(false);
  });

  test('excludes override includes', () => {
    expect(refNameMatches(['~ALL'], ['refs/heads/legacy'], 'legacy', 'main')).toBe(false);
    expect(refNameMatches(['~ALL'], ['refs/heads/legacy'], 'main', 'main')).toBe(true);
  });

  test('no includes means no match', () => {
    expect(refNameMatches([], [], 'main', 'main')).toBe(false);
  });
});
