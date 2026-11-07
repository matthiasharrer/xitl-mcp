import { describe, expect, it } from 'vitest';
import { shortHandle, upstreamSessionText } from './upstreamSession';

describe('upstreamSession', () => {
  it('a 6-character handle whole; anything over 8 cut with an ellipsis', () => {
    expect(shortHandle('Ab3-_z')).toBe('Ab3-_z');
    expect(shortHandle('abcd1234efghijkl')).toBe('abcd1234…');
  });
  it('texts: absent nothing, null new, string handle', () => {
    expect(upstreamSessionText(undefined)).toBeNull();
    expect(upstreamSessionText(null)).toBe('Neue Sitzung');
    expect(upstreamSessionText('Ab3-_z')).toBe('Sitzung Ab3-_z');
    expect(upstreamSessionText('abcd1234efghijkl')).toBe('Sitzung abcd1234…');
  });
});
