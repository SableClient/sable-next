import { isIos } from '#lib/platform/os.js';
import { rawInvoke } from '#lib/platform/raw-invoke.js';
import { isHevcVideo } from '#lib/ui/video-codec.js';

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
