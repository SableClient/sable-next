//! HDR screen capture converted to SDR the way OBS does it: content is scaled
//! against the SDR white level, the BT.2408 maxRGB EETF brings the source peak
//! down to that white, and the result is sRGB-encoded 8-bit BGRA.

use half::f16;
use linear_srgb::lut::SrgbConverter;
use zentone::{Bt2408Tonemapper, ToneMap, gamut};

#[cfg(windows)]
pub mod webview2;
#[cfg(windows)]
pub mod windows;

/// OBS's defaults for "SDR white level" and "HDR nominal peak level".
pub const OBS_SDR_WHITE_NITS: f32 = 300.0;
pub const OBS_PEAK_NITS: f32 = 1000.0;

const SCRGB_UNIT_NITS: f32 = 80.0;

pub struct HdrToSdr {
    curve: Bt2408Tonemapper,
    encoder: SrgbConverter,
    peak_nits: f32,
}

impl HdrToSdr {
    #[must_use]
    pub fn new(sdr_white_nits: f32, peak_nits: f32) -> Self {
        let sdr_white_nits = sdr_white_nits.max(1.0);
        let peak_nits = peak_nits.max(sdr_white_nits);
        Self {
            curve: Bt2408Tonemapper::max_rgb(peak_nits, sdr_white_nits),
            encoder: SrgbConverter::new(),
            peak_nits,
        }
    }

    fn encode_row(&self, rgb: &mut [[f32; 3]], scratch: &mut Scratch, out: &mut [u8]) {
        gamut::soft_clip_row_simd(rgb);
        scratch.flat.clear();
        scratch.flat.extend(
            rgb.iter()
                .flat_map(|pixel| pixel.map(|channel| channel.clamp(0.0, 1.0))),
        );
        scratch.encoded.resize(scratch.flat.len(), 0);
        self.encoder
            .batch_linear_to_srgb(&scratch.flat, &mut scratch.encoded);
        let (encoded, _) = scratch.encoded.as_chunks::<3>();
        let (targets, _) = out.as_chunks_mut::<4>();
        for (&[red, green, blue], target) in encoded.iter().zip(targets) {
            *target = [blue, green, red, u8::MAX];
        }
    }

    /// One row of Windows Graphics Capture's `R16G16B16A16Float`: linear
    /// BT.709 where 1.0 is 80 nits. `out` receives BGRA.
    pub fn scrgb_row(&self, source: &[u16], scratch: &mut Scratch, out: &mut [u8]) {
        let unit = SCRGB_UNIT_NITS / self.peak_nits;
        let (pixels, _) = source.as_chunks::<4>();
        let mut rgb = std::mem::take(&mut scratch.rgb);
        rgb.clear();
        rgb.extend(pixels.iter().map(|&[red, green, blue, _]| {
            [red, green, blue].map(|bits| {
                let value = f16::from_bits(bits).to_f32() * unit;
                if value.is_finite() {
                    value.max(0.0)
                } else {
                    0.0
                }
            })
        }));
        self.curve.map_strip_simd(&mut rgb);
        self.encode_row(&mut rgb, scratch, out);
        scratch.rgb = rgb;
    }

    /// The same row as it comes off the capture texture: little-endian bytes.
    pub fn scrgb_bytes_row(&self, source: &[u8], scratch: &mut Scratch, out: &mut [u8]) {
        let (pixels, _) = source.as_chunks::<2>();
        scratch.halves.clear();
        scratch
            .halves
            .extend(pixels.iter().map(|&bytes| u16::from_le_bytes(bytes)));
        let halves = std::mem::take(&mut scratch.halves);
        self.scrgb_row(&halves, scratch, out);
        scratch.halves = halves;
    }

