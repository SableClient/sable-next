use bytes::BytesMut;
use tokio_util::codec::{Decoder, Encoder, LengthDelimitedCodec};
use wasm_bindgen::prelude::*;

const MAX_SEARCH_FRAME: usize = 6 * 1024 * 1024;

fn search_codec() -> LengthDelimitedCodec {
    LengthDelimitedCodec::builder()
        .max_frame_length(MAX_SEARCH_FRAME)
        .new_codec()
}

#[wasm_bindgen(js_name = SearchPeerDecoder)]
pub struct SearchPeerDecoder {
    codec: LengthDelimitedCodec,
    buffer: BytesMut,
}

#[wasm_bindgen(js_class = SearchPeerDecoder)]
impl SearchPeerDecoder {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self {
            codec: search_codec(),
            buffer: BytesMut::new(),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Option<String>, JsError> {
        if self.buffer.len().saturating_add(chunk.len()) > MAX_SEARCH_FRAME + 4 {
            return Err(JsError::new("search frame too large"));
        }
        self.buffer.extend_from_slice(chunk);
        let Some(frame) = self
            .codec
            .decode(&mut self.buffer)
            .map_err(|error| JsError::new(&error.to_string()))?
        else {
            return Ok(None);
        };
        if !self.buffer.is_empty() {
            return Err(JsError::new("unexpected bytes after search frame"));
        }
        String::from_utf8(frame.to_vec())
            .map(Some)
            .map_err(|error| JsError::new(&error.to_string()))
    }
}

impl Default for SearchPeerDecoder {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen(js_name = encodeSearchPeerFrame)]
pub fn encode_search_peer_frame(message: &str) -> Result<Vec<u8>, JsError> {
    let mut bytes = BytesMut::new();
    search_codec()
        .encode(message.as_bytes(), &mut bytes)
        .map_err(|error| JsError::new(&error.to_string()))?;
    Ok(bytes.to_vec())
}
