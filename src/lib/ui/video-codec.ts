async function hevcCodec(file: Blob): Promise<string | null> {
  const { BlobSource, Input, MP4, QTFF } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF] });
  try {
    const track = await input.getPrimaryVideoTrack();
    if ((await track?.getCodec()) !== 'hevc') return null;
    return (await track?.getCodecParameterString()) ?? 'hvc1';
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

export async function isHevcVideo(file: Blob): Promise<boolean> {
  return (await hevcCodec(file)) !== null;
}

export async function playsVideo(url: string): Promise<boolean> {
  try {
    const codec = await hevcCodec(await (await fetch(url)).blob());
    if (codec === null) return true;
    return document.createElement('video').canPlayType(`video/mp4; codecs="${codec}"`) !== '';
  } catch {
    return true;
  }
}
