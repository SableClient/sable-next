import { expect, test } from 'vitest';
import { TimelineArrivals } from './timeline-arrivals';

const item = (id: string, own = false) => ({ id, event_id: `$${id}`, is_own: own });

test('only remote additions after the known tail are arrivals', () => {
  const arrivals = new TimelineArrivals();
  expect(arrivals.update([item('a'), item('b')])).toEqual([]);
  expect(arrivals.update([item('history'), item('a'), item('b')])).toEqual([]);
  expect(arrivals.update([item('history'), item('a'), item('b'), item('c')])).toEqual([item('c')]);
  expect(arrivals.update([item('a'), item('b'), item('c'), item('own', true)])).toEqual([]);
});

test('replacement snapshots, virtualization and subscription resets are silent', () => {
  const arrivals = new TimelineArrivals();
  arrivals.update([item('a')]);
  expect(arrivals.update([item('b')])).toEqual([]);
  expect(arrivals.update([item('b')])).toEqual([]);
  arrivals.reset();
  expect(arrivals.update([item('b'), item('c')])).toEqual([]);
});

test('an arrival into an already opened empty timeline is announced', () => {
  const arrivals = new TimelineArrivals();
  expect(arrivals.update([])).toEqual([]);
  expect(arrivals.update([item('a')])).toEqual([item('a')]);
});
