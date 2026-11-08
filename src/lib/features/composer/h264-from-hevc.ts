import { isIos } from '#lib/platform/os.js';
import { rawInvoke } from '#lib/platform/raw-invoke.js';

export async function isHevcVideo(file: Blob): Promise<boolean> {
  const { BlobSource, Input, MP4, QTFF } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF] });
  try {
    const track = await input.getPrimaryVideoTrack();
    return (await track?.getCodec()) === 'hevc';
  } catch {
    return false;
  } finally {
    input.dispose();
  }
}

export async function h264FromHevc(file: File): Promise<File> {
  if (!isIos() || !(await isHevcVideo(file))) return file;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const h264 = await rawInvoke<ArrayBuffer>('h264_from_hevc', bytes, {});
    return new File([h264], `${file.name.replace(/\.[^.]*$/, '')}.mp4`, {
      type: 'video/mp4',
      lastModified: file.lastModified,
    });
  } catch (error) {
    console.debug('[sable media] the hevc video could not be re-encoded as h264', error);
    return file;
  }
}