    /// One row of PQ-encoded BT.2020 samples in `[0, 1]`, as a `PipeWire` HDR
    /// screencast delivers them once unpacked. `out` receives BGRA.
    pub fn pq_row(&self, source: &[[f32; 3]], scratch: &mut Scratch, out: &mut [u8]) {
        let scale = 10_000.0 / self.peak_nits;
        let mut rgb = std::mem::take(&mut scratch.rgb);
        rgb.clear();
        rgb.extend(
            source
                .iter()
                .map(|pixel| pixel.map(|code| linear_srgb::tf::pq_to_linear(code) * scale)),
        );
        self.curve.map_strip_simd(&mut rgb);
        gamut::apply_matrix_row_simd(&gamut::BT2020_TO_BT709, &mut rgb);
        self.encode_row(&mut rgb, scratch, out);
        scratch.rgb = rgb;
    }
}

impl HdrToSdr {
    /// Converts a whole frame, splitting its rows across the available cores.
    /// Strides are in source elements and output bytes.
    pub fn frame<T: Sync>(
        &self,
        source: &[T],
        source_stride: usize,
        out: &mut [u8],
        out_stride: usize,
        row: fn(&Self, &[T], &mut Scratch, &mut [u8]),
    ) {
        let rows = out.len() / out_stride.max(1);
        let workers = std::thread::available_parallelism().map_or(1, usize::from);
        let per_worker = rows.div_ceil(workers).max(1);
        std::thread::scope(|scope| {
            for (index, block) in out.chunks_mut(out_stride * per_worker).enumerate() {
                scope.spawn(move || {
                    let mut scratch = Scratch::default();
                    for (offset, line) in block.chunks_mut(out_stride).enumerate() {
                        let start = (index * per_worker + offset) * source_stride;
                        if let Some(pixels) = source.get(start..start + source_stride) {
                            row(self, pixels, &mut scratch, line);
                        }
                    }
                });
            }
        });
    }
}

/// Per-thread buffers reused from one row to the next.
#[derive(Default)]
pub struct Scratch {
    halves: Vec<u16>,
    rgb: Vec<[f32; 3]>,
    flat: Vec<f32>,
    encoded: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use half::f16;

    use super::{HdrToSdr, OBS_PEAK_NITS, OBS_SDR_WHITE_NITS, Scratch};

    fn scrgb(map: &HdrToSdr, nits: [f32; 3]) -> [u8; 4] {
        let source: Vec<u16> = nits
            .iter()
            .map(|&channel| f16::from_f32(channel / 80.0).to_bits())
            .chain([f16::from_f32(1.0).to_bits()])
            .collect();
        let mut out = [0u8; 4];
        map.scrgb_row(&source, &mut Scratch::default(), &mut out);
        out
    }

    fn grey(map: &HdrToSdr, nits: f32) -> u8 {
        scrgb(map, [nits; 3])[0]
    }

    fn obs() -> HdrToSdr {
        HdrToSdr::new(OBS_SDR_WHITE_NITS, OBS_PEAK_NITS)
    }

    #[test]
    fn black_stays_black_and_the_peak_lands_on_white() {
        let map = obs();
        assert_eq!(scrgb(&map, [0.0; 3]), [0, 0, 0, 255]);
        assert_eq!(grey(&map, OBS_PEAK_NITS), 255);
        assert_eq!(grey(&map, 4000.0), 255);
    }

    #[test]
    fn highlights_roll_off_instead_of_clipping() {
        let map = obs();
        let steps: Vec<u8> = [50.0, 150.0, 300.0, 500.0, 700.0]
            .into_iter()
            .map(|nits| grey(&map, nits))
            .collect();
        assert!(
            steps.windows(2).all(|pair| pair[0] < pair[1]),
            "{steps:?} is not rising"
        );
        assert!(
            steps[steps.len() - 1] < 255,
            "{steps:?} clips below the peak"
        );
    }

    #[test]
    fn a_saturated_highlight_keeps_its_hue() {
        let [blue, green, red, _] = scrgb(&obs(), [600.0, 60.0, 30.0]);
        assert!(red > green && green > blue, "{red} {green} {blue}");
    }

    #[test]
    fn a_pq_grey_matches_the_same_level_in_scrgb() {
        let map = obs();
        for nits in [20.0_f32, 150.0, 600.0] {
            let code = linear_srgb::tf::linear_to_pq(nits / 10_000.0);
            let mut out = [0u8; 4];
            map.pq_row(&[[code; 3]], &mut Scratch::default(), &mut out);
            let reference = grey(&map, nits);
            assert!(
                out[..3]
                    .iter()
                    .all(|&channel| channel.abs_diff(reference) <= 2)
                    && out[0].abs_diff(out[1]) <= 1
                    && out[1].abs_diff(out[2]) <= 1,
                "{nits} nits: pq {out:?}, scrgb {reference}"
            );
        }
    }
}

