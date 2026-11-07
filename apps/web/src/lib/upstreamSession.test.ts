import { describe, expect, it } from 'vitest';
import { shortHandle, upstreamSessionText } from './upstreamSession';

describe('upstreamSession', () => {
  it('shortens to 8 characters plus an ellipsis', () => {
    expect(shortHandle('abcd1234efghijkl')).toBe('abcd1234…');
  });
  it('texts: absent nothing, null new, string handle', () => {
    expect(upstreamSessionText(undefined)).toBeNull();
    expect(upstreamSessionText(null)).toBe('Neue Sitzung');
    expect(upstreamSessionText('abcd1234efghijkl')).toBe('Sitzung abcd1234…');
  });
});
