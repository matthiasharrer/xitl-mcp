import { describe, expect, it, vi } from 'vitest';
import { AuditEvents } from './auditEvents';

describe('AuditEvents (TC-134)', () => {
  it('delivers every change to every listener', () => {
    const bus = new AuditEvents();
    const a = vi.fn();
    const b = vi.fn();
    bus.on(a);
    bus.on(b);
    bus.emit({ userId: 1, auditId: 7 });
    expect(a).toHaveBeenCalledWith({ userId: 1, auditId: 7 });
    expect(b).toHaveBeenCalledTimes(1);
  });
  it('stops after unsubscribe', () => {
    const bus = new AuditEvents();
    const a = vi.fn();
    bus.on(a)();
    bus.emit({ userId: 1, auditId: 7 });
    expect(a).not.toHaveBeenCalled();
  });
  it('a throwing listener neither throws into the caller nor starves the others', () => {
    const bus = new AuditEvents();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = vi.fn();
    bus.on(() => {
      throw new Error('secret detail');
    });
    bus.on(ok);
    expect(() => bus.emit({ userId: 1, auditId: 1 })).not.toThrow();
    expect(ok).toHaveBeenCalled();
    expect(warn.mock.calls.join(' ')).not.toContain('secret detail');
    warn.mockRestore();
  });
});