#[cfg(test)]
mod timing {
    use super::{HdrToSdr, OBS_PEAK_NITS, OBS_SDR_WHITE_NITS, Scratch};

    #[test]
    #[ignore = "timing probe, run with --release --ignored --nocapture"]
    fn a_1080p_frame() {
        let map = HdrToSdr::new(OBS_SDR_WHITE_NITS, OBS_PEAK_NITS);
        let width = 1920;
        let source: Vec<u16> = (0..width * 4)
            .map(|index| {
                half::f16::from_f32(f32::from(u16::try_from(index % 97).unwrap_or(0)) / 8.0)
                    .to_bits()
            })
            .collect();
        let frame: Vec<u16> = source
            .iter()
            .copied()
            .cycle()
            .take(width * 4 * 1080)
            .collect();
        let mut out = vec![0u8; width * 4];
        let mut scratch = Scratch::default();
        let start = std::time::Instant::now();
        for _ in 0..1080 {
            map.scrgb_row(&source, &mut scratch, &mut out);
        }
        println!("TIMING 1080p frame, one core: {:?}", start.elapsed());

        let mut whole = vec![0u8; width * 4 * 1080];
        let start = std::time::Instant::now();
        for _ in 0..10 {
            map.frame(
                &frame,
                width * 4,
                &mut whole,
                width * 4,
                HdrToSdr::scrgb_row,
            );
        }
        println!("TIMING 1080p frame, all cores: {:?}", start.elapsed() / 10);
    }
}

#[cfg(test)]
mod bytes {
    use half::f16;

    use super::{HdrToSdr, OBS_PEAK_NITS, OBS_SDR_WHITE_NITS, Scratch};

    #[test]
    fn capture_bytes_convert_like_the_halves_they_hold() {
        let map = HdrToSdr::new(OBS_SDR_WHITE_NITS, OBS_PEAK_NITS);
        let halves: Vec<u16> = [2.0_f32, 5.0, 9.0, 1.0]
            .iter()
            .map(|&value| f16::from_f32(value).to_bits())
            .collect();
        let bytes: Vec<u8> = halves.iter().flat_map(|half| half.to_le_bytes()).collect();
        let (mut from_halves, mut from_bytes) = ([0u8; 4], [0u8; 4]);
        map.scrgb_row(&halves, &mut Scratch::default(), &mut from_halves);
        map.scrgb_bytes_row(&bytes, &mut Scratch::default(), &mut from_bytes);
        assert_eq!(from_halves, from_bytes);
    }
}

#[cfg(test)]
mod frames {
    use half::f16;

    use super::{HdrToSdr, OBS_PEAK_NITS, OBS_SDR_WHITE_NITS, Scratch};

    #[test]
    fn a_frame_split_across_cores_matches_row_by_row() {
        let map = HdrToSdr::new(OBS_SDR_WHITE_NITS, OBS_PEAK_NITS);
        let (width, rows) = (7, 13);
        let source: Vec<u16> = (0..width * rows)
            .flat_map(|index| {
                let value = f16::from_f32(f32::from(u16::try_from(index % 11).unwrap_or(0)) / 4.0)
                    .to_bits();
                [value, value, value, f16::from_f32(1.0).to_bits()]
            })
            .collect();
        let mut frame = vec![0u8; width * rows * 4];
        map.frame(
            &source,
            width * 4,
            &mut frame,
            width * 4,
            HdrToSdr::scrgb_row,
        );

        let mut expected = vec![0u8; width * rows * 4];
        let mut scratch = Scratch::default();
        for (line, target) in source.chunks(width * 4).zip(expected.chunks_mut(width * 4)) {
            map.scrgb_row(line, &mut scratch, target);
        }
        assert_eq!(frame, expected);
    }
}
