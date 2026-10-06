pub const SAMPLE_RATE: usize = 48_000;
pub const CHANNELS: usize = 2;
pub const BYTES_PER_FRAME: usize = CHANNELS * size_of::<f32>();
pub const CHUNK_FRAMES: usize = SAMPLE_RATE / 100;
pub const CHUNK_BYTES: usize = CHUNK_FRAMES * BYTES_PER_FRAME;

#[derive(Default)]
pub struct Chunker {
    pending: Vec<u8>,
}

impl Chunker {
    pub fn push(&mut self, data: &[u8], mut emit: impl FnMut(&[u8])) {
        self.pending.extend_from_slice(data);
        let (chunks, rest) = self.pending.as_chunks::<CHUNK_BYTES>();
        for chunk in chunks {
            emit(chunk);
        }
        let rest = rest.to_vec();
        self.pending = rest;
    }
}

#[cfg(test)]
mod tests {
    use super::{CHUNK_BYTES, Chunker};

    fn collect(chunker: &mut Chunker, data: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        chunker.push(data, |chunk| out.push(chunk.to_vec()));
        out
    }

    #[test]
    fn a_short_packet_waits_for_the_rest_of_its_chunk() {
        let mut chunker = Chunker::default();
        assert!(collect(&mut chunker, &vec![1; CHUNK_BYTES - 8]).is_empty());
        let chunks = collect(&mut chunker, &[2; 8]);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), CHUNK_BYTES);
        assert_eq!(chunks[0][CHUNK_BYTES - 1], 2);
    }

    #[test]
    fn a_long_packet_yields_every_whole_chunk_and_keeps_the_remainder() {
        let mut chunker = Chunker::default();
        let chunks = collect(&mut chunker, &vec![1; CHUNK_BYTES * 2 + 16]);
        assert_eq!(chunks.len(), 2);
        let chunks = collect(&mut chunker, &vec![1; CHUNK_BYTES - 16]);
        assert_eq!(chunks.len(), 1);
    }
}
