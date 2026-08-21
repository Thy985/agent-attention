import { EventName, EVENT_PRIORITY } from '../src/events';

describe('EVENT_PRIORITY', () => {
  it('maps permission_required to P0', () => {
    expect(EVENT_PRIORITY['permission_required']).toBe('P0');
  });

  it('maps input_required to P0', () => {
    expect(EVENT_PRIORITY['input_required']).toBe('P0');
  });

  it('maps failed to P1', () => {
    expect(EVENT_PRIORITY['failed']).toBe('P1');
  });

  it('maps completed to P2', () => {
    expect(EVENT_PRIORITY['completed']).toBe('P2');
  });
});
