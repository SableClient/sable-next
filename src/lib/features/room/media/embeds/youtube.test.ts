import { describe, expect, it } from 'vitest';

import { parseYoutubeLink, youtubePlayerUrl, type YoutubeVideo } from './youtube';

describe('parseYoutubeLink', () => {
  it.each([
    'https://www.youtube.com/watch?v=MTn_bhTVr2U',
    'https://youtube.com/watch?v=MTn_bhTVr2U&list=RDjcB4zu4KX10&index=3',
    'https://m.youtube.com/watch?v=MTn_bhTVr2U',
    'https://youtu.be/MTn_bhTVr2U?si=abc',
    'https://youtube.com/shorts/MTn_bhTVr2U?si=abc',
  ])('reads the video id from %s', (href) => {
    expect(parseYoutubeLink(href)?.id).toBe('MTn_bhTVr2U');
  });

  it.each([
    'https://www.youtube.com/',
    'https://www.youtube.com/@channel',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://youtu.be/MTn_bhTVr2U/extra',
    'https://evil.example/watch?v=MTn_bhTVr2U',
    'https://notyoutube.com/watch?v=MTn_bhTVr2U',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (href) => {
    expect(parseYoutubeLink(href)).toBeNull();
  });

  it.each([
    ['90', 90],
    ['90s', 90],
    ['1m30s', 90],
    ['1h2m3s', 3723],
    ['junk', null],
    ['0', null],
  ])('reads the start time %s', (t, start) => {
    expect(parseYoutubeLink(`https://youtu.be/MTn_bhTVr2U?t=${t}`)?.start).toBe(start);
  });
});

describe('youtubePlayerUrl', () => {
  const video: YoutubeVideo = {
    id: 'MTn_bhTVr2U',
    start: 90,
  };

  it('plays from the nocookie host at the start time', () => {
    expect(youtubePlayerUrl(video)).toBe(
      'https://www.youtube-nocookie.com/embed/MTn_bhTVr2U?autoplay=1&start=90'
    );
  });
});
