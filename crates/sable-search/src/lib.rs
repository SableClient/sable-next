//! The local message search engine: text to terms, terms to ranked keys. No
//! I/O and no SDK, so its tests build without the core.

pub mod inverted;
pub mod phrase;
mod tokenize;
