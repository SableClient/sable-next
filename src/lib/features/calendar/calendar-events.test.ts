import { describe, expect, it } from 'vitest';

import {
  agenda,
  buildEvent,
  formatDuration,
  localToEpoch,
  monthGrid,
  occursOn,
  parseDuration,
  readEntry,
  tallyRsvps,
  type Occurrence,
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
      recurrence_id: null,
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
      null,
      '@me:x'
    );
    expect(tally).toEqual({
      accepted: 0,
      tentative: 1,
      declined: 1,
      mine: 'declined',
      people: { accepted: [], tentative: ['@bob:x'], declined: ['@me:x'] },
    });
  });

  it('counts an answer to one occurrence only for that occurrence', () => {
    const rsvp = (status: string, recurrenceId: string | null, timestamp: number) => ({
      sender: '@me:x',
      calendar_event_id: '$a',
      uid: 'raid',
      recurrence_id: recurrenceId,
      status,
      timestamp,
    });
    const rsvps = [rsvp('accepted', null, 1), rsvp('tentative', '2026-10-08T20:00:00', 2)];

    expect(tallyRsvps(rsvps, 'raid', '2026-10-01T20:00:00', '@me:x').mine).toBe('accepted');
    expect(tallyRsvps(rsvps, 'raid', '2026-10-08T20:00:00', '@me:x').mine).toBe('tentative');
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
        until: null,
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

  const draft = {
    title: 'Raid',
    description: '',
    location: '',
    start: new Date(2026, 9, 1, 20).getTime(),
    end: new Date(2026, 9, 1, 22).getTime(),
    allDay: false,
    frequency: 'weekly' as const,
    until: null,
  };

  it('stops a weekly series at the date it repeats until', () => {
    const event = buildEvent(
      { ...draft, until: '2026-12-01' },
      null,
      'raid',
      Date.UTC(2026, 8, 26),
      'UTC'
    );
    expect(event.recurrenceRules).toEqual([
      { '@type': 'RecurrenceRule', frequency: 'weekly', until: '2026-12-01T23:59:59' },
    ]);
    const item = readEntry(entry(event));
    const found = agenda(item ? [item] : [], Date.UTC(2026, 8, 1), Date.UTC(2027, 8, 1));
    expect(found).toHaveLength(9);
    expect(new Date(found.at(-1)?.start ?? 0).toISOString()).toBe('2026-11-26T20:00:00.000Z');
  });

  it('keeps the rest of an edited rule and trades a count for an until', () => {
    const base = {
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', interval: 2, count: 5 }],
    };
    const kept = buildEvent(draft, base, 'raid', 0, 'UTC');
    expect(kept.recurrenceRules).toEqual([
      { '@type': 'RecurrenceRule', frequency: 'weekly', interval: 2, count: 5 },
    ]);
    const bounded = buildEvent({ ...draft, until: '2026-12-01' }, base, 'raid', 0, 'UTC');
    expect(bounded.recurrenceRules).toEqual([
      { '@type': 'RecurrenceRule', frequency: 'weekly', interval: 2, until: '2026-12-01T23:59:59' },
    ]);
    const changed = buildEvent({ ...draft, frequency: 'daily' }, base, 'raid', 0, 'UTC');
    expect(changed.recurrenceRules).toEqual([{ '@type': 'RecurrenceRule', frequency: 'daily' }]);
  });

  it('skips months that have no such day instead of rolling over', () => {
    const item = readEntry(
      entry({
        uid: 'rent',
        start: '2027-01-31T09:00:00',
        timeZone: 'UTC',
        duration: 'PT1H',
        recurrenceRules: [{ frequency: 'monthly', count: 3 }],
      })
    );
    const found = agenda(item ? [item] : [], Date.UTC(2027, 0, 1), Date.UTC(2028, 0, 1));
    expect(found.map((occurrence) => new Date(occurrence.start).toISOString())).toEqual([
      '2027-01-31T09:00:00.000Z',
      '2027-03-31T09:00:00.000Z',
      '2027-05-31T09:00:00.000Z',
    ]);
  });

  it('skips an event whose start date does not exist', () => {
    const item = readEntry(
      entry({
        uid: 'bad',
        start: '2027-02-30T09:00:00',
        timeZone: 'UTC',
        recurrenceRules: [{ frequency: 'monthly' }],
      })
    );
    expect(agenda(item ? [item] : [], 0, Date.UTC(2028, 0, 1))).toEqual([]);
  });

  it('stores an all-day event as floating whole days', () => {
    const event = buildEvent(
      {
        ...draft,
        frequency: null,
        allDay: true,
        start: new Date(2026, 9, 1).getTime(),
        end: new Date(2026, 9, 3).getTime(),
      },
      { timeZone: 'Europe/Paris' },
      'trip',
      0,
      'Europe/Paris'
    );
    expect(event).toMatchObject({
      start: '2026-10-01T00:00:00',
      timeZone: null,
      duration: 'P2D',
      showWithoutTime: true,
    });
  });

  function dates(rule: Record<string, unknown>, start: string, count = 4): string[] {
    const item = readEntry(
      entry({
        uid: 'r',
        start,
        timeZone: 'UTC',
        duration: 'PT1H',
        recurrenceRules: [{ count, ...rule }],
      })
    );
    return agenda(item ? [item] : [], Date.UTC(2026, 0, 1), Date.UTC(2028, 0, 1)).map(
      (occurrence) => new Date(occurrence.start).toISOString().slice(0, 10)
    );
  }

  const day = (name: string, nthOfPeriod?: number) => ({ '@type': 'NDay', day: name, nthOfPeriod });

  it('repeats on the listed weekdays, as Commet writes a weekly rule', () => {
    expect(
      dates(
        { frequency: 'weekly', byDay: [day('mo'), day('we'), day('fr')] },
        '2026-10-05T18:00:00',
        5
      )
    ).toEqual(['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14']);
  });

  it('keeps the start as the first occurrence even off the listed weekdays', () => {
    expect(dates({ frequency: 'weekly', byDay: [day('mo')] }, '2026-10-07T18:00:00', 3)).toEqual([
      '2026-10-07',
      '2026-10-12',
      '2026-10-19',
    ]);
  });

  it('skips whole weeks for an interval', () => {
    expect(
      dates(
        { frequency: 'weekly', interval: 2, byDay: [day('tu'), day('th')] },
        '2026-10-06T18:00:00'
      )
    ).toEqual(['2026-10-06', '2026-10-08', '2026-10-20', '2026-10-22']);
  });

  it('finds the nth and the last weekday of each month', () => {
    expect(
      dates({ frequency: 'monthly', byDay: [day('tu', 2)] }, '2026-10-13T18:00:00', 3)
    ).toEqual(['2026-10-13', '2026-11-10', '2026-12-08']);
    expect(
      dates({ frequency: 'monthly', byDay: [day('fr', -1)] }, '2026-10-30T18:00:00', 3)
    ).toEqual(['2026-10-30', '2026-11-27', '2026-12-25']);
  });

  it('counts month days back from the end', () => {
    expect(dates({ frequency: 'monthly', byMonthDay: [-1] }, '2026-10-31T09:00:00', 5)).toEqual([
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
      '2027-02-28',
    ]);
  });

  it('shows only the start for a rule part it cannot expand, rather than guess', () => {
    expect(
      dates({ frequency: 'yearly', byMonth: ['3'], byDay: [day('su', -1)] }, '2026-03-29T09:00:00')
    ).toEqual(['2026-03-29']);
  });
});

describe('month grid', () => {
  it('pads to whole weeks starting on the given weekday', () => {
    const grid = monthGrid(new Date(2026, 9, 1).getTime(), 1);
    expect(grid).toHaveLength(35);
    expect(new Date(grid[0] ?? 0).getDay()).toBe(1);
    expect(new Date(grid[0] ?? 0).getDate()).toBe(28);
    expect(new Date(grid.at(-1) ?? 0).getDate()).toBe(1);
  });

  it('an event covers each day it spans', () => {
    const start = new Date(2026, 9, 3, 22).getTime();
    const occurrence = { start, end: start + 4 * 3_600_000 } as Occurrence;
    expect(occursOn(occurrence, new Date(2026, 9, 3).getTime())).toBe(true);
    expect(occursOn(occurrence, new Date(2026, 9, 4).getTime())).toBe(true);
    expect(occursOn(occurrence, new Date(2026, 9, 5).getTime())).toBe(false);
  });
});
