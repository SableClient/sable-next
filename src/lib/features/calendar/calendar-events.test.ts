import { describe, expect, it } from 'vitest';

import {
  agenda,
  buildEvent,
  formatDuration,
  localToEpoch,
  parseDuration,
  readEntry,
  tallyRsvps,
} from './calendar-events.js';

function entry(event: Record<string, unknown>, eventId = '$a') {
  return { event_id: eventId, sender: '@alice:x', timestamp: 1, event };
}

describe('calendar events', () => {
  it('round-trips durations', () => {
    expect(parseDuration('PT2H30M')).toBe(150 * 60_000);
    expect(parseDuration('P1W')).toBe(7 * 24 * 3_600_000);
    expect(formatDuration(150 * 60_000)).toBe('PT2H30M');
    expect(formatDuration(24 * 3_600_000)).toBe('P1D');
    expect(formatDuration(0)).toBe('PT0S');
  });

  it('reads a start in its own time zone', () => {
    expect(localToEpoch('2026-10-01T20:00:00', 'Europe/Paris')).toBe(
      Date.UTC(2026, 9, 1, 18, 0, 0)
    );
    expect(localToEpoch('2026-01-15T09:30:00', 'America/New_York')).toBe(
      Date.UTC(2026, 0, 15, 14, 30, 0)
    );
  });

  it('skips events without a uid or start', () => {
    expect(readEntry(entry({ title: 'x', start: '2026-10-01T20:00:00' }))).toBeNull();
    expect(readEntry(entry({ uid: 'u', start: 'soon' }))).toBeNull();
  });

  it('expands a weekly rule inside the window only', () => {
    const item = readEntry(
      entry({
        uid: 'raid',
        title: 'Raid',
        start: '2026-10-01T20:00:00',
        timeZone: 'UTC',
        duration: 'PT2H',
        recurrenceRules: [{ frequency: 'weekly', count: 3 }],
      })
    );
    expect(item).not.toBeNull();
    const found = agenda(item ? [item] : [], Date.UTC(2026, 9, 5), Date.UTC(2026, 11, 1));
    expect(found.map((occurrence) => new Date(occurrence.start).toISOString())).toEqual([
      '2026-10-08T20:00:00.000Z',
      '2026-10-15T20:00:00.000Z',
    ]);
  });

  it('counts only the latest answer from each sender', () => {
    const rsvp = (sender: string, status: string, timestamp: number) => ({
      sender,
      calendar_event_id: '$a',
      uid: 'raid',
      status,
      timestamp,
    });
    const tally = tallyRsvps(
      [
        rsvp('@me:x', 'accepted', 1),
        rsvp('@me:x', 'declined', 2),
        rsvp('@bob:x', 'tentative', 1),
        rsvp('@eve:x', 'maybe', 3),
      ],
      'raid',
      '@me:x'
    );
    expect(tally).toEqual({ accepted: 0, tentative: 1, declined: 1, mine: 'declined' });
  });

  it('keeps unknown fields of an edited event and drops cleared ones', () => {
    const event = buildEvent(
      {
        title: 'New',
        description: '',
        location: '',
        start: new Date(2026, 9, 1, 20).getTime(),
        end: new Date(2026, 9, 1, 22).getTime(),
        allDay: false,
        frequency: null,
      },
      { uid: 'raid', color: 'red', description: 'old', recurrenceRules: [{}] },
      'raid',
      Date.UTC(2026, 8, 26),
      'Europe/Paris'
    );
    expect(event).toEqual({
      '@type': 'Event',
      uid: 'raid',
      color: 'red',
      updated: '2026-09-26T00:00:00Z',
      title: 'New',
      start: '2026-10-01T20:00:00',
      timeZone: 'Europe/Paris',
      duration: 'PT2H',
      showWithoutTime: false,
    });
  });
});
